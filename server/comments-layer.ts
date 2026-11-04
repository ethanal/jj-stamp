import { createHash } from "node:crypto";
import { parseFile } from "./diff.ts";
import { ApiError } from "./errors.ts";
import { jj, ProcessOutputLimitError } from "./process.ts";
import {
  parseReviewComments,
  type ProjectedReviewComment,
  type ReviewComment,
} from "../src/review-comments.ts";

export interface CommentsLayerConfig {
  sourceChangeId: string;
  reviewedChangeId: string;
  branches: Array<{ codeChangeId: string; commentsChangeId: string }>;
}
export interface LayerRevision {
  changeId: string;
  commitId: string;
  parents: string[];
}
export interface CommentsLayerFile {
  path: string;
  clean: Buffer;
  annotated: Buffer;
  comments: ReviewComment[];
  cleanComments: ProjectedReviewComment[];
}
export interface ValidatedCommentsBranch {
  code: LayerRevision;
  comments: LayerRevision;
  files: Map<string, CommentsLayerFile>;
}
export interface ValidatedCommentsLayer {
  source: LayerRevision;
  reviewed: LayerRevision;
  branches: ValidatedCommentsBranch[];
  fingerprint: string;
}

export function invalidCommentsLayer(message: string): never {
  throw new ApiError(409, "COMMENTS_LAYER_INVALID", message);
}

/** Lossless stripping of recognized marker lines only; never repair or guess. */
export function projectCommentsFile(
  path: string,
  bytes: Buffer,
): CommentsLayerFile {
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text).equals(bytes) ||
    text.includes("\0") ||
    text.startsWith("\ufeff") ||
    !text.endsWith("\n")
  )
    invalidCommentsLayer(
      "Comment branches require lossless newline-terminated UTF-8 source.",
    );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (
    text.replaceAll("\r\n", "").includes("\r") ||
    (newline === "\r\n" && text.replaceAll("\r\n", "").includes("\n"))
  )
    invalidCommentsLayer("Mixed source newlines cannot be projected safely.");
  const parsed = parseReviewComments(path, text);
  if (!parsed.editable)
    invalidCommentsLayer(
      parsed.reason ?? "Malformed comment branch annotations.",
    );
  const removed = new Set(
    parsed.comments.flatMap((comment) => comment.markerLines),
  );
  const lines = text.slice(0, -newline.length).split(newline);
  if (lines.length > 100000)
    throw new ApiError(
      413,
      "CONTENT_TOO_LARGE",
      "Comment projection supports at most 100000 physical lines.",
    );
  const cleanLines = lines.filter((_, index) => !removed.has(index + 1));
  const physicalToCode: number[] = [];
  let cleanLine = 0;
  for (let physical = 1; physical <= lines.length; physical++) {
    if (!removed.has(physical)) cleanLine++;
    physicalToCode[physical] = cleanLine;
  }
  const toCode = (line: number) => physicalToCode[line];
  return {
    path,
    annotated: bytes,
    clean: Buffer.from(
      cleanLines.join(newline) + (cleanLines.length ? newline : ""),
    ),
    comments: parsed.comments,
    cleanComments: parsed.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      startLine: toCode(comment.anchorLine),
      endLine: toCode(comment.endAnchorLine),
    })),
  };
}

/**
 * Recorded, bounded validation, reusable by PR resume and live service reads.
 * The caller snapshots/revalidates operation identity; this never moves @ or
 * mutates history. Actual annotation bodies live only in jj file trees.
 */
export async function validateCommentsLayer(
  repoPath: string,
  config: CommentsLayerConfig,
  runner: typeof jj = jj,
): Promise<ValidatedCommentsLayer> {
  const codeIds = [config.sourceChangeId, config.reviewedChangeId];
  const ids = [
    ...codeIds,
    ...config.branches.map((branch) => branch.commentsChangeId),
  ];
  if (
    config.branches.length !== 2 ||
    ids.some((id) => !/^[k-z]{32}$/.test(id)) ||
    new Set(ids).size !== 4 ||
    new Set(config.branches.map((branch) => branch.codeChangeId)).size !== 2 ||
    config.branches.some((branch) => !codeIds.includes(branch.codeChangeId))
  )
    invalidCommentsLayer(
      "Managed comments require two distinct side branches, one for each clean code revision.",
    );
  try {
    const raw = await runner(
      repoPath,
      [
        "log",
        "--no-graph",
        "--ignore-working-copy",
        "--config",
        "ui.log-word-wrap=false",
        "-r",
        [...ids.map((id) => `change_id("${id}")`), "@"].join(" | "),
        "-T",
        'json(change_id) ++ "\\t" ++ json(commit_id) ++ "\\t" ++ json(parents.map(|p| p.change_id()))' +
          ' ++ "\\t" ++ json(current_working_copy) ++ "\\t" ++ json(!hidden && !divergent)' +
          ' ++ "\\t" ++ json(self.contained_in("mutable()")) ++ "\\t" ++ json(self.contained_in("conflicts()"))' +
          ' ++ "\\t" ++ json(self.contained_in("heads(all())")) ++ "\\n"',
      ],
      { maxOutputBytes: 64 * 1024 },
    );
    const rows = raw.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const values: unknown[] = line
          .split("\t")
          .map((part) => JSON.parse(part));
        const [
          changeId,
          commitId,
          parents,
          workingCopy,
          available,
          mutable,
          conflict,
          head,
        ] = values;
        if (
          values.length !== 8 ||
          typeof changeId !== "string" ||
          !/^[k-z]{32}$/.test(changeId) ||
          typeof commitId !== "string" ||
          !/^[0-9a-f]{40,64}$/.test(commitId) ||
          !Array.isArray(parents) ||
          parents.some(
            (id) => typeof id !== "string" || !/^[k-z]{32}$/.test(id),
          ) ||
          [workingCopy, available, mutable, conflict, head].some(
            (flag) => typeof flag !== "boolean",
          )
        )
          invalidCommentsLayer("Unrecognized comment-branch metadata.");
        return {
          changeId,
          commitId,
          parents: parents as string[],
          workingCopy,
          available,
          mutable,
          conflict,
          head,
        };
      });
    const get = (id: string) => {
      const matching = rows.filter((row) => row.changeId === id);
      if (
        matching.length !== 1 ||
        !matching[0].available ||
        !matching[0].mutable ||
        matching[0].conflict
      )
        invalidCommentsLayer(
          "Managed code/comment revisions must remain visible, nondivergent, mutable and conflict-free.",
        );
      return matching[0];
    };
    const source = get(config.sourceChangeId);
    const reviewed = get(config.reviewedChangeId);
    if (
      !source.workingCopy ||
      rows.filter((row) => row.workingCopy).length !== 1 ||
      source.parents.length !== 1 ||
      source.parents[0] !== reviewed.changeId
    )
      invalidCommentsLayer(
        "The working copy must remain the clean Remaining revision directly above Reviewed.",
      );
    const allIds = new Set<string>();
    let total = 0;
    let count = 0;
    const branches: ValidatedCommentsBranch[] = [];
    for (const entry of config.branches) {
      const code = get(entry.codeChangeId);
      const comments = get(entry.commentsChangeId);
      if (
        comments.workingCopy ||
        !comments.head ||
        comments.parents.length !== 1 ||
        comments.parents[0] !== code.changeId
      )
        invalidCommentsLayer(
          "Each COMMENTS revision must remain an independent leaf directly above its own clean code revision.",
        );
      const diff = (
        await runner(
          repoPath,
          [
            "diff",
            "--git",
            "-r",
            `commit_id("${comments.commitId}")`,
            "--ignore-working-copy",
          ],
          { maxOutputBytes: 2 * 1024 * 1024 },
        )
      ).stdout;
      const files = new Map<string, CommentsLayerFile>();
      for (const patch of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
        if (++count > 128)
          throw new ApiError(
            413,
            "CONTENT_TOO_LARGE",
            "At most 128 comment-bearing files are supported.",
          );
        const path = /^\+\+\+ b\/(.*)$/m.exec(patch)?.[1];
        if (!path || /^--- \/dev\/null$/m.test(patch))
          invalidCommentsLayer(
            "Comment branches cannot add, delete or rename source files.",
          );
        parseFile(patch, path);
        if (files.has(path))
          invalidCommentsLayer("Duplicate comment-branch paths.");
        const clean = await readCommentsFile(
          repoPath,
          code.commitId,
          path,
          runner,
        );
        const annotated = await readCommentsFile(
          repoPath,
          comments.commitId,
          path,
          runner,
        );
        total += clean.length + annotated.length;
        if (total > 16 * 1024 * 1024)
          throw new ApiError(
            413,
            "CONTENT_TOO_LARGE",
            "Comment branch content exceeds 16 MiB.",
          );
        const projected = projectCommentsFile(path, annotated);
        if (!projected.clean.equals(clean) || projected.comments.length === 0)
          invalidCommentsLayer(
            "A COMMENTS branch contains actual code edits; only recognized review marker insertions are allowed.",
          );
        for (const comment of projected.comments) {
          if (allIds.has(comment.id))
            invalidCommentsLayer(
              "Review UUIDs must be unique across all comment branches.",
            );
          allIds.add(comment.id);
        }
        projected.cleanComments.forEach((comment) => {
          comment.codeChangeId = code.changeId;
        });
        files.set(path, projected);
      }
      branches.push({ code, comments, files });
    }
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(rows))
      .digest("hex");
    return { source, reviewed, branches, fingerprint };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof ProcessOutputLimitError)
      throw new ApiError(
        413,
        "CONTENT_TOO_LARGE",
        "Comment branch validation exceeds its output budget.",
      );
    invalidCommentsLayer(
      `Comment branches could not be validated: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function readCommentsFile(
  repoPath: string,
  commitId: string,
  path: string,
  runner: typeof jj = jj,
): Promise<Buffer> {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path
      .split("/")
      .some((part) => !part || [".", "..", ".jj", ".git"].includes(part))
  )
    throw new ApiError(
      400,
      "INVALID_PATH",
      "Use an exact supported source path.",
    );
  const result = await runner(
    repoPath,
    [
      "file",
      "show",
      "-r",
      `commit_id("${commitId}")`,
      "--ignore-working-copy",
      "--",
      `root-file:${JSON.stringify(path)}`,
    ],
    { maxOutputBytes: 4 * 1024 * 1024 },
  );
  return result.stdoutBytes ?? Buffer.from(result.stdout);
}
