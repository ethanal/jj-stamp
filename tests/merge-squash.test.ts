import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ApiError, ReviewService, type State } from "../server/service.ts";
import { jj, ProcessError, run } from "../server/process.ts";

const pinned = (id: string) => `commit_id("${id}")`;
const change = (id: string) => `change_id("${id}")`;
const idAt = async (root: string, revision: string, template = "commit_id") =>
  (
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
const fileAt = async (root: string, revision: string, name = "shared.txt") =>
  (
    await jj(root, [
      "file",
      "show",
      "--ignore-working-copy",
      "-r",
      revision,
      "--",
      `root-file:${JSON.stringify(name)}`,
    ])
  ).stdout;

async function treeAt(root: string, revision: string) {
  const names = (
    await jj(root, ["file", "list", "--ignore-working-copy", "-r", revision])
  ).stdout
    .trimEnd()
    .split("\n")
    .filter(Boolean);
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [name, await fileAt(root, revision, name)]),
    ),
  );
}

async function workspaceAt(root: string) {
  const names = (await readdir(root)).filter((name) => name !== ".jj").sort();
  return Object.fromEntries(
    await Promise.all(
      names.map(async (name) => [
        name,
        await readFile(path.join(root, name), "utf8"),
      ]),
    ),
  );
}

async function fixture(t: TestContext, executable = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-merge-squash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await jj(root, ["git", "init", "--no-colocate"]);
  await jj(root, ["config", "set", "--repo", "user.name", "Merge Test"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "merge@example.com",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  const base = Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`).join("");
  await writeFile(path.join(root, "shared.txt"), base);
  if (executable) await chmod(path.join(root, "shared.txt"), 0o755);
  await writeFile(path.join(root, "delete.txt"), "delete me\n");
  await writeFile(path.join(root, "old.txt"), "rename me\n");
  await jj(root, ["commit", "-m", "Common mutable ancestor"]);
  const ancestor = await idAt(root, "@-");
  const leftBytes = base.replace("line 10\n", "inherited LEFT\n");
  await writeFile(path.join(root, "shared.txt"), leftBytes);
  await jj(root, ["describe", "-m", "Left parent"]);
  const left = await idAt(root, "@");
  await jj(root, ["new", pinned(ancestor), "-m", "Right parent"]);
  const rightBytes = base.replace("line 45\n", "inherited RIGHT\n");
  await writeFile(path.join(root, "shared.txt"), rightBytes);
  await jj(root, ["describe", "-m", "Right parent"]);
  const right = await idAt(root, "@");
  await jj(root, ["new", pinned(ancestor), "-m", "Unrelated branch"]);
  await writeFile(path.join(root, "outsider.txt"), "outsider\n");
  const outsider = await idAt(root, "@", "change_id");
  // Record the branch before leaving it; all fixture IDs are immutable snapshots.
  await jj(root, ["new", pinned(left), pinned(right), "-m", "Reviewed merge"]);
  const mergedBase = base
    .replace("line 10\n", "inherited LEFT\n")
    .replace("line 45\n", "inherited RIGHT\n");
  assert.equal(await fileAt(root, "@"), mergedBase);
  assert.notEqual(mergedBase, leftBytes);
  assert.notEqual(mergedBase, rightBytes);
  const sourceBytes = mergedBase
    .replace("line 1\n", "line 1\nselected addition\nunselected addition\n")
    .replace("line 60\n", "unselected tail\n");
  await writeFile(path.join(root, "shared.txt"), sourceBytes);
  await jj(root, ["describe", "-m", "Reviewed merge"]);
  const source = await idAt(root, "@", "change_id");
  // Review a non-@ merge while jj must preserve a descendant workspace too.
  await jj(root, ["new", "-m", "Workspace descendant"]);
  await writeFile(
    path.join(root, "workspace.txt"),
    "unrelated workspace contents\n",
  );
  await jj(root, ["describe", "-m", "Workspace descendant"]);
  const workspace = await idAt(root, "@", "change_id");
  return {
    root,
    base,
    ancestor,
    left,
    right,
    leftBytes,
    rightBytes,
    outsider,
    source,
    sourceBytes,
    mergedBase,
    workspace,
  };
}

function selected(state: State) {
  const file = state.files.find((file) => file.path === "shared.txt")!;
  const hunk = file.hunks.find((hunk) =>
    hunk.rows.some((row) => row.raw === "+selected addition"),
  )!;
  const row = hunk.rows.find((row) => row.raw === "+selected addition")!;
  return [{ id: hunk.id, lines: [row.index] }];
}

function rejectsCode(promise: Promise<unknown>, code: string, reason?: RegExp) {
  return assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    if (reason) assert.match(error.message, reason);
    return true;
  });
}

for (const api of ["direct", "legacy"] as const) {
  for (const side of ["left", "right"] as const) {
    test(`${api} merge squash into ${side}${side === "left" ? " (executable)" : ""}: merged baseline, exact selected delta, pinned single mutation and undo`, async (t) => {
      const executable = side === "left";
      const data = await fixture(t, executable);
      const { root } = data;
      const calls: string[][] = [];
      const reads: string[][] = [];
      const service = new ReviewService({
        repoPath: root,
        revision: change(data.source),
        jjRunner: (cwd, args, limits) => {
          reads.push(args);
          return jj(cwd, args, limits);
        },
        toolRunner: (command, args, cwd) => {
          calls.push(args);
          return run(command, args, cwd);
        },
      });
      const state = await service.getState();
      assert.equal(state.source.changeId, data.source);
      assert.notEqual(state.source.changeId, data.workspace);
      assert.equal(state.parent, null, "never invent a default merge parent");
      assert.equal(state.squashUnavailable, undefined);
      const target = state.targets.find(
        (target) => target.commitId === data[side],
      )!;
      const otherCommit = data[side === "left" ? "right" : "left"];
      assert.ok(target);
      assert.ok(
        state.targets.some((target) => target.commitId === data.ancestor),
      );
      assert.deepEqual(
        state.files.map((file) => file.path),
        ["shared.txt"],
      );
      assert.ok(!state.files[0].patch.includes("inherited LEFT"));
      assert.ok(!state.files[0].patch.includes("inherited RIGHT"));
      const sourceTree = await treeAt(root, pinned(state.source.commitId));
      const targetTree = await treeAt(root, pinned(target.commitId));
      const otherTree = await treeAt(root, pinned(otherCommit));
      const workspaceTree = await treeAt(root, "@");
      const workspace = await workspaceAt(root);
      const display = await service.getCommit({
        commitId: state.source.commitId,
      });
      assert.equal(display.baseCommitId, null);
      assert.deepEqual(display.files, state.files);
      const expectedContext = {
        oldFile: { name: "shared.txt", contents: data.mergedBase },
        newFile: { name: "shared.txt", contents: data.sourceBytes },
      };
      assert.deepEqual(
        await service.getFile({ version: state.version, path: "shared.txt" }),
        expectedContext,
      );
      assert.deepEqual(
        await service.getCommitFile({
          commitId: state.source.commitId,
          path: "shared.txt",
        }),
        expectedContext,
      );
      const input = {
        version: state.version,
        target: target.changeId,
        selections: selected(state),
      };
      const result =
        api === "direct"
          ? await service.squashLines(input)
          : await (async () => {
              const preview = await service.preview(input);
              assert.match(preview.patch, /\+selected addition/);
              assert.ok(!preview.patch.includes("+unselected addition"));
              assert.equal(
                (await service.getState()).operation,
                state.operation,
              );
              return service.squash(preview.token);
            })();
      assert.equal(result.warning, undefined);
      assert.equal(result.state.parent, null);
      assert.equal(result.state.canUndo, true);
      assert.equal(result.state.source.changeId, state.source.changeId);
      const mutations = calls.filter((args) => args[0] === "squash");
      assert.equal(mutations.length, 1);
      assert.equal(
        mutations[0][mutations[0].indexOf("--from") + 1],
        pinned(state.source.commitId),
      );
      assert.equal(
        mutations[0][mutations[0].indexOf("--into") + 1],
        pinned(target.commitId),
      );
      assert.ok(mutations[0].includes("--keep-emptied"));
      assert.ok(mutations[0].includes("--use-destination-message"));
      assert.ok(mutations[0].includes('root-file:"shared.txt"'));
      const nativeReads = reads.filter(
        (args) => args[0] === "diff" && args.includes("--tool"),
      );
      assert.ok(
        nativeReads.length > 0,
        "merged base must come from jj's native diff reader",
      );
      for (const args of nativeReads) {
        assert.ok(args.includes("--ignore-working-copy"));
        assert.ok(args.includes(pinned(state.source.commitId)));
      }
      const rewrittenTarget = result.state.targets.find(
        (revision) => revision.changeId === target.changeId,
      )!;
      if (executable) {
        for (const commitId of [
          rewrittenTarget.commitId,
          result.state.source.commitId,
        ]) {
          const modePatch = (
            await jj(root, [
              "diff",
              "--git",
              "--from",
              "root()",
              "--to",
              pinned(commitId),
              "--ignore-working-copy",
              "--",
              'root-file:"shared.txt"',
            ])
          ).stdout;
          assert.match(modePatch, /^new file mode 100755$/m);
        }
        assert.equal(
          (await stat(path.join(root, "shared.txt"))).mode & 0o777,
          0o755,
        );
      }
      assert.deepEqual(await treeAt(root, pinned(rewrittenTarget.commitId)), {
        ...targetTree,
        "shared.txt": targetTree["shared.txt"].replace(
          "line 1\n",
          "line 1\nselected addition\n",
        ),
      });
      assert.ok(
        result.state.targets.some(
          (revision) => revision.commitId === otherCommit,
        ),
        "the other parent commit is not rewritten",
      );
      assert.deepEqual(await treeAt(root, pinned(otherCommit)), otherTree);
      assert.deepEqual(
        await treeAt(root, pinned(result.state.source.commitId)),
        sourceTree,
      );
      assert.deepEqual(await treeAt(root, "@"), workspaceTree);
      assert.deepEqual(await workspaceAt(root), workspace);
      assert.equal(await idAt(root, "@", "change_id"), data.workspace);
      const remaining = result.state.files.find(
        (file) => file.path === "shared.txt",
      )!;
      assert.match(remaining.patch, /\+unselected addition/);
      assert.match(remaining.patch, /\+unselected tail/);
      assert.ok(!remaining.patch.includes("+selected addition"));
      const afterContext = await service.getFile({
        version: result.state.version,
        path: "shared.txt",
      });
      assert.equal(
        afterContext.oldFile!.contents,
        data.mergedBase.replace("line 1\n", "line 1\nselected addition\n"),
      );
      assert.equal(afterContext.newFile!.contents, data.sourceBytes);
      const undone = await service.undo(result.state.version);
      assert.deepEqual(undone.state.source, state.source);
      assert.deepEqual(undone.state.targets, state.targets);
      assert.deepEqual(undone.state.files, state.files);
      assert.equal(undone.state.parent, null);
      assert.equal(undone.state.canUndo, false);
      assert.deepEqual(await treeAt(root, pinned(target.commitId)), targetTree);
      assert.deepEqual(await treeAt(root, "@"), workspaceTree);
      assert.deepEqual(await workspaceAt(root), workspace);
      assert.equal(
        calls.filter((args) => args[0] === "squash").length,
        1,
        "undo never retries squash",
      );
    });
  }
}

for (const api of ["direct", "legacy"] as const) {
  test(`${api} merge source squashes forward into a descendant using the merged-parent baseline`, async (t) => {
    const data = await fixture(t);
    const service = new ReviewService({
      repoPath: data.root,
      revision: change(data.source),
    });
    const state = await service.getState();
    const target = state.targets.find(
      (target) => target.changeId === data.workspace,
    )!;
    assert.ok(target);
    assert.equal(state.parent, null);
    const workspace = await workspaceAt(data.root);
    const targetTree = await treeAt(data.root, change(data.workspace));
    const file = state.files.find((file) => file.path === "shared.txt")!;
    const hunk = file.hunks[0];
    // Move the complete insertion, leaving the separate tail edit behind.
    const input = {
      version: state.version,
      target: target.changeId,
      selections: [
        {
          id: hunk.id,
          lines: hunk.rows
            .filter((row) => row.raw.startsWith("+"))
            .map((row) => row.index),
        },
      ],
    };
    const result =
      api === "direct"
        ? await service.squashLines(input)
        : await service.squash((await service.preview(input)).token);
    assert.equal(result.warning, undefined);
    assert.equal(result.state.source.changeId, data.source);
    assert.equal(result.state.parent, null);
    assert.equal(
      await fileAt(data.root, change(data.source)),
      data.mergedBase.replace("line 60\n", "unselected tail\n"),
    );
    assert.equal(await fileAt(data.root, pinned(data.left)), data.leftBytes);
    assert.equal(await fileAt(data.root, pinned(data.right)), data.rightBytes);
    assert.deepEqual(
      await treeAt(data.root, change(data.workspace)),
      targetTree,
    );
    assert.deepEqual(await workspaceAt(data.root), workspace);
    assert.match(result.state.files[0].patch, /\+unselected tail/);
    assert.doesNotMatch(result.state.files[0].patch, /\+selected addition/);
    assert.deepEqual(
      await service.getFile({
        version: result.state.version,
        path: "shared.txt",
      }),
      {
        oldFile: { name: "shared.txt", contents: data.mergedBase },
        newFile: {
          name: "shared.txt",
          contents: data.mergedBase.replace("line 60\n", "unselected tail\n"),
        },
      },
    );
    const undone = await service.undo(result.state.version);
    assert.deepEqual(undone.state.source, state.source);
    assert.deepEqual(undone.state.targets, state.targets);
    assert.deepEqual(undone.state.files, state.files);
    assert.deepEqual(await workspaceAt(data.root), workspace);
  });
}

test("merge validation rejects missing, invalid, unrelated, immutable and stale destinations without mutation or fallback", async (t) => {
  const data = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: data.root,
    revision: change(data.source),
    toolRunner: (command, args, cwd) => {
      calls.push(args);
      return run(command, args, cwd);
    },
  });
  const state = await service.getState();
  const selections = selected(state);
  await rejectsCode(
    service.squashLines({ version: state.version, selections }),
    "SQUASH_UNAVAILABLE",
    /explicit|choose|destination/i,
  );
  assert.deepEqual(await service.getState(), state);
  assert.ok(
    state.targets.some((target) => target.changeId === data.workspace),
    "the mutable workspace descendant is now an eligible destination",
  );
  for (const target of [
    data.source,
    data.outsider,
    "k".repeat(64),
    state.targets[0].changeId.slice(0, 8),
  ]) {
    for (const api of ["direct", "legacy"]) {
      const input = { version: state.version, selections, target };
      await rejectsCode(
        api === "direct" ? service.squashLines(input) : service.preview(input),
        "INVALID_TARGET",
      );
      assert.deepEqual(await service.getState(), state);
    }
  }
  const ancestor = state.targets.find(
    (target) => target.commitId === data.ancestor,
  )!;
  await jj(data.root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    pinned(data.ancestor),
  ]);
  await rejectsCode(
    service.squashLines({
      version: state.version,
      selections,
      target: ancestor.changeId,
    }),
    "STALE_STATE",
  );
  const current = await service.getState();
  assert.equal(
    current.operation,
    state.operation,
    "mutability-only changes also invalidate versions",
  );
  assert.equal(current.parent, null);
  assert.equal(
    current.squashUnavailable,
    undefined,
    "mutable parents remain eligible",
  );
  assert.ok(
    !current.targets.some((target) => target.changeId === ancestor.changeId),
  );
  for (const api of ["direct", "legacy"]) {
    const input = {
      version: current.version,
      selections: selected(current),
      target: ancestor.changeId,
    };
    await rejectsCode(
      api === "direct" ? service.squashLines(input) : service.preview(input),
      "INVALID_TARGET",
    );
  }
  const target = current.targets.find(
    (target) => target.commitId === data.left,
  )!;
  const token = (
    await service.preview({
      version: current.version,
      selections: selected(current),
      target: target.changeId,
    })
  ).token;
  await jj(data.root, [
    "describe",
    "-r",
    change(data.source),
    "-m",
    "Externally rewritten merge",
  ]);
  await rejectsCode(
    service.squashLines({
      version: current.version,
      selections: selected(current),
      target: target.changeId,
    }),
    "STALE_STATE",
  );
  await rejectsCode(service.squash(token), "STALE_STATE");
  assert.equal(calls.filter((args) => args[0] === "squash").length, 0);
  const final = await service.getState();
  assert.equal(final.source.changeId, data.source);
  assert.notEqual(final.source.commitId, current.source.commitId);
  assert.equal(final.canUndo, false);
});

test("merge native squash failure executes once and never falls back to another parent", async (t) => {
  const data = await fixture(t);
  const mutations: string[][] = [];
  const service = new ReviewService({
    repoPath: data.root,
    revision: change(data.source),
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "squash") {
        mutations.push(args);
        throw new ProcessError(
          command,
          args,
          { stdout: "", stderr: "injected pre-write failure" },
          1,
        );
      }
      return run(command, args, cwd);
    },
  });
  const state = await service.getState();
  const target = state.targets.find(
    (target) => target.commitId === data.right,
  )!;
  await rejectsCode(
    service.squashLines({
      version: state.version,
      target: target.changeId,
      selections: selected(state),
    }),
    "TOOL_FAILED",
  );
  assert.equal(mutations.length, 1);
  assert.equal(
    mutations[0][mutations[0].indexOf("--into") + 1],
    pinned(target.commitId),
  );
  assert.deepEqual(await service.getState(), state);
  assert.equal(mutations.length, 1);
});

test("merge selected add/delete/rename paths squash into an older ancestor with merged context and exact undo", async (t) => {
  const data = await fixture(t);
  await jj(data.root, ["edit", change(data.source)]);
  await writeFile(path.join(data.root, "added[1].txt"), "selected new file\n");
  await rm(path.join(data.root, "delete.txt"));
  await rename(
    path.join(data.root, "old.txt"),
    path.join(data.root, "renamed.txt"),
  );
  await jj(data.root, ["describe", "-m", "Merge with path changes"]);
  const service = new ReviewService({
    repoPath: data.root,
    revision: change(data.source),
  });
  const state = await service.getState();
  const target = state.targets.find(
    (target) => target.commitId === data.ancestor,
  )!;
  const original = await treeAt(data.root, pinned(state.source.commitId));
  const beforeWorkspace = await workspaceAt(data.root);
  const selections = state.files
    .filter((file) => file.path !== "shared.txt")
    .flatMap((file) => {
      assert.equal(file.unsupported, undefined);
      if (file.oldPath) {
        assert.equal(file.oldPath, "old.txt");
        assert.deepEqual(file.hunks, []);
        return [
          {
            id: `rename:${JSON.stringify([file.oldPath, file.path])}`,
            lines: [] as number[],
          },
        ];
      }
      return file.hunks.map((hunk) => ({
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      }));
    });
  assert.equal(selections.length, 3);
  for (const name of ["added[1].txt", "delete.txt", "renamed.txt"]) {
    const live = await service.getFile({ version: state.version, path: name });
    const immutable = await service.getCommitFile({
      commitId: state.source.commitId,
      path: name,
    });
    assert.deepEqual(live, immutable);
    if (name === "added[1].txt") assert.equal(live.oldFile, null);
    if (name === "delete.txt") assert.equal(live.newFile, null);
    if (name === "renamed.txt") assert.equal(live.oldFile!.name, "old.txt");
  }
  const result = await service.squashLines({
    version: state.version,
    target: target.changeId,
    selections,
  });
  assert.equal(result.warning, undefined);
  assert.deepEqual(
    result.state.files.map((file) => file.path),
    ["shared.txt"],
  );
  const rewrittenTarget = result.state.targets.find(
    (revision) => revision.changeId === target.changeId,
  )!;
  assert.deepEqual(await treeAt(data.root, pinned(rewrittenTarget.commitId)), {
    "shared.txt": data.base,
    "added[1].txt": "selected new file\n",
    "renamed.txt": "rename me\n",
  });
  assert.deepEqual(
    await treeAt(data.root, pinned(result.state.source.commitId)),
    original,
  );
  assert.deepEqual(await workspaceAt(data.root), beforeWorkspace);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.source, state.source);
  assert.deepEqual(undone.state.targets, state.targets);
  assert.deepEqual(undone.state.files, state.files);
  assert.deepEqual(await workspaceAt(data.root), beforeWorkspace);
});

test("resolved merge conflict squashes a full resolution hunk against native marker bytes and undoes exactly", async (t) => {
  const data = await fixture(t);
  const { root } = data;
  await jj(root, ["edit", pinned(data.left)]);
  const leftBytes = data.leftBytes.replace(
    "line 25\n",
    "LEFT conflict choice\n",
  );
  await writeFile(path.join(root, "shared.txt"), leftBytes);
  await jj(root, ["describe", "-m", "Left parent with conflict"]);
  const leftCommit = await idAt(root, "@");
  await jj(root, ["edit", pinned(data.right)]);
  const rightBytes = data.rightBytes.replace(
    "line 25\n",
    "RIGHT conflict choice\n",
  );
  await writeFile(path.join(root, "shared.txt"), rightBytes);
  await jj(root, ["describe", "-m", "Right parent with conflict"]);
  const rightCommit = await idAt(root, "@");
  // An untouched native merge exposes exactly jj's materialized parent tree,
  // including its conflict-marker format, without guessing those bytes.
  await jj(root, [
    "new",
    pinned(leftCommit),
    pinned(rightCommit),
    "-m",
    "Native conflicted baseline",
  ]);
  const markerBase = await fileAt(root, "@");
  assert.match(markerBase, /<<<<<<< conflict/i);
  assert.match(markerBase, /LEFT conflict choice/);
  assert.match(markerBase, /RIGHT conflict choice/);
  assert.match(markerBase, /inherited LEFT/);
  assert.match(markerBase, /inherited RIGHT/);
  await jj(root, ["edit", change(data.source)]);
  const resolvedSource = data.sourceBytes.replace(
    "line 25\n",
    "selected conflict resolution\n",
  );
  await writeFile(path.join(root, "shared.txt"), resolvedSource);
  await jj(root, ["describe", "-m", "Resolved reviewed merge"]);
  await jj(root, ["edit", change(data.workspace)]);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    revision: change(data.source),
    toolRunner: (command, args, cwd) => {
      calls.push(args);
      return run(command, args, cwd);
    },
  });
  const state = await service.getState();
  assert.equal(state.parent, null);
  assert.equal(state.squashUnavailable, undefined);
  assert.notEqual(state.source.changeId, data.workspace);
  const target = state.targets.find(
    (target) => target.commitId === leftCommit,
  )!;
  assert.ok(target);
  const sourceTree = await treeAt(root, pinned(state.source.commitId));
  const otherTree = await treeAt(root, pinned(rightCommit));
  const workspaceTree = await treeAt(root, "@");
  const workspace = await workspaceAt(root);
  const expectedContext = {
    oldFile: { name: "shared.txt", contents: markerBase },
    newFile: { name: "shared.txt", contents: resolvedSource },
  };
  assert.deepEqual(
    await service.getFile({ version: state.version, path: "shared.txt" }),
    expectedContext,
  );
  assert.deepEqual(
    await service.getCommitFile({
      commitId: state.source.commitId,
      path: "shared.txt",
    }),
    expectedContext,
  );
  const resolution = state.files[0].hunks.find((hunk) =>
    hunk.rows.some((row) => row.raw === "+selected conflict resolution"),
  )!;
  assert.ok(resolution);
  assert.ok(
    resolution.rows.some((row) => /^-<<<<<<< conflict/i.test(row.raw)),
    "the selected resolution replaces native merged-parent conflict markers",
  );
  const result = await service.squashLines({
    version: state.version,
    target: target.changeId,
    selections: [
      {
        id: resolution.id,
        lines: resolution.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      },
    ],
  });
  const rewrittenTarget = result.state.targets.find(
    (revision) => revision.changeId === target.changeId,
  )!;
  const targetBytes = await fileAt(root, pinned(rewrittenTarget.commitId));
  // Native jj subtracts the other parent's choice when moving a resolution
  // into just one parent. The selected value arrives as a conflict term, not
  // necessarily as a clean destination file. Ignore only provenance labels.
  const selectedConflict =
    /<<<<<<< conflict 1 of 1\n\+{7} selected changes for squash [^\n]+\nselected conflict resolution\n%{7} diff from: [^\n]+\n\\{7} +to: [^\n]+\n-RIGHT conflict choice\n\+line 25\n>>>>>>> conflict 1 of 1 ends\n/;
  assert.match(targetBytes, selectedConflict);
  assert.equal(
    targetBytes.replace(selectedConflict, "selected conflict resolution\n"),
    leftBytes.replace(
      "LEFT conflict choice\n",
      "selected conflict resolution\n",
    ),
    "the destination contains only the selected resolution conflict, not other source or inherited edits",
  );
  assert.ok(
    result.state.targets.some((revision) => revision.commitId === rightCommit),
  );
  assert.deepEqual(await treeAt(root, pinned(rightCommit)), otherTree);
  assert.deepEqual(
    await treeAt(root, pinned(result.state.source.commitId)),
    sourceTree,
  );
  assert.deepEqual(await treeAt(root, "@"), workspaceTree);
  assert.deepEqual(await workspaceAt(root), workspace);
  assert.equal(result.state.canUndo, true);
  const remaining = result.state.files.find(
    (file) => file.path === "shared.txt",
  )!;
  assert.match(remaining.patch, /\+unselected addition/);
  assert.match(remaining.patch, /\+unselected tail/);
  assert.match(remaining.patch, /\+selected addition/);
  // Pin the observed native outcome, rather than assuming that a newly
  // conflicted destination also leaves the source resolution in its diff.
  const resolutionRemains = remaining.hunks.some((hunk) =>
    hunk.rows.some((row) => row.raw === "+selected conflict resolution"),
  );
  t.diagnostic(
    `Native resolved-merge outcome: resolution remains=${resolutionRemains}; warning=${JSON.stringify(result.warning ?? null)}`,
  );
  assert.equal(resolutionRemains, false);
  assert.match(result.warning!, /squash created a conflict/);
  assert.equal(result.state.squashUnavailable, undefined);
  assert.equal(
    (
      await service.getFile({
        version: result.state.version,
        path: "shared.txt",
      })
    ).oldFile!.contents,
    data.mergedBase.replace("line 25\n", "selected conflict resolution\n"),
    "native parent-tree algebra absorbs the resolution despite the conflicted destination",
  );
  const mutations = calls.filter((args) => args[0] === "squash");
  assert.equal(mutations.length, 1);
  assert.equal(
    mutations[0][mutations[0].indexOf("--from") + 1],
    pinned(state.source.commitId),
  );
  assert.equal(
    mutations[0][mutations[0].indexOf("--into") + 1],
    pinned(target.commitId),
  );
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.source, state.source);
  assert.deepEqual(undone.state.targets, state.targets);
  assert.deepEqual(undone.state.files, state.files);
  assert.equal(await fileAt(root, pinned(leftCommit)), leftBytes);
  assert.deepEqual(await treeAt(root, "@"), workspaceTree);
  assert.deepEqual(await workspaceAt(root), workspace);
});
