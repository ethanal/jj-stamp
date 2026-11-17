import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test, type TestContext } from "node:test";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  captureMergedParentFiles,
  readMergedParentFiles,
} from "../server/diff-reader.ts";
import { jj, ProcessOutputLimitError } from "../server/process.ts";

const execute = promisify(execFile);
const fullId = "1".repeat(40);
async function temporary(t: TestContext) {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "jj-stamp-reader-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t: TestContext, paths = ["a"]) {
  const root = await temporary(t);
  const [repository, left, right, privateRoot] = [
    "repo",
    "left",
    "right",
    "private",
  ].map((name) => path.join(root, name));
  for (const name of [repository, left, right, privateRoot]) await mkdir(name);
  await chmod(privateRoot, 0o700);
  const manifest = path.join(privateRoot, "plan.json");
  await writeFile(manifest, JSON.stringify({ version: 1, repository, paths }), {
    mode: 0o600,
  });
  const output = path.join(privateRoot, "files.json");
  return {
    root,
    repository,
    left,
    right,
    privateRoot,
    manifest,
    output,
    capture: () => captureMergedParentFiles(manifest, left, right),
  };
}

async function repository(t: TestContext) {
  const root = await temporary(t);
  const repo = path.join(root, "repo");
  const command = async (args: string[]) => {
    const result = await execute(
      process.env.JJ_STAMP_JJ || "jj",
      ["--no-pager", "--color=never", ...args],
      {
        cwd: repo,
        env: {
          ...process.env,
          JJ_CONFIG: "",
          JJ_USER: "Reader test",
          JJ_EMAIL: "reader@example.com",
        },
      },
    );
    return result.stdout.trim();
  };
  await mkdir(repo);
  await command(["git", "init", "--no-colocate", "."]);
  const id = () => command(["log", "--no-graph", "-r", "@", "-T", "commit_id"]);
  return { repo, command, id };
}

test("real jj reads automatic merged parents, excludes source edits, pins source and never snapshots workspace", async (t) => {
  const f = await repository(t);
  const base = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join("");
  await writeFile(path.join(f.repo, "shared"), base);
  await f.command(["commit", "-m", "base"]);
  const baseId = await f.command([
    "log",
    "--no-graph",
    "-r",
    "@-",
    "-T",
    "commit_id",
  ]);
  const left = base.replace("line 2\n", "left parent\n");
  await writeFile(path.join(f.repo, "shared"), left);
  await f.command(["describe", "-m", "left"]);
  const leftId = await f.id();
  await f.command(["new", baseId]);
  const right = base.replace("line 25\n", "right parent\n");
  await writeFile(path.join(f.repo, "shared"), right);
  await f.command(["describe", "-m", "right"]);
  const rightId = await f.id();
  await f.command(["new", leftId, rightId]);
  const merged = left.replace("line 25\n", "right parent\n");
  assert.equal(await readFile(path.join(f.repo, "shared"), "utf8"), merged);
  await writeFile(
    path.join(f.repo, "shared"),
    merged.replace("line 12\n", "source only\n"),
  );
  await f.command(["describe", "-m", "merge source"]);
  const source = await f.id();
  // Workspace and source-shaped bookmark both point elsewhere at read time.
  await f.command(["new", baseId]);
  await f.command(["bookmark", "create", source, "-r", "@"]);
  await f.command([
    "config",
    "set",
    "--repo",
    "merge-tools.jj-stamp-reader.diff-invocation-mode",
    "file-by-file",
  ]);
  await writeFile(path.join(f.repo, "shared"), "unsnapshotted workspace\n");
  const operation = await f.command([
    "op",
    "log",
    "--limit",
    "1",
    "--no-graph",
    "-T",
    "id",
    "--ignore-working-copy",
  ]);
  const workspace = await f.command([
    "log",
    "-r",
    "@",
    "--no-graph",
    "-T",
    "commit_id",
    "--ignore-working-copy",
  ]);
  const result = await readMergedParentFiles(f.repo, source, ["shared"]);
  assert.deepEqual(result.get("shared"), Buffer.from(merged));
  assert.notDeepEqual(result.get("shared"), Buffer.from(left));
  assert.notDeepEqual(result.get("shared"), Buffer.from(right));
  assert.equal(
    await readFile(path.join(f.repo, "shared"), "utf8"),
    "unsnapshotted workspace\n",
  );
  assert.equal(
    await f.command([
      "op",
      "log",
      "--limit",
      "1",
      "--no-graph",
      "-T",
      "id",
      "--ignore-working-copy",
    ]),
    operation,
  );
  assert.equal(
    await f.command([
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      "commit_id",
      "--ignore-working-copy",
    ]),
    workspace,
  );
});

test("real jj preserves absent/add/delete/empty/binary sides and literal special paths", async (t) => {
  const f = await repository(t);
  const special = 'nested/:(literal)*[x] "name".txt';
  const binary = Buffer.from([0, 255, 128, 10, 13]);
  await mkdir(path.join(f.repo, "nested"));
  await writeFile(path.join(f.repo, "deleted"), "deleted base\n");
  await writeFile(path.join(f.repo, "empty"), "");
  await writeFile(path.join(f.repo, "binary"), binary);
  await writeFile(path.join(f.repo, special), "literal base\n");
  await f.command(["commit", "-m", "base"]);
  await unlink(path.join(f.repo, "deleted"));
  await writeFile(path.join(f.repo, "added"), "added source\n");
  await writeFile(path.join(f.repo, "empty"), "not empty now\n");
  await writeFile(path.join(f.repo, "binary"), Buffer.from([255, 0, 3]));
  await writeFile(path.join(f.repo, special), "literal source\n");
  await f.command(["describe", "-m", "source"]);
  const result = await readMergedParentFiles(f.repo, await f.id(), [
    "deleted",
    "added",
    "empty",
    "binary",
    special,
    "absent",
  ]);
  assert.deepEqual(
    result,
    new Map([
      ["deleted", Buffer.from("deleted base\n")],
      ["added", null],
      ["empty", Buffer.alloc(0)],
      ["binary", binary],
      [special, Buffer.from("literal base\n")],
      ["absent", null],
    ]),
  );
});

test("callback reads only requested known paths and preserves byte/absence distinctions", async (t) => {
  const f = await fixture(t, ["a", "nested/absent", "empty"]);
  const binary = Buffer.from([0, 255, 13, 128]);
  await writeFile(path.join(f.left, "a"), binary);
  await writeFile(path.join(f.left, "empty"), "");
  // Unrequested entries are never followed or inventoried.
  await symlink(f.repository, path.join(f.left, "not-requested"));
  await f.capture();
  assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), [
    ["a", binary.toString("base64")],
    ["nested/absent", null],
    ["empty", ""],
  ]);
  assert.equal((await lstat(f.output)).mode & 0o777, 0o600);
  await assert.rejects(f.capture(), { code: "EEXIST" });
});

test("callback rejects links, nonregular paths, and output redirection without touching targets", async (t) => {
  for (const kind of [
    "symlink",
    "hardlink",
    "directory",
    "parent-link",
    "output-link",
  ]) {
    await t.test(kind, async (t) => {
      const f = await fixture(t, [kind === "parent-link" ? "nested/a" : "a"]);
      const outside = path.join(f.repository, "outside");
      await writeFile(outside, "outside bytes");
      if (kind === "symlink") await symlink(outside, path.join(f.left, "a"));
      if (kind === "hardlink") await link(outside, path.join(f.left, "a"));
      if (kind === "directory") await mkdir(path.join(f.left, "a"));
      if (kind === "parent-link")
        await symlink(f.repository, path.join(f.left, "nested"));
      if (kind === "output-link") await symlink(outside, f.output);
      await assert.rejects(f.capture());
      assert.equal(await readFile(outside, "utf8"), "outside bytes");
    });
  }
});

test("callback rejects overlapping and aliased roots, traversal and unsafe manifests", async (t) => {
  const f = await fixture(t);
  for (const [left, right] of [
    [f.left, f.left],
    [f.repository, f.right],
    [f.privateRoot, f.right],
    [f.root, f.right],
  ])
    await assert.rejects(
      captureMergedParentFiles(f.manifest, left, right),
      /overlap/,
    );
  const alias = path.join(f.root, "alias");
  await symlink(f.left, alias);
  await assert.rejects(
    captureMergedParentFiles(f.manifest, alias, f.right),
    /unsafe directory/,
  );
  for (const paths of [
    ["../a"],
    ["/absolute"],
    ["a/./b"],
    ["a\\b"],
    ["a\0b"],
    ["a", "a"],
    ["a", "a/b"],
  ]) {
    await writeFile(
      f.manifest,
      JSON.stringify({ version: 1, repository: f.repository, paths }),
    );
    await assert.rejects(f.capture(), /selected path/);
  }
  await chmod(f.manifest, 0o644);
  await assert.rejects(f.capture(), /unsafe regular/);
});

test("callback reports 4 MiB per-file and 16 MiB batch limits without file bytes", async (t) => {
  const f = await fixture(t, ["a"]);
  await writeFile(path.join(f.left, "a"), "");
  await truncate(path.join(f.left, "a"), 4 * 1024 * 1024 + 1);
  await f.capture();
  assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), {
    error: "CONTENT_TOO_LARGE",
  });
  await unlink(f.output);
  const paths = ["a", "b", "c", "d", "e"];
  await writeFile(
    f.manifest,
    JSON.stringify({ version: 1, repository: f.repository, paths }),
  );
  for (const name of paths)
    await writeFile(path.join(f.left, name), Buffer.alloc(4 * 1024 * 1024));
  await f.capture();
  assert.deepEqual(JSON.parse(await readFile(f.output, "utf8")), {
    error: "CONTENT_TOO_LARGE",
  });
  await unlink(f.output);
  await assert.rejects(lstat(f.output), { code: "ENOENT" });
});

test("API pins literal args and private lifetime; cleans success, failure and malformed output", async (t) => {
  const root = await temporary(t);
  for (const outcome of ["success", "failure", "missing", "invalid", "limit"]) {
    let manifest = "";
    const runner: typeof jj = async (repo, args) => {
      assert.equal(repo, root);
      assert.deepEqual(args.slice(0, 7), [
        "diff",
        "--tool",
        "jj-stamp-reader",
        "-r",
        `commit_id("${fullId}")`,
        "--ignore-working-copy",
        "--config",
      ]);
      const config = args.find((arg) =>
        arg.startsWith("merge-tools.jj-stamp-reader.diff-args="),
      )!;
      const tool = JSON.parse(config.slice(config.indexOf("=") + 1));
      manifest = tool[1];
      assert.equal((await lstat(path.dirname(manifest))).mode & 0o777, 0o700);
      assert.equal((await lstat(manifest)).mode & 0o777, 0o600);
      assert.deepEqual(tool.slice(2), ["$left", "$right"]);
      assert.deepEqual(args.slice(args.indexOf("--") + 1), [
        'root-file:"[literal]*"',
      ]);
      if (outcome === "failure") throw new Error("injected failure");
      if (outcome !== "missing")
        await writeFile(
          path.join(path.dirname(manifest), "files.json"),
          JSON.stringify(
            outcome === "limit"
              ? { error: "CONTENT_TOO_LARGE" }
              : [["[literal]*", outcome === "invalid" ? "invalid-base64" : ""]],
          ),
          { mode: 0o600 },
        );
      return { stdout: "", stderr: "" };
    };
    if (outcome === "success")
      assert.deepEqual(
        await readMergedParentFiles(root, fullId, ["[literal]*"], runner),
        new Map([["[literal]*", Buffer.alloc(0)]]),
      );
    else if (outcome === "limit")
      await assert.rejects(
        readMergedParentFiles(root, fullId, ["[literal]*"], runner),
        ProcessOutputLimitError,
      );
    else
      await assert.rejects(
        readMergedParentFiles(root, fullId, ["[literal]*"], runner),
      );
    await assert.rejects(lstat(path.dirname(manifest)), { code: "ENOENT" });
  }
  await assert.rejects(readMergedParentFiles(root, "@", ["a"]), /full source/);
  assert.deepEqual(await readMergedParentFiles(root, fullId, []), new Map());
});

test("real jj maps oversized left content to ProcessOutputLimitError", async (t) => {
  const f = await repository(t);
  await f.command([
    "config",
    "set",
    "--repo",
    "snapshot.max-new-file-size",
    "5242880",
  ]);
  await writeFile(
    path.join(f.repo, "large"),
    Buffer.alloc(4 * 1024 * 1024 + 1, 97),
  );
  await f.command(["commit", "-m", "large base"]);
  await writeFile(path.join(f.repo, "large"), "source\n");
  await f.command(["describe", "-m", "source"]);
  await assert.rejects(
    readMergedParentFiles(f.repo, await f.id(), ["large"]),
    ProcessOutputLimitError,
  );
});

test("bundled reader uses sibling helper outside the checkout", async (t) => {
  const f = await repository(t);
  await writeFile(path.join(f.repo, "a"), "base\n");
  await f.command(["commit", "-m", "base"]);
  await writeFile(path.join(f.repo, "a"), "source\n");
  await f.command(["describe", "-m", "source"]);
  const source = await f.id();
  const bundled = path.join(await temporary(t), "package");
  await mkdir(bundled);
  for (const [entry, outfile] of [
    ["diff-reader.ts", "host.cjs"],
    ["diff-reader-cli.ts", "diff-reader.cjs"],
  ]) {
    await build({
      entryPoints: [
        fileURLToPath(new URL(`../server/${entry}`, import.meta.url)),
      ],
      outfile: path.join(bundled, outfile),
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      define: { __JJ_STAMP_BUNDLED__: "true" },
    });
  }
  const runner = path.join(bundled, "run.cjs");
  await writeFile(
    runner,
    `const {readMergedParentFiles}=require('./host.cjs');
readMergedParentFiles(${JSON.stringify(f.repo)},${JSON.stringify(source)},['a'])
.then(files=>require('node:assert/strict').deepEqual(files.get('a'),Buffer.from('base\\n')))
.catch(e=>{console.error(e);process.exitCode=1});`,
  );
  await execute(process.execPath, [runner], { cwd: bundled });
});
