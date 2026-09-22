import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __JJ_STAMP_BUNDLED__: boolean;

export type DiffEditorPlan = {
  version: 1;
  repository: string;
  files: Array<{
    path: string;
    base: string | null;
    source: string | null;
    result: string | null;
  }>;
};

function fail(message: string): never {
  throw new Error(`Native diff editor: ${message}`);
}

function objectWithKeys(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === keys.sort().join("\0")
  );
}

function canonicalAbsolute(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !value.includes("\0") &&
    path.isAbsolute(value) &&
    path.resolve(value) === value
  );
}

function validatePlan(value: unknown): DiffEditorPlan {
  if (
    !objectWithKeys(value, ["version", "repository", "files"]) ||
    value.version !== 1 ||
    !canonicalAbsolute(value.repository) ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    fail("invalid manifest");
  }
  const paths = new Set<string>();
  for (const file of value.files) {
    if (
      !objectWithKeys(file, ["path", "base", "source", "result"]) ||
      typeof file.path !== "string" ||
      file.path.includes("\\") ||
      file.path.includes("\0") ||
      path.posix.isAbsolute(file.path) ||
      file.path
        .split("/")
        .some((part) => !part || part === "." || part === "..") ||
      paths.has(file.path)
    ) {
      fail("invalid or duplicate selected path");
    }
    paths.add(file.path);
    for (const key of ["base", "source", "result"]) {
      const bytes = file[key];
      if (
        bytes !== null &&
        (typeof bytes !== "string" ||
          Buffer.from(bytes, "base64").toString("base64") !== bytes)
      ) {
        fail(`invalid canonical base64 for ${file.path}`);
      }
    }
    if (file.base === file.source)
      fail(`selected file is unchanged: ${file.path}`);
  }
  for (const name of paths) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      if (paths.has(parts.join("/"))) fail("overlapping selected paths");
      parts.pop();
    }
  }
  return value as DiffEditorPlan;
}

/** Every component is checked, not just the final directory. */
async function directory(absolute: string): Promise<void> {
  if (!canonicalAbsolute(absolute))
    fail("directory must be an absolute canonical path");
  let current = path.parse(absolute).root;
  for (const part of [
    "",
    ...absolute.slice(current.length).split(path.sep).filter(Boolean),
  ]) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      fail(`unsafe directory: ${current}`);
  }
  if ((await realpath(absolute)) !== absolute)
    fail(`aliased directory: ${absolute}`);
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

/** Resolve only the trusted runtime temp prefix (e.g. macOS /var/folders).
 * Do not realpath the supplied scratch root: links below that prefix must still
 * be rejected by directory(), including links back into the same scratch tree.
 */
function canonicalScratchRoot(
  absolute: string,
  tempPrefix: string,
  realTempPrefix: string,
): string {
  if (!canonicalAbsolute(absolute))
    fail("scratch root must be an absolute canonical path");
  return overlaps(tempPrefix, absolute)
    ? path.join(realTempPrefix, path.relative(tempPrefix, absolute))
    : absolute;
}

async function readRegular(
  filename: string,
  manifest = false,
): Promise<Buffer> {
  const before = await lstat(filename);
  // jj can make non-executable inputs read-only. Never chmod an input inode.
  const mode = before.mode & 0o7777;
  if (
    !before.isFile() ||
    before.nlink !== 1 ||
    (manifest ? mode !== 0o600 : mode !== 0o644 && mode !== 0o444)
  ) {
    fail(`unsafe regular file or mode: ${filename}`);
  }
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      after.mode !== before.mode
    )
      fail(`file changed while opening: ${filename}`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function verifySide(
  root: string,
  plan: DiffEditorPlan,
  side: "base" | "source",
): Promise<void> {
  const expected = new Map(
    plan.files
      .filter((file) => file[side] !== null)
      .map((file) => [file.path, file[side]!]),
  );
  const directories = new Set<string>();
  for (const name of expected.keys()) {
    const parts = name.split("/");
    parts.pop();
    while (parts.length) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  async function walk(relative: string): Promise<void> {
    for (const name of await readdir(path.join(root, relative))) {
      const entry = relative ? `${relative}/${name}` : name;
      const absolute = path.join(root, entry);
      const stat = await lstat(absolute);
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        if (!directories.has(entry))
          fail(`unexpected ${side} directory: ${entry}`);
        await walk(entry);
      } else {
        const bytes = expected.get(entry);
        if (bytes === undefined) fail(`unexpected ${side} file: ${entry}`);
        if (!(await readRegular(absolute)).equals(Buffer.from(bytes, "base64")))
          fail(`${side} bytes mismatch: ${entry}`);
        expected.delete(entry);
      }
    }
  }
  await walk("");
  if (expected.size)
    fail(`missing ${side} file: ${expected.keys().next().value}`);
}

/** Validate both entire restricted inventories before changing any right-side file.
 * These are private jj scratch trees, not a cross-process filesystem transaction.
 */
export async function applyDiffEditor(
  planPath: string,
  left: string,
  right: string,
): Promise<void> {
  if (!canonicalAbsolute(planPath))
    fail("manifest path must be absolute and canonical");
  await directory(path.dirname(planPath));
  const plan = validatePlan(
    JSON.parse((await readRegular(planPath, true)).toString("utf8")),
  );
  await directory(plan.repository);
  const tempPrefix = path.resolve(os.tmpdir());
  const realTempPrefix = await realpath(tempPrefix);
  left = canonicalScratchRoot(left, tempPrefix, realTempPrefix);
  right = canonicalScratchRoot(right, tempPrefix, realTempPrefix);
  await directory(left);
  await directory(right);
  for (const [a, b] of [
    [left, right],
    [left, plan.repository],
    [right, plan.repository],
  ]) {
    if (overlaps(a, b) || overlaps(b, a))
      fail("scratch roots must be distinct and cannot overlap the repository");
  }
  await verifySide(left, plan, "base");
  await verifySide(right, plan, "source");

  const created: string[] = [];
  try {
    for (const file of plan.files) {
      if (file.result === file.source) continue;
      let parent = right;
      const parts = file.path.split("/");
      parts.pop();
      for (const part of parts) {
        parent = path.join(parent, part);
        try {
          await mkdir(parent, { mode: 0o755 });
          created.push(parent);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
        await directory(parent);
      }
      await directory(parent);
      const destination = path.join(right, file.path);
      if (file.source !== null) {
        if (
          !(await readRegular(destination)).equals(
            Buffer.from(file.source, "base64"),
          )
        )
          fail(`source changed before write: ${file.path}`);
      } else {
        try {
          await lstat(destination);
          fail(`unexpected destination: ${file.path}`);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (file.result === null) {
        if (file.source !== null) await unlink(destination);
        continue;
      }
      const temporary = path.join(parent, `.jj-stamp-${randomUUID()}`);
      try {
        const handle = await open(
          temporary,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(Buffer.from(file.result, "base64"));
          await handle.chmod(0o644);
        } finally {
          await handle.close();
        }
        await directory(parent);
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  } finally {
    // Only remove empty directories created by us; never recursively clean a side.
    for (const entry of created.reverse()) {
      try {
        await rmdir(entry);
      } catch (error) {
        if (
          !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
            (error as NodeJS.ErrnoException).code ?? "",
          )
        )
          throw error;
      }
    }
  }
}

/** Own the short-lived private manifest for exactly one jj invocation, no retries. */
export async function withDiffEditor<T>(
  plan: DiffEditorPlan,
  callback: (configArgs: string[]) => Promise<T>,
): Promise<T> {
  const validated = validatePlan(plan);
  const temporary = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "jj-stamp-diff-editor-"),
  );
  try {
    await chmod(temporary, 0o700);
    const manifest = path.join(temporary, "plan.json");
    await writeFile(manifest, JSON.stringify(validated), {
      mode: 0o600,
      flag: "wx",
    });
    const script =
      typeof __JJ_STAMP_BUNDLED__ !== "undefined" && __JJ_STAMP_BUNDLED__
        ? path.join(__dirname, "diff-editor.cjs")
        : fileURLToPath(new URL("./diff-editor-cli.ts", import.meta.url));
    return await callback([
      "--config",
      `merge-tools.jj-stamp.program=${JSON.stringify(process.execPath)}`,
      "--config",
      `merge-tools.jj-stamp.edit-args=${JSON.stringify([script, manifest, "$left", "$right"])}`,
      "--config",
      "ui.diff-instructions=false",
      "--config",
      'merge-tools.jj-stamp.edit-invocation-mode="dir"',
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
