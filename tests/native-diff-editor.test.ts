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
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  applyDiffEditor,
  withDiffEditor,
  type DiffEditorPlan,
} from "../server/diff-editor.ts";

const execute = promisify(execFile);
const b64 = (value: string | Buffer): string =>
  Buffer.from(value).toString("base64");
const edit = (name = "a.txt"): DiffEditorPlan["files"][number] => ({
  path: name,
  base: b64("base\n"),
  source: b64("source\n"),
  result: b64("selected\n"),
});

async function fixture(t: TestContext, files = [edit()]) {
  const root = await mkdtemp(
    path.join(await realpath(os.tmpdir()), "jj-stamp-native-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const left = path.join(root, "left");
  const right = path.join(root, "right");
  const manifest = path.join(root, "plan.json");
  for (const dir of [repository, left, right]) await mkdir(dir);
  const plan: DiffEditorPlan = { version: 1, repository, files };
  await writeFile(manifest, JSON.stringify(plan), { mode: 0o600 });
  for (const file of files) {
    for (const [side, bytes] of [
      [left, file.base],
      [right, file.source],
    ]) {
      if (bytes === null) continue;
      const target = path.join(side!, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(bytes, "base64"), { mode: 0o644 });
    }
  }
  return {
    root,
    repository,
    left,
    right,
    manifest,
    plan,
    apply: () => applyDiffEditor(manifest, left, right),
  };
}

function editArgs(args: string[]): string[] {
  assert.equal(args.length, 8);
  assert.deepEqual(
    args.filter((_, index) => index % 2 === 0),
    ["--config", "--config", "--config", "--config"],
  );
  assert.equal(
    args[1],
    `merge-tools.jj-stamp.program=${JSON.stringify(process.execPath)}`,
  );
  assert.equal(args[5], "ui.diff-instructions=false");
  assert.equal(args[7], 'merge-tools.jj-stamp.edit-invocation-mode="dir"');
  return JSON.parse(args[3].slice("merge-tools.jj-stamp.edit-args=".length));
}

test("validates all bytes, writes only right, preserves arbitrary bytes and replaces inodes", async (t) => {
  const result = Buffer.from([0, 255, 10, 13, 128]);
  const f = await fixture(t, [
    { ...edit("dir/a.txt"), result: b64(result) },
    edit("other.txt"),
  ]);
  const outside = path.join(f.repository, "untouched.txt");
  await writeFile(outside, "outside");
  await chmod(path.join(f.left, "dir/a.txt"), 0o444);
  await chmod(path.join(f.right, "dir/a.txt"), 0o444);
  const before = await stat(path.join(f.right, "dir/a.txt"));
  await f.apply();
  assert.deepEqual(await readFile(path.join(f.right, "dir/a.txt")), result);
  assert.equal(
    await readFile(path.join(f.right, "other.txt"), "utf8"),
    "selected\n",
  );
  assert.equal(
    await readFile(path.join(f.left, "dir/a.txt"), "utf8"),
    "base\n",
  );
  assert.equal(await readFile(outside, "utf8"), "outside");
  const after = await stat(path.join(f.right, "dir/a.txt"));
  assert.notEqual(before.ino, after.ino);
  assert.equal(after.mode & 0o777, 0o644);
  assert.deepEqual(await readdir(path.join(f.right, "dir")), ["a.txt"]);
});

test("creates missing parents, removes files, and preserves absent and empty-file distinctions", async (t) => {
  const f = await fixture(t, [
    {
      path: "restored/deep/a",
      base: b64("base"),
      source: null,
      result: b64("partial"),
    },
    { path: "deleted", base: null, source: b64("new"), result: null },
    { path: "absent", base: b64("gone"), source: null, result: null },
    { path: "empty", base: null, source: b64("new"), result: "" },
    { path: "new", base: null, source: b64("new"), result: b64("new") },
  ]);
  await f.apply();
  assert.equal(
    await readFile(path.join(f.right, "restored/deep/a"), "utf8"),
    "partial",
  );
  for (const name of ["deleted", "absent"])
    await assert.rejects(lstat(path.join(f.right, name)), { code: "ENOENT" });
  assert.equal((await readFile(path.join(f.right, "empty"))).length, 0);
  assert.equal(await readFile(path.join(f.right, "new"), "utf8"), "new");
});

for (const side of ["left", "right"] as const) {
  test(`${side} mismatch in later file fails before any writes`, async (t) => {
    const f = await fixture(t, [edit("a"), edit("z")]);
    await writeFile(path.join(f[side], "z"), "unexpected");
    await assert.rejects(f.apply(), /bytes mismatch/);
    assert.equal(await readFile(path.join(f.right, "a"), "utf8"), "source\n");
    assert.deepEqual(await readdir(f.right), ["a", "z"]);
  });
  for (const extra of ["unexpected", "JJ-INSTRUCTIONS"]) {
    test(`${side} rejects extra ${extra}`, async (t) => {
      const f = await fixture(t);
      await writeFile(path.join(f[side], extra), "unexpected");
      await assert.rejects(f.apply(), /unexpected/);
      assert.equal(
        await readFile(path.join(f.right, "a.txt"), "utf8"),
        "source\n",
      );
    });
  }
  test(`${side} rejects missing files and extra directories`, async (t) => {
    const f = await fixture(t);
    await rm(path.join(f[side], "a.txt"));
    await assert.rejects(f.apply(), /missing/);
    await mkdir(path.join(f[side], "extra"));
    await assert.rejects(f.apply(), /unexpected/);
  });
}

test("strict manifest schema, paths and canonical base64 fail closed", async (t) => {
  const f = await fixture(t);
  const invalid: unknown[] = [
    null,
    [],
    {},
    { ...f.plan, version: 2 },
    { ...f.plan, extra: true },
    { ...f.plan, repository: "relative" },
    { ...f.plan, files: [] },
    { ...f.plan, files: [edit(), edit()] },
    { ...f.plan, files: [edit("a"), edit("a/b")] },
    ...[
      "",
      ".",
      "..",
      "../escape",
      "/absolute",
      "dir/../escape",
      "dir//a",
      "dir/./a",
      "dir\\a",
      "a\0b",
    ].map((name) => ({ ...f.plan, files: [edit(name)] })),
    ...["YQ", "YQ===", "YQ==\n", "YR==", 12, undefined].map((base) => ({
      ...f.plan,
      files: [{ ...edit(), base }],
    })),
    { ...f.plan, files: [{ ...edit(), extra: true }] },
    { ...f.plan, files: [{ ...edit(), base: b64("source\n") }] },
  ];
  for (const value of invalid) {
    await writeFile(f.manifest, JSON.stringify(value));
    await assert.rejects(f.apply(), /Native diff editor/);
  }
  await writeFile(f.manifest, "{");
  await assert.rejects(f.apply(), SyntaxError);
  assert.equal(await readFile(path.join(f.right, "a.txt"), "utf8"), "source\n");
});

for (const side of ["left", "right"] as const) {
  for (const kind of [
    "root",
    "ancestor",
    "nested",
    "file",
    "hardlink",
    "executable",
    "fifo",
  ]) {
    test(`${side} rejects ${kind} without touching outside files`, async (t) => {
      const f = await fixture(t, [edit("dir/a")]);
      const outside = path.join(f.repository, "outside");
      await writeFile(outside, "source\n");
      let left = f.left;
      let right = f.right;
      if (kind === "root") {
        const alias = path.join(f.root, "alias");
        await symlink(f[side], alias);
        if (side === "left") left = alias;
        else right = alias;
      } else if (kind === "ancestor") {
        const alias = path.join(f.root, "alias");
        await symlink(f.root, alias);
        if (side === "left") left = path.join(alias, "left");
        else right = path.join(alias, "right");
      } else if (kind === "nested") {
        await rm(path.join(f[side], "dir"), { recursive: true });
        await symlink(f.repository, path.join(f[side], "dir"));
      } else {
        const target = path.join(f[side], "dir/a");
        if (kind === "executable") await chmod(target, 0o755);
        else {
          await rm(target);
          if (kind === "file") await symlink(outside, target);
          if (kind === "hardlink") await link(outside, target);
          if (kind === "fifo") await execute("mkfifo", [target]);
        }
      }
      await assert.rejects(
        applyDiffEditor(f.manifest, left, right),
        /Native diff editor/,
      );
      assert.equal(await readFile(outside, "utf8"), "source\n");
    });
  }
}

test("rejects equal/overlapping roots and all repository overlap directions", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.left, "nested"));
  for (const [left, right] of [
    [f.left, f.left],
    [f.left, path.join(f.left, "nested")],
    [f.repository, f.right],
    [f.root, f.right],
    [f.left, f.repository],
  ]) {
    await assert.rejects(applyDiffEditor(f.manifest, left, right), /overlap/);
  }
  await mkdir(path.join(f.repository, "scratch"));
  await assert.rejects(
    applyDiffEditor(f.manifest, f.left, path.join(f.repository, "scratch")),
    /overlap/,
  );
});

test("rejects symlinked or hardlinked manifests and loose manifest permissions", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.root, "alias.json");
  await symlink(f.manifest, alias);
  await assert.rejects(applyDiffEditor(alias, f.left, f.right), /unsafe/);
  await rm(alias);
  await link(f.manifest, alias);
  await assert.rejects(f.apply(), /unsafe/);
  await rm(alias);
  await chmod(f.manifest, 0o644);
  await assert.rejects(f.apply(), /unsafe/);
});

test("private lifecycle config runs once, returns callback result and cleans success/failure", async (t) => {
  const f = await fixture(t);
  for (const failure of [false, true]) {
    let calls = 0;
    let manifest = "";
    const error = new Error("callback failed");
    const run = withDiffEditor(f.plan, async (config) => {
      calls++;
      const args = editArgs(config);
      assert.equal(
        args[0],
        fileURLToPath(new URL("../server/diff-editor-cli.ts", import.meta.url)),
      );
      assert.deepEqual(args.slice(2), ["$left", "$right"]);
      manifest = args[1];
      assert.equal((await stat(path.dirname(manifest))).mode & 0o777, 0o700);
      assert.equal((await stat(manifest)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), f.plan);
      if (failure) throw error;
      return 42;
    });
    if (failure) await assert.rejects(run, (value) => value === error);
    else assert.equal(await run, 42);
    assert.equal(calls, 1);
    await assert.rejects(stat(path.dirname(manifest)), { code: "ENOENT" });
  }
});

test("source entrypoint works using Node native TypeScript stripping", async (t) => {
  const f = await fixture(t);
  await withDiffEditor(f.plan, async (config) => {
    const [script, manifest] = editArgs(config);
    await execute(process.execPath, [script, manifest, f.left, f.right]);
  });
  assert.equal(
    await readFile(path.join(f.right, "a.txt"), "utf8"),
    "selected\n",
  );
  const script = fileURLToPath(
    new URL("../server/diff-editor-cli.ts", import.meta.url),
  );
  await assert.rejects(execute(process.execPath, [script]), (error) => {
    assert.match((error as { stderr: string }).stderr, /Usage:/);
    return true;
  });
});

test("bundled lifecycle locates bundled sibling outside the source checkout", async (t) => {
  const f = await fixture(t);
  const bundled = path.join(f.root, "package");
  await mkdir(bundled);
  const source = fileURLToPath(
    new URL("../server/diff-editor.ts", import.meta.url),
  );
  await build({
    entryPoints: [source],
    outfile: path.join(bundled, "host.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    define: { __JJ_STAMP_BUNDLED__: "true" },
  });
  await build({
    entryPoints: [
      fileURLToPath(new URL("../server/diff-editor-cli.ts", import.meta.url)),
    ],
    outfile: path.join(bundled, "diff-editor.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    define: { __JJ_STAMP_BUNDLED__: "true" },
  });
  const runner = path.join(bundled, "run.cjs");
  await writeFile(
    runner,
    `const {withDiffEditor}=require('./host.cjs');
const {execFileSync}=require('node:child_process');
withDiffEditor(${JSON.stringify(f.plan)}, async config => {
  const args=JSON.parse(config[3].slice('merge-tools.jj-stamp.edit-args='.length));
  if(args[0]!==require('node:path').join(__dirname,'diff-editor.cjs')) throw Error('not bundled sibling');
  execFileSync(process.execPath,[...args.slice(0,2),${JSON.stringify(f.left)},${JSON.stringify(f.right)}]);
}).catch(e=>{console.error(e);process.exitCode=1});`,
  );
  await execute(process.execPath, [runner], { cwd: f.root });
  assert.equal(
    await readFile(path.join(f.right, "a.txt"), "utf8"),
    "selected\n",
  );
});

test("real jj native squash restricts callback filesets and preserves unselected changes", async (t) => {
  try {
    await execute("jj", ["--version"]);
  } catch {
    t.skip("jj is not installed");
    return;
  }
  const f = await fixture(t);
  const jj = (args: string[]) =>
    execute("jj", ["--no-pager", ...args], {
      cwd: f.repository,
      env: {
        ...process.env,
        JJ_CONFIG: "",
        JJ_USER: "Native Test",
        JJ_EMAIL: "native@example.com",
      },
    });
  await jj(["git", "init", "--no-colocate"]);
  await jj([
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await writeFile(path.join(f.repository, "selected.txt"), "one\ntwo\nthree\n");
  await writeFile(path.join(f.repository, "unselected.txt"), "base\n");
  await writeFile(path.join(f.repository, "deleted.txt"), "restore\n");
  await jj(["commit", "-m", "base"]);
  await writeFile(path.join(f.repository, "selected.txt"), "ONE\ntwo\nTHREE\n");
  await writeFile(
    path.join(f.repository, "unselected.txt"),
    "unselected source\n",
  );
  await writeFile(path.join(f.repository, "created.txt"), "created\n");
  await rm(path.join(f.repository, "deleted.txt"));
  await jj(["describe", "-m", "source"]);
  const plan: DiffEditorPlan = {
    version: 1,
    repository: f.repository,
    files: [
      {
        path: "selected.txt",
        base: b64("one\ntwo\nthree\n"),
        source: b64("ONE\ntwo\nTHREE\n"),
        result: b64("ONE\ntwo\nthree\n"),
      },
      {
        path: "created.txt",
        base: null,
        source: b64("created\n"),
        result: b64("created\n"),
      },
      {
        path: "deleted.txt",
        base: b64("restore\n"),
        source: null,
        result: b64("restore\n"),
      },
    ],
  };
  // A repository's same-named tool configuration must not change our protocol.
  await jj([
    "config",
    "set",
    "--repo",
    "merge-tools.jj-stamp.edit-invocation-mode",
    "file-by-file",
  ]);
  await withDiffEditor(plan, (config) =>
    jj([
      "squash",
      "--tool",
      "jj-stamp",
      "--from",
      "@",
      "--into",
      "@-",
      "--keep-emptied",
      "--use-destination-message",
      ...config,
      "--",
      ...plan.files.map((file) => `root-file:${JSON.stringify(file.path)}`),
    ]),
  );
  assert.equal(
    (await jj(["file", "show", "-r", "@-", "selected.txt"])).stdout,
    "ONE\ntwo\nthree\n",
  );
  assert.equal(
    (await jj(["file", "show", "-r", "@-", "unselected.txt"])).stdout,
    "base\n",
  );
  assert.equal(
    (await jj(["file", "show", "-r", "@-", "created.txt"])).stdout,
    "created\n",
  );
  assert.equal(
    (await jj(["file", "show", "-r", "@-", "deleted.txt"])).stdout,
    "restore\n",
  );
  assert.equal(
    await readFile(path.join(f.repository, "selected.txt"), "utf8"),
    "ONE\ntwo\nTHREE\n",
  );
  assert.equal(
    await readFile(path.join(f.repository, "unselected.txt"), "utf8"),
    "unselected source\n",
  );
  await assert.rejects(lstat(path.join(f.repository, "deleted.txt")), {
    code: "ENOENT",
  });
});

test("canonicalizes only the runtime temp prefix, including native callback and manifest cleanup", async (t) => {
  const f = await fixture(t);
  // Model macOS /var -> /private/var followed by a real folders/... TMPDIR.
  const realParent = path.join(f.root, "private-var");
  const aliasParent = path.join(f.root, "var");
  const realTemp = path.join(realParent, "folders", "temp");
  const aliasTemp = path.join(aliasParent, "folders", "temp");
  await mkdir(realTemp, { recursive: true });
  await symlink(realParent, aliasParent);
  t.mock.method(os, "tmpdir", () => aliasTemp);
  const nested = await fixture(t);
  assert.equal(path.dirname(nested.root), realTemp);
  const aliasRoot = path.join(aliasTemp, path.basename(nested.root));
  let manifest = "";
  await withDiffEditor(nested.plan, async (config) => {
    const args = editArgs(config);
    manifest = args[1];
    assert.equal(path.dirname(path.dirname(manifest)), realTemp);
    assert.equal(await realpath(manifest), manifest);
    await execute(
      process.execPath,
      [
        args[0],
        manifest,
        path.join(aliasRoot, "left"),
        path.join(aliasRoot, "right"),
      ],
      { env: { ...process.env, TMPDIR: aliasTemp } },
    );
  });
  assert.equal(
    await readFile(path.join(nested.right, "a.txt"), "utf8"),
    "selected\n",
  );
  await assert.rejects(stat(path.dirname(manifest)), { code: "ENOENT" });
  await assert.rejects(
    withDiffEditor(nested.plan, async (config) => {
      manifest = editArgs(config)[1];
      throw new Error("test cleanup under aliased temp prefix");
    }),
    /test cleanup/,
  );
  await assert.rejects(stat(path.dirname(manifest)), { code: "ENOENT" });
});

test("temp-prefix canonicalization still rejects scratch symlinks, traversal and repository overlaps", async (t) => {
  const f = await fixture(t, [edit("dir/a")]);
  const alias = path.join(f.root, "temp-alias");
  await symlink(f.root, alias);
  t.mock.method(os, "tmpdir", () => alias);
  const aliasLeft = path.join(alias, "left");
  const aliasRight = path.join(alias, "right");
  await symlink(f.right, path.join(f.root, "root-link"));
  await symlink(f.root, path.join(f.root, "intermediate-link"));
  await symlink(f.root, `${alias}-other`);
  for (const right of [
    path.join(alias, "root-link"),
    path.join(alias, "intermediate-link", "right"),
    path.join(`${alias}-other`, "right"),
    `${alias}/left/../right`,
  ]) {
    await assert.rejects(
      applyDiffEditor(f.manifest, aliasLeft, right),
      /unsafe directory|absolute canonical path/,
    );
  }
  await assert.rejects(
    applyDiffEditor(f.manifest, aliasLeft, f.left),
    /overlap/,
  );
  await assert.rejects(
    applyDiffEditor(f.manifest, aliasLeft, path.join(alias, "repository")),
    /overlap/,
  );
  await rm(path.join(f.right, "dir"), { recursive: true });
  await symlink(path.join(f.left, "dir"), path.join(f.right, "dir"));
  await assert.rejects(
    applyDiffEditor(f.manifest, aliasLeft, aliasRight),
    /unexpected source file/,
  );
  assert.equal(await readFile(path.join(f.left, "dir/a"), "utf8"), "base\n");
});
