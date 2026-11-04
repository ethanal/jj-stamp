import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  parseReviewComments,
  REVIEW_COMMENT_ID,
  type ReviewCommentMutation,
} from "../src/review-comments.ts";
import { ApiError } from "./errors.ts";

const body = z
  .string()
  .max(16000)
  .refine(
    (text) =>
      text.trim().length > 0 &&
      !/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/.test(text),
    "Use nonempty plain text with LF-separated body lines.",
  );
const common = {
  version: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1).max(4096),
};
const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(REVIEW_COMMENT_ID);
export const commentMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("add"),
      line,
      endLine: line.optional(),
      body,
    })
    .strict(),
  z.object({ ...common, action: z.literal("edit"), id, body }).strict(),
  z.object({ ...common, action: z.literal("remove"), id }).strict(),
]);

export function validateCommentMutation(
  input: unknown,
): asserts input is ReviewCommentMutation {
  if (!commentMutationSchema.safeParse(input).success)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Supply a valid comment action, current version, exact path, UUID/line and nonempty plain-text body.",
    );
}

function unavailable(message: string): never {
  throw new ApiError(422, "COMMENTS_UNAVAILABLE", message);
}

/** No newline normalization, lossy decoding or automatic marker repair. */
export function mutateReviewComments(
  file: string,
  bytes: Buffer,
  input: ReviewCommentMutation,
): Buffer {
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text, "utf8").equals(bytes) ||
    text.includes("\0") ||
    text.startsWith("\ufeff") ||
    !text.endsWith("\n")
  )
    unavailable(
      "Review comments require lossless UTF-8 source without BOM/NUL and with a final newline.",
    );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (
    text.replaceAll("\r\n", "").includes("\r") ||
    (newline === "\r\n" && text.replaceAll("\r\n", "").includes("\n"))
  )
    unavailable("Mixed or unsupported newlines cannot be edited safely.");
  const parsed = parseReviewComments(file, text);
  if (!parsed.editable)
    unavailable(parsed.reason ?? "Unsafe review annotations.");
  const lines = text.slice(0, -newline.length).split(newline);
  const markerLines = new Set(
    parsed.comments.flatMap((comment) => comment.markerLines),
  );
  let expectedId: string | undefined;
  let expectedBody: string | undefined;
  if (input.action === "add") {
    const end = input.endLine ?? input.line;
    if (input.line > lines.length || end > lines.length || end < input.line)
      throw new ApiError(
        400,
        "INVALID_LINE",
        "Choose an ordered source line range inside the pinned file.",
      );
    if (
      parsed.comments.some(
        (comment) =>
          input.line <= (comment.endMarkerLine ?? comment.endAnchorLine) &&
          end >= comment.startLine,
      )
    )
      unavailable("Overlapping review annotations are not supported.");
    expectedId = randomUUID();
    expectedBody = input.body;
    const prefix = /^[ \t]*/.exec(lines[input.line - 1])![0];
    const start = input.body
      .split("\n")
      .map((part) => `${prefix}// JJ-STAMP(${expectedId}): ${part}`);
    if (end > input.line)
      lines.splice(end, 0, `${prefix}// JJ-STAMP(${expectedId})`);
    lines.splice(input.line - 1, 0, ...start);
  } else {
    const comment = parsed.comments.find((comment) => comment.id === input.id);
    if (!comment)
      throw new ApiError(
        400,
        "INVALID_COMMENT",
        "The UUID is not a unique valid review comment in the pinned file.",
      );
    if (input.action === "remove") {
      const remove = new Set(comment.markerLines);
      for (let i = lines.length - 1; i >= 0; i--)
        if (remove.has(i + 1)) lines.splice(i, 1);
    } else {
      expectedId = comment.id;
      expectedBody = input.body;
      const prefix = /^[ \t]*/.exec(lines[comment.startLine - 1])![0];
      const startLines = comment.markerLines.filter(
        (n) => n !== comment.endMarkerLine,
      );
      lines.splice(
        comment.startLine - 1,
        startLines.length,
        ...input.body
          .split("\n")
          .map((part) => `${prefix}// JJ-STAMP(${comment.id}): ${part}`),
      );
    }
  }
  // In particular, a target inside a block comment cannot create an invisible
  // annotation; newly inserted text must round-trip as exactly one real card.
  const result = lines.join(newline) + (lines.length ? newline : "");
  const verified = parseReviewComments(file, result);
  if (
    !verified.editable ||
    (expectedId &&
      !verified.comments.some(
        (comment) => comment.id === expectedId && comment.body === expectedBody,
      )) ||
    (input.action === "add" && markerLines.has(input.line))
  )
    unavailable(
      "The annotation would not round-trip safely at these source lines.",
    );
  return Buffer.from(result, "utf8");
}

interface Identity {
  absolute: string;
  stat: BigIntStats;
}
export interface CapturedReviewFile {
  root: string;
  relative: string;
  absolute: string;
  bytes: Buffer;
  stat: BigIntStats;
  directories: Identity[];
}

const sameIdentity = (a: BigIntStats, b: BigIntStats) =>
  a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: BigIntStats, b: BigIntStats) =>
  sameIdentity(a, b) &&
  a.size === b.size &&
  a.mtimeNs === b.mtimeNs &&
  a.ctimeNs === b.ctimeNs &&
  a.mode === b.mode &&
  b.nlink === 1n;

export function reviewFileUnchanged(
  before: CapturedReviewFile,
  after: CapturedReviewFile,
): boolean {
  return (
    sameFile(before.stat, after.stat) &&
    before.bytes.equals(after.bytes) &&
    before.directories.length === after.directories.length &&
    before.directories.every(
      (directory, index) =>
        directory.absolute === after.directories[index].absolute &&
        sameIdentity(directory.stat, after.directories[index].stat),
    )
  );
}

/** Every component is literal, regular and nonlinked; open also uses NOFOLLOW. */
export async function captureReviewFile(
  root: string,
  relative: string,
): Promise<CapturedReviewFile> {
  if (
    !relative ||
    relative.includes("\\") ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    relative
      .split("/")
      .some((part) => !part || [".", "..", ".jj", ".git"].includes(part))
  )
    throw new ApiError(
      400,
      "INVALID_PATH",
      "Review comments require an exact root-relative source path.",
    );
  const absolute = path.join(root, relative);
  try {
    if ((await realpath(root)) !== root)
      unavailable(
        "The workspace root changed; restart before editing comments.",
      );
    const directories: Identity[] = [];
    let current = root;
    for (const part of ["", ...relative.split("/").slice(0, -1)]) {
      if (part) current = path.join(current, part);
      const stat = await lstat(current, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        unavailable(
          "Symlinked or nonregular source paths cannot contain editable review comments.",
        );
      directories.push({ absolute: current, stat });
    }
    const entry = await lstat(absolute, { bigint: true });
    if (
      !entry.isFile() ||
      entry.isSymbolicLink() ||
      entry.nlink !== 1n ||
      entry.size > 4n * 1024n * 1024n
    )
      unavailable(
        "Review comments require a regular, non-hardlinked source file of at most 4 MiB.",
      );
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat({ bigint: true });
      if (!sameFile(entry, stat))
        unavailable("The source file changed while opening it.");
      const bytes = await handle.readFile();
      if (bytes.length > 4 * 1024 * 1024)
        unavailable("The source grew beyond the 4 MiB review comment limit.");
      const after = await handle.stat({ bigint: true });
      if (
        !sameFile(stat, after) ||
        !sameFile(after, await lstat(absolute, { bigint: true }))
      )
        throw new ApiError(
          409,
          "STALE_STATE",
          "The source file changed during exact byte capture.",
        );
      await validateDirectories(directories);
      return { root, relative, absolute, bytes, stat: after, directories };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    unavailable(
      "The source file is missing, inaccessible, symlinked or changed while being read.",
    );
  }
}

async function validateDirectories(directories: Identity[]) {
  for (const directory of directories) {
    const stat = await lstat(directory.absolute, { bigint: true });
    if (!stat.isDirectory() || !sameIdentity(stat, directory.stat))
      throw new ApiError(
        409,
        "STALE_STATE",
        "A source directory changed during comment editing.",
      );
  }
}

/** Atomic replacement, not a cross-process filesystem transaction. Never retry. */
export async function replaceReviewFile(
  before: CapturedReviewFile,
  result: Buffer,
): Promise<CapturedReviewFile> {
  const temporary = path.join(
    path.dirname(before.absolute),
    `.jj-stamp-${randomUUID()}.tmp`,
  );
  let attemptedRename = false;
  let created = false;
  try {
    await validateDirectories(before.directories);
    const handle = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    let replacementStat: BigIntStats;
    try {
      await handle.writeFile(result);
      await handle.chmod(Number(before.stat.mode & 0o7777n));
      await handle.sync();
      replacementStat = await handle.stat({ bigint: true });
    } finally {
      await handle.close();
    }
    const current = await captureReviewFile(before.root, before.relative);
    if (!reviewFileUnchanged(before, current))
      throw new ApiError(
        409,
        "STALE_STATE",
        "The source file changed before replacement; no review annotation was written.",
      );
    await validateDirectories(before.directories);
    attemptedRename = true;
    await rename(temporary, before.absolute);
    created = false;
    const after = await captureReviewFile(before.root, before.relative);
    await validateDirectories(before.directories);
    // Rename may change ctime, but must retain the exact newly written inode,
    // bytes, mode and mtime. Later refresh checks include ctime as well.
    if (
      !after.bytes.equals(result) ||
      !sameIdentity(replacementStat, after.stat) ||
      replacementStat.mode !== after.stat.mode ||
      replacementStat.mtimeNs !== after.stat.mtimeNs
    )
      throw new Error("File changed after replacement.");
    return after;
  } catch (error) {
    if (attemptedRename)
      throw new ApiError(
        500,
        "PARTIAL_FAILURE",
        "The review comment file may already be changed. Inspect the file and refresh before another explicit action; no retry or rollback was attempted.",
        { fileMayHaveChanged: true },
      );
    throw error;
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}
