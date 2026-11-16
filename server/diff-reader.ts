import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { jj } from "./process.ts";

declare const __JJ_STAMP_BUNDLED__: boolean;

const FILE_LIMIT = 4 * 1024 * 1024;
const BATCH_LIMIT = 16 * 1024 * 1024;
const MANIFEST_LIMIT = 256 * 1024;
const OUTPUT_LIMIT = Math.ceil(BATCH_LIMIT / 3) * 4 + MANIFEST_LIMIT;
type Manifest = { version: 1; repository: string; paths: string[] };
class ContentLimitError extends Error {}

function fail(message: string): never {
  throw new Error(`Native merged-parent reader: ${message}`);
}

function canonicalAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function validateManifest(value: unknown): Manifest {
  const plan = value as Manifest;
  if (
    !plan ||
    typeof plan !== "object" ||
    Object.keys(plan).sort().join(",") !== "paths,repository,version" ||
    plan.version !== 1 ||
    !canonicalAbsolute(plan.repository) ||
    !Array.isArray(plan.paths) ||
    plan.paths.length > 1024
  )
    fail("invalid manifest");
  const seen = new Set<string>();
  let pathBytes = 0;
  for (const name of plan.paths) {
    if (
      typeof name !== "string" ||
      name.includes("\0") ||
      name.includes("\\") ||
      Buffer.from(name).toString("utf8") !== name ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      seen.has(name)
    )
      fail("invalid or duplicate selected path");
    seen.add(name);
    pathBytes += Buffer.byteLength(name);
  }
  if (pathBytes > 64 * 1024) fail("selected paths exceed limit");
  for (const name of seen) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (seen.has(parts.join("/"))) fail("overlapping selected paths");
      parts.pop();
    }
  }
  return plan;
}

function overlaps(a: string, b: string): boolean {
  const relative = path.relative(a, b);
  return (
    !relative ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Check every component, without following even an in-tree symlink. */
async function directory(absolute: string): Promise<void> {
  if (!canonicalAbsolute(absolute)) fail("noncanonical directory");
  let current = path.parse(absolute).root;
  for (const part of [
    "",
    ...absolute.slice(current.length).split(path.sep).filter(Boolean),
  ]) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail("unsafe directory");
  }
  if ((await realpath(absolute)) !== absolute) fail("aliased directory");
}

/** Bounded allocation/read, no links, no devices or FIFOs, no input chmod. */
async function readRegular(
  filename: string,
  limit: number,
  privateFile = false,
): Promise<Buffer> {
  const before = await lstat(filename);
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    (privateFile && (before.mode & 0o7777) !== 0o600)
  )
    fail("unsafe regular file");
  if (before.size > limit) throw new ContentLimitError("Content exceeds limit");
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.mode !== before.mode ||
      stat.size !== before.size
    )
      fail("file changed while opening");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs
    )
      fail("file changed while reading");
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function scratchRoot(absolute: string): Promise<string> {
  if (!canonicalAbsolute(absolute)) fail("noncanonical scratch root");
  // Resolve only the trusted OS temp prefix (macOS /var -> /private/var).
  const prefix = path.resolve(os.tmpdir());
  const realPrefix = await realpath(prefix);
  return overlaps(prefix, absolute)
    ? path.join(realPrefix, path.relative(prefix, absolute))
    : absolute;
}

/** Callback for jj's directory diff viewer. Reads only named left-side paths;
 * it never inventories a scratch tree, writes a scratch file, or edits history.
 * Like the editor, this is not a transaction against hostile concurrent locals.
 */
export async function captureMergedParentFiles(
  manifestPath: string,
  left: string,
  right: string,
): Promise<void> {
  if (!canonicalAbsolute(manifestPath)) fail("noncanonical manifest path");
  const privateRoot = path.dirname(manifestPath);
  await directory(privateRoot);
  const mode = await lstat(privateRoot);
  if (
    (mode.mode & 0o7777) !== 0o700 ||
    (process.getuid && mode.uid !== process.getuid())
  )
    fail("manifest directory is not private");
  const plan = validateManifest(
    JSON.parse(
      (await readRegular(manifestPath, MANIFEST_LIMIT, true)).toString("utf8"),
    ),
  );
  await directory(plan.repository);
  left = await scratchRoot(left);
  right = await scratchRoot(right);
  for (const root of [left, right]) await directory(root);
  const roots = [left, right, plan.repository, privateRoot];
  for (let i = 0; i < roots.length; i++)
    for (let j = i + 1; j < roots.length; j++)
      if (overlaps(roots[i], roots[j]) || overlaps(roots[j], roots[i]))
        fail("scratch, repository and manifest roots must not overlap");
  const files: Array<[string, string | null]> = [];
  let payload: unknown = files;
  try {
    let total = 0;
    for (const name of plan.paths) {
      const parts = name.split("/");
      let parent = left;
      let absent = false;
      // Only ENOENT means absent: links, non-directories and unreadable paths fail.
      for (const part of parts.slice(0, -1)) {
        parent = path.join(parent, part);
        try {
          await directory(parent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          absent = true;
          break;
        }
      }
      let bytes: Buffer | null = null;
      if (!absent) {
        try {
          bytes = await readRegular(
            path.join(left, name),
            Math.min(FILE_LIMIT, BATCH_LIMIT - total),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      total += bytes?.length ?? 0;
      files.push([name, bytes?.toString("base64") ?? null]);
    }
  } catch (error) {
    if (!(error instanceof ContentLimitError)) throw error;
    // jj diff can report callback failures as warnings with exit status zero.
    // Use a bounded structured response, not stderr parsing, for host limits.
    payload = { error: "CONTENT_TOO_LARGE" };
  }
  // Fixed private sibling, exclusive/no-follow creation; never a manifest-supplied output path.
  const output = await open(
    path.join(privateRoot, "files.json"),
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await output.writeFile(JSON.stringify(payload));
  } finally {
    await output.close();
  }
}

/** Read source-diff paths from jj's automatic merged-parent tree. Paths must
 * come from the pinned source diff (unchanged files are not materialized by jj).
 * There is deliberately no squash destination argument or synthetic commit.
 */
export async function readMergedParentFiles(
  repoPath: string,
  sourceCommitId: string,
  paths: string[],
  jjRunner?: typeof jj,
): Promise<Map<string, Buffer | null>> {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sourceCommitId))
    fail("expected full source commit ID");
  paths = [...paths];
  const repository = await realpath(repoPath);
  const plan = validateManifest({ version: 1, repository, paths });
  if (!paths.length) return new Map();
  const temporary = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "jj-stamp-diff-reader-"),
  );
  try {
    await chmod(temporary, 0o700);
    const manifest = path.join(temporary, "plan.json");
    await writeFile(manifest, JSON.stringify(plan), {
      mode: 0o600,
      flag: "wx",
    });
    const script =
      typeof __JJ_STAMP_BUNDLED__ !== "undefined" && __JJ_STAMP_BUNDLED__
        ? path.join(__dirname, "diff-reader.cjs")
        : fileURLToPath(new URL("./diff-reader-cli.ts", import.meta.url));
    const runner = jjRunner ?? (await import("./process.ts")).jj;
    await runner(
      repository,
      [
        "diff",
        "--tool",
        "jj-stamp-reader",
        "-r",
        `commit_id("${sourceCommitId}")`,
        "--ignore-working-copy",
        "--config",
        `merge-tools.jj-stamp-reader.program=${JSON.stringify(process.execPath)}`,
        "--config",
        `merge-tools.jj-stamp-reader.diff-args=${JSON.stringify([script, manifest, "$left", "$right"])}`,
        "--config",
        'merge-tools.jj-stamp-reader.diff-invocation-mode="dir"',
        "--",
        ...paths.map((name) => `root-file:${JSON.stringify(name)}`),
      ],
      { maxOutputBytes: 1024 * 1024 },
    );
    let files: unknown;
    try {
      files = JSON.parse(
        (
          await readRegular(
            path.join(temporary, "files.json"),
            OUTPUT_LIMIT,
            true,
          )
        ).toString("utf8"),
      );
    } catch (error) {
      if (error instanceof ContentLimitError)
        throw new (await import("./process.ts")).ProcessOutputLimitError();
      throw error;
    }
    if (
      files &&
      typeof files === "object" &&
      "error" in files &&
      files.error === "CONTENT_TOO_LARGE"
    )
      throw new (await import("./process.ts")).ProcessOutputLimitError();
    if (!Array.isArray(files) || files.length !== paths.length)
      fail("invalid callback output");
    const result = new Map<string, Buffer | null>();
    let total = 0;
    for (let i = 0; i < paths.length; i++) {
      const entry: unknown = files[i];
      if (
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry[0] !== paths[i] ||
        (entry[1] !== null && typeof entry[1] !== "string")
      )
        fail("invalid callback entry");
      const bytes = entry[1] === null ? null : Buffer.from(entry[1], "base64");
      if (bytes && bytes.toString("base64") !== entry[1])
        fail("invalid callback bytes");
      if (bytes && bytes.length > FILE_LIMIT)
        throw new (await import("./process.ts")).ProcessOutputLimitError();
      total += bytes?.length ?? 0;
      if (total > BATCH_LIMIT)
        throw new (await import("./process.ts")).ProcessOutputLimitError();
      result.set(paths[i], bytes);
    }
    return result;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
