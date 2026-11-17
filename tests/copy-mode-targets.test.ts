import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { jj, run } from "../server/process.ts";
import { ReviewService, type State } from "../server/service.ts";
import { metadataSelectionId } from "../src/file-selection.ts";

const origin = "original/source[1]:notes.sh";
const copied = "copies/edited[1]:notes.sh";
const pureCopy = "copies/pure[1]:notes.sh";
const script = "mode-only.sh";
const pinned = (id: string) => `commit_id("${id}")`;
const base = Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`).join("");
const editedCopy = (bytes: string) =>
  bytes
    .replace("line 2\n", "selected copy\n")
    .replace("line 55\n", "unselected copy\n");
const selectedCopy = (bytes: string) =>
  bytes.replace("line 2\n", "selected copy\n");
const originalEdit = (bytes: string) =>
  bytes.replace("line 59\n", "line 59\nselected original\n");

type Entry = { bytes: Buffer; executable: boolean };
type Tree = Record<string, Entry>;
const entry = (bytes: string, executable = false): Entry => ({
  bytes: Buffer.from(bytes),
  executable,
});

async function put(
  root: string,
  name: string,
  bytes: string,
  executable = false,
) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), bytes);
  await chmod(path.join(root, name), executable ? 0o755 : 0o644);
}

async function idAt(root: string, revision: string, template = "commit_id") {
  return (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      revision,
      "-T",
      template,
    ])
  ).stdout.trim();
}

async function treeAt(root: string, revision: string): Promise<Tree> {
  const listed = await jj(root, [
    "file",
    "list",
    "--ignore-working-copy",
    "-r",
    revision,
    "-T",
    'path ++ "\\t" ++ executable ++ "\\n"',
  ]);
  return Object.fromEntries(
    await Promise.all(
      listed.stdout
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map(async (line) => {
          const [name, executable] = line.split("\t");
          const result = await jj(root, [
            "file",
            "show",
            "--ignore-working-copy",
            "-r",
            revision,
            "--",
            `root-file:${JSON.stringify(name)}`,
          ]);
          return [
            name,
            {
              bytes: result.stdoutBytes ?? Buffer.from(result.stdout),
              executable: executable === "true",
            },
          ];
        }),
    ),
  );
}

async function workspaceAt(root: string): Promise<Tree> {
  const tree: Tree = {};
  async function visit(directory = "") {
    for (const item of await readdir(path.join(root, directory), {
      withFileTypes: true,
    })) {
      if (item.name === ".jj" || item.name === ".git") continue;
      const name = path.posix.join(directory, item.name);
      if (item.isDirectory()) await visit(name);
      else
        tree[name] = {
          bytes: await readFile(path.join(root, name)),
          executable: Boolean((await stat(path.join(root, name))).mode & 0o111),
        };
    }
  }
  await visit();
  return tree;
}

function copyPatch(destination: string) {
  const edited = destination === copied;
  return `diff --git a/${origin} b/${destination}
copy from ${origin}
copy to ${destination}
${
  edited
    ? `old mode 100644
new mode 100755
--- a/${origin}
+++ b/${destination}
@@ -2 +2 @@
-line 2
+selected copy
@@ -55 +55 @@
-line 55
+unselected copy
`
    : ""
}`;
}

async function fixture(t: test.TestContext, merge: boolean) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-copy-mode-targets-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await jj(root, ["git", "init", "--no-colocate"]);
  await jj(root, ["config", "set", "--repo", "user.name", "Copy Targets Test"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "copy-targets@example.com",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await put(root, origin, base);
  await put(root, script, "echo unchanged\n");
  await jj(root, ["commit", "-m", "Custom destination"]);
  const destination = await idAt(root, "@-");
  const leftBytes = base.replace("line 10\n", "inherited LEFT\n");
  await put(root, origin, leftBytes);
  await jj(root, ["describe", "-m", "Left or intermediate"]);
  const left = await idAt(root, "@");
  let baseline = leftBytes;
  let right: string | undefined;
  if (merge) {
    await jj(root, ["new", pinned(destination), "-m", "Right parent"]);
    await put(root, origin, base.replace("line 45\n", "inherited RIGHT\n"));
    await jj(root, ["describe", "-m", "Right parent"]);
    right = await idAt(root, "@");
    await jj(root, [
      "new",
      pinned(left),
      pinned(right),
      "-m",
      "Reviewed merge",
    ]);
    baseline = leftBytes.replace("line 45\n", "inherited RIGHT\n");
  } else {
    await jj(root, ["new", pinned(left), "-m", "Reviewed source"]);
  }
  await put(
    root,
    origin,
    (merge ? originalEdit(baseline) : baseline).replace(
      "line 32\n",
      "unselected original\n",
    ),
  );
  await put(root, copied, editedCopy(baseline), true);
  if (merge) await put(root, pureCopy, baseline);
  await chmod(path.join(root, script), 0o755);
  await jj(root, ["describe", "-m", "Copies and mode source"]);
  const sourceCommit = await idAt(root, "@");
  const sourceChange = await idAt(root, "@", "change_id");
  await jj(root, ["new", "-m", "Unrelated descendant workspace"]);
  await put(root, "workspace-only.txt", "do not change\n", true);
  await jj(root, ["describe", "-m", "Unrelated descendant workspace"]);
  const workspaceChange = await idAt(root, "@", "change_id");
  const reads: string[][] = [];
  const mutations: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    revision: `change_id("${sourceChange}")`,
    jjRunner: async (cwd, args, limits) => {
      reads.push(args);
      const result = await jj(cwd, args, limits);
      // jj currently emits additions for retained-source copies. Inject only
      // their validated display envelopes; all pinned bytes, merged-parent
      // capture, native editor, history rewriting and undo still use real jj.
      if (
        args[0] !== "diff" ||
        !args.includes("--git") ||
        args[args.indexOf("-r") + 1] !== pinned(sourceCommit)
      )
        return result;
      const stdout = result.stdout
        .split(/(?=^diff --git )/m)
        .map((section) => {
          for (const name of merge ? [copied, pureCopy] : [copied])
            if (section.startsWith(`diff --git a/${name} b/${name}\n`))
              return copyPatch(name);
          return section;
        })
        .join("");
      return { ...result, stdout, stdoutBytes: Buffer.from(stdout) };
    },
    toolRunner: (command, args, cwd) => {
      if (args[0] === "squash") mutations.push(args);
      return run(command, args, cwd);
    },
  });
  return {
    root,
    service,
    destination,
    left,
    right,
    baseline,
    workspaceChange,
    reads,
    mutations,
  };
}

function selections(state: State, merge: boolean) {
  const copy = state.files.find((file) => file.path === copied)!;
  assert.equal(copy.copyFrom, origin);
  assert.equal(copy.oldMode, "100644");
  assert.equal(copy.newMode, "100755");
  assert.equal(copy.squashUnsupported, undefined);
  const selected = [
    {
      id: copy.hunks[0].id,
      lines: copy.hunks[0].rows
        .filter((row) => /^[+-]/.test(row.raw))
        .map((row) => row.index),
    },
  ];
  const mode = state.files.find((file) => file.path === script)!;
  assert.deepEqual(mode.hunks, []);
  selected.push({ id: metadataSelectionId(mode)!, lines: [] });
  if (merge) {
    const pure = state.files.find((file) => file.path === pureCopy)!;
    assert.equal(pure.copyFrom, origin);
    assert.deepEqual(pure.hunks, []);
    selected.push({ id: metadataSelectionId(pure)!, lines: [] });
    const original = state.files.find((file) => file.path === origin)!;
    const hunk = original.hunks.find((hunk) =>
      hunk.rows.some((row) => row.raw === "+selected original"),
    )!;
    selected.push({
      id: hunk.id,
      lines: [hunk.rows.find((row) => row.raw === "+selected original")!.index],
    });
  }
  return selected;
}

for (const api of ["direct", "legacy"] as const) {
  for (const merge of [false, true]) {
    test(`${api} copy/mode squash from ${merge ? "merge with shared-origin batch" : "single parent"} to older ancestor uses source baseline and undoes exactly`, async (t) => {
      const data = await fixture(t, merge);
      const { root, service, baseline } = data;
      const initial = await service.getState();
      assert.equal(initial.squashUnavailable, undefined);
      if (merge) assert.equal(initial.parent, null);
      else assert.equal(initial.parent!.commitId, data.left);
      const target = initial.targets.find(
        (target) => target.commitId === data.destination,
      )!;
      assert.ok(target);
      assert.notEqual(target.commitId, data.left);
      assert.notEqual(target.commitId, data.right);
      const targetTree = await treeAt(root, pinned(target.commitId));
      const sourceTree = await treeAt(root, pinned(initial.source.commitId));
      const workspaceTree = await treeAt(root, "@");
      const workspace = await workspaceAt(root);
      const parents = await Promise.all(
        [data.left, data.right]
          .filter((id): id is string => !!id)
          .map(async (id) => [id, await treeAt(root, pinned(id))] as const),
      );
      const context = {
        oldFile: { name: origin, contents: baseline },
        newFile: { name: copied, contents: editedCopy(baseline) },
      };
      assert.notEqual(
        baseline,
        base,
        "the target must not masquerade as the copy baseline",
      );
      assert.deepEqual(
        await service.getFile({ version: initial.version, path: copied }),
        context,
      );
      assert.deepEqual(
        await service.getCommitFile({
          commitId: initial.source.commitId,
          path: copied,
        }),
        context,
      );
      if (merge) {
        assert.notEqual(baseline, parents[0][1][origin].bytes.toString());
        assert.notEqual(baseline, parents[1][1][origin].bytes.toString());
        const pureContext = {
          oldFile: { name: origin, contents: baseline },
          newFile: { name: pureCopy, contents: baseline },
        };
        assert.deepEqual(
          await service.getFile({ version: initial.version, path: pureCopy }),
          pureContext,
        );
        assert.deepEqual(
          await service.getCommitFile({
            commitId: initial.source.commitId,
            path: pureCopy,
          }),
          pureContext,
        );
      }
      const input = {
        version: initial.version,
        target: target.changeId,
        selections: selections(initial, merge),
      };
      const result =
        api === "direct"
          ? await service.squashLines(input)
          : await (async () => {
              const preview = await service.preview(input);
              assert.match(
                preview.patch,
                /copy from original\/source\[1\]:notes.sh/,
              );
              assert.match(preview.patch, /old mode 100644\nnew mode 100755/);
              assert.ok(!preview.patch.includes("+unselected copy"));
              assert.ok(!preview.patch.includes("+unselected original"));
              assert.equal(
                (await service.getState()).operation,
                initial.operation,
              );
              return service.squash(preview.token);
            })();
      assert.equal(result.warning, undefined);
      assert.equal(result.state.canUndo, true);
      assert.equal(result.state.source.changeId, initial.source.changeId);
      assert.equal(data.mutations.length, 1);
      const mutation = data.mutations[0];
      assert.equal(
        mutation[mutation.indexOf("--from") + 1],
        pinned(initial.source.commitId),
      );
      assert.equal(
        mutation[mutation.indexOf("--into") + 1],
        pinned(target.commitId),
      );
      assert.equal(
        mutation.includes(`root-file:${JSON.stringify(origin)}`),
        merge,
        "a retained copy origin is restricted only when independently selected",
      );
      const rewritten = result.state.targets.find(
        (item) => item.changeId === target.changeId,
      )!;
      assert.deepEqual(
        await treeAt(root, pinned(rewritten.commitId)),
        {
          ...targetTree,
          [origin]: entry(merge ? originalEdit(base) : base),
          [copied]: entry(selectedCopy(baseline), true),
          ...(merge ? { [pureCopy]: entry(baseline) } : {}),
          [script]: entry("echo unchanged\n", true),
        },
        "destination gets only selected delta and modes, retaining the original path",
      );
      assert.deepEqual(
        await treeAt(root, pinned(result.state.source.commitId)),
        sourceTree,
      );
      assert.deepEqual(await treeAt(root, "@"), workspaceTree);
      assert.deepEqual(await workspaceAt(root), workspace);
      assert.equal(await idAt(root, "@", "change_id"), data.workspaceChange);
      assert.match(
        result.state.files.find((file) => file.path === copied)!.patch,
        /\+unselected copy/,
      );
      assert.match(
        result.state.files.find((file) => file.path === origin)!.patch,
        /\+unselected original/,
      );
      assert.equal(
        result.state.files.find((file) => file.path === script),
        undefined,
      );
      if (merge) {
        assert.equal(
          result.state.files.find((file) => file.path === pureCopy),
          undefined,
        );
        const nativeReads = data.reads.filter(
          (args) => args[0] === "diff" && args.includes("--tool"),
        );
        assert.ok(
          nativeReads.length > 0,
          "real merged-parent reader must accept deduplicated shared origins",
        );
        for (const args of nativeReads) {
          assert.ok(args.includes("--ignore-working-copy"));
          assert.ok(args.includes(pinned(initial.source.commitId)));
        }
      }
      const undone = await service.undo(result.state.version);
      assert.equal(undone.state.canUndo, false);
      assert.equal(undone.state.source.commitId, initial.source.commitId);
      assert.deepEqual(undone.state.files, initial.files);
      assert.deepEqual(undone.state.targets, initial.targets);
      assert.deepEqual(await treeAt(root, pinned(target.commitId)), targetTree);
      assert.deepEqual(
        await treeAt(root, pinned(undone.state.source.commitId)),
        sourceTree,
      );
      for (const [id, tree] of parents)
        assert.deepEqual(await treeAt(root, pinned(id)), tree);
      assert.deepEqual(await treeAt(root, "@"), workspaceTree);
      assert.deepEqual(await workspaceAt(root), workspace);
    });
  }
}
