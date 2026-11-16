import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";
import { createApi } from "../server/api.ts";
import { ApiError, ReviewService, type State } from "../server/service.ts";
import { jj, run } from "../server/process.ts";

async function fixture(t: TestContext, intermediatePath = "a.txt") {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-custom-squash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await jj(root, ["git", "init", "--no-colocate"]);
  await jj(root, ["config", "set", "--repo", "user.name", "Custom Test"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "custom@example.com",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  const base = Array.from({ length: 50 }, (_, i) => `line ${i + 1}\n`).join("");
  await writeFile(path.join(root, "a.txt"), base);
  if (intermediatePath !== "a.txt")
    await writeFile(path.join(root, intermediatePath), base);
  await jj(root, ["commit", "-m", "Destination"]);
  const middle = base.replace("line 25\n", "intermediate edit\n");
  await writeFile(path.join(root, intermediatePath), middle);
  await jj(root, ["commit", "-m", "Intermediate"]);
  const source = (intermediatePath === "a.txt" ? middle : base)
    .replace("line 1\n", "line 1\nselected addition\nunselected addition\n")
    .replace("line 50\n", "unselected tail\n");
  await writeFile(path.join(root, "a.txt"), source);
  await jj(root, ["describe", "-m", "Source"]);
  const service = new ReviewService({ repoPath: root });
  const state = await service.getState();
  return { root, service, state, base, middle, source };
}
function request(state: State) {
  const hunk = state.files[0].hunks[0];
  const row = hunk.rows.find((row) => row.raw === "+selected addition")!;
  assert.ok(row);
  return {
    version: state.version,
    target: state.targets[1].changeId,
    selections: [{ id: hunk.id, lines: [row.index] }],
  };
}
const fileAt = async (root: string, revision: string) =>
  (
    await jj(root, [
      "file",
      "show",
      "--ignore-working-copy",
      "-r",
      revision,
      "a.txt",
    ])
  ).stdout;
const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );

async function treeAt(root: string, commitId: string) {
  const revision = `commit_id("${commitId}")`;
  const listed = await jj(root, [
    "file",
    "list",
    "--ignore-working-copy",
    "-r",
    revision,
  ]);
  const tree: Record<string, Buffer> = {};
  for (const name of listed.stdout.trimEnd().split("\n").filter(Boolean)) {
    const result = await jj(root, [
      "file",
      "show",
      "--ignore-working-copy",
      "-r",
      revision,
      "--",
      `root-file:${JSON.stringify(name)}`,
    ]);
    tree[name] = result.stdoutBytes ?? Buffer.from(result.stdout);
  }
  return tree;
}

test("custom ancestor rename squash moves selected edits and mixed ordinary rows, preserves every tree and undoes exactly", async (t) => {
  for (const api of ["direct", "legacy"] as const)
    for (const scope of ["partial", "all", "pure"] as const)
      await t.test(`${api}, ${scope} rename selection`, async (t) => {
        // A disjoint intermediate edit survives rebasing the rename. Editing the
        // old path itself can legitimately create a jj delete/modify conflict.
        const { root, base, middle, source } = await fixture(
          t,
          "intermediate.txt",
        );
        const oldPath = "a.txt";
        const newPath = "renamed[1]:a.txt";
        if (scope === "pure") await writeFile(path.join(root, oldPath), base);
        await rename(path.join(root, oldPath), path.join(root, newPath));
        await writeFile(
          path.join(root, "regular.txt"),
          "selected ordinary\nunselected ordinary\n",
        );
        await jj(root, ["describe", "-m", "Rename source with mixed edits"]);
        const calls: string[][] = [];
        const service = new ReviewService({
          repoPath: root,
          toolRunner: (command, args, cwd) => {
            calls.push(args);
            return run(command, args, cwd);
          },
        });
        const state = await service.getState();
        const target = state.targets[1];
        assert.notEqual(target.changeId, state.parent!.changeId);
        const originalTarget = await treeAt(root, target.commitId);
        const originalParent = await treeAt(root, state.parent!.commitId);
        const originalSource = await treeAt(root, state.source.commitId);
        assert.deepEqual(originalTarget, {
          [oldPath]: Buffer.from(base),
          "intermediate.txt": Buffer.from(base),
        });
        assert.deepEqual(originalParent, {
          [oldPath]: Buffer.from(base),
          "intermediate.txt": Buffer.from(middle),
        });
        const renamed = state.files.find((file) => file.path === newPath)!;
        assert.ok(renamed, "fixture must exercise real jj rename detection");
        assert.equal(renamed.oldPath, oldPath);
        assert.equal(renamed.unsupported, undefined);
        assert.equal(renamed.squashUnsupported, undefined);
        assert.equal(renamed.hunks.length, scope === "pure" ? 0 : 2);
        const selected = renamed.hunks.flatMap((hunk) => {
          const lines = hunk.rows
            .filter((row) =>
              scope === "all"
                ? /^[+-]/.test(row.raw)
                : row.raw === "+selected addition",
            )
            .map((row) => row.index);
          return lines.length ? [{ id: hunk.id, lines }] : [];
        });
        if (scope === "pure")
          selected.push({
            id: `rename:${JSON.stringify([oldPath, newPath])}`,
            lines: [],
          });
        assert.equal(selected.length, scope === "all" ? 2 : 1);
        const ordinary = state.files.find(
          (file) => file.path === "regular.txt",
        )!.hunks[0];
        const ordinaryRow = ordinary.rows.find(
          (row) => row.raw === "+selected ordinary",
        )!;
        assert.ok(ordinaryRow);
        const input = {
          version: state.version,
          target: target.changeId,
          selections: [
            ...selected,
            { id: ordinary.id, lines: [ordinaryRow.index] },
          ],
        };
        const result =
          api === "direct"
            ? await service.squashLines(input)
            : await (async () => {
                const preview = await service.preview(input);
                assert.ok(preview.patch.includes(`rename from ${oldPath}\n`));
                assert.ok(preview.patch.includes(`rename to ${newPath}\n`));
                if (scope === "partial") {
                  assert.ok(!preview.patch.includes("+unselected addition"));
                  assert.ok(!preview.patch.includes("+unselected tail"));
                }
                assert.equal(
                  (await service.getState()).operation,
                  state.operation,
                );
                return service.squash(preview.token);
              })();
        assert.equal(result.warning, undefined);
        assert.equal(result.state.canUndo, true);
        assert.equal(result.state.source.changeId, state.source.changeId);
        assert.equal(result.state.parent!.changeId, state.parent!.changeId);
        assert.equal(result.state.targets[1].changeId, target.changeId);
        const mutations = calls.filter((args) => args[0] === "squash");
        assert.equal(mutations.length, 1);
        const mutation = mutations[0];
        assert.equal(
          mutation[mutation.indexOf("--from") + 1],
          `commit_id("${state.source.commitId}")`,
        );
        assert.equal(
          mutation[mutation.indexOf("--into") + 1],
          `commit_id("${target.commitId}")`,
        );
        for (const name of [oldPath, newPath, "regular.txt"])
          assert.ok(mutation.includes(`root-file:${JSON.stringify(name)}`));
        const selectedContents = (contents: string) =>
          scope === "pure"
            ? contents
            : contents
                .replace(
                  "line 1\n",
                  scope === "all"
                    ? "line 1\nselected addition\nunselected addition\n"
                    : "line 1\nselected addition\n",
                )
                .replace(
                  "line 50\n",
                  scope === "all" ? "unselected tail\n" : "line 50\n",
                );
        assert.deepEqual(await treeAt(root, result.state.targets[1].commitId), {
          [newPath]: Buffer.from(selectedContents(base)),
          "intermediate.txt": Buffer.from(base),
          "regular.txt": Buffer.from("selected ordinary\n"),
        });
        assert.deepEqual(await treeAt(root, result.state.parent!.commitId), {
          [newPath]: Buffer.from(selectedContents(base)),
          "intermediate.txt": Buffer.from(middle),
          "regular.txt": Buffer.from("selected ordinary\n"),
        });
        assert.deepEqual(
          await treeAt(root, result.state.source.commitId),
          originalSource,
        );
        const retained = result.state.files.find(
          (file) => file.path === newPath,
        );
        if (scope !== "partial") assert.equal(retained, undefined);
        else {
          assert.ok(retained);
          assert.equal(retained.oldPath, undefined);
          assert.ok(retained.patch.includes("+unselected addition"));
          assert.ok(retained.patch.includes("+unselected tail"));
          assert.ok(!retained.patch.includes("+selected addition"));
          assert.deepEqual(
            await service.getFile({
              version: result.state.version,
              path: newPath,
            }),
            {
              oldFile: { name: newPath, contents: selectedContents(base) },
              newFile: { name: newPath, contents: source },
            },
          );
        }
        const remainingOrdinary = result.state.files.find(
          (file) => file.path === "regular.txt",
        )!;
        assert.ok(remainingOrdinary.patch.includes("+unselected ordinary"));
        assert.ok(!remainingOrdinary.patch.includes("+selected ordinary"));
        const assertWorkspace = async () => {
          assert.deepEqual(
            (await readdir(root)).filter((name) => name !== ".jj").sort(),
            Object.keys(originalSource).sort(),
          );
          for (const [name, bytes] of Object.entries(originalSource))
            assert.deepEqual(
              await readFile(path.join(root, name)),
              bytes,
              name,
            );
          await assert.rejects(readFile(path.join(root, oldPath)), {
            code: "ENOENT",
          });
        };
        await assertWorkspace();
        const undone = await service.undo(result.state.version);
        assert.equal(undone.state.canUndo, false);
        assert.deepEqual(undone.state.source, state.source);
        assert.deepEqual(undone.state.parent, state.parent);
        assert.deepEqual(undone.state.targets, state.targets);
        assert.deepEqual(undone.state.files, state.files);
        assert.deepEqual(
          await treeAt(root, undone.state.targets[1].commitId),
          originalTarget,
        );
        assert.deepEqual(
          await treeAt(root, undone.state.parent!.commitId),
          originalParent,
        );
        assert.deepEqual(
          await treeAt(root, undone.state.source.commitId),
          originalSource,
        );
        await assertWorkspace();
      });
});

test("custom ancestor rename squash warns on an intervening old-path edit and still undoes exactly", async (t) => {
  const { root, source } = await fixture(t);
  const newPath = "renamed.txt";
  await rename(path.join(root, "a.txt"), path.join(root, newPath));
  await jj(root, ["describe", "-m", "Rename across an old-path edit"]);
  const service = new ReviewService({ repoPath: root });
  const state = await service.getState();
  const target = state.targets[1];
  const originalTarget = await treeAt(root, target.commitId);
  const originalParent = await treeAt(root, state.parent!.commitId);
  const originalSource = await treeAt(root, state.source.commitId);
  const renamed = state.files.find((file) => file.path === newPath)!;
  assert.equal(renamed.oldPath, "a.txt");
  const hunk = renamed.hunks.find((hunk) =>
    hunk.rows.some((row) => row.raw === "+selected addition"),
  )!;
  const row = hunk.rows.find((row) => row.raw === "+selected addition")!;
  const result = await service.squashLines({
    version: state.version,
    target: target.changeId,
    selections: [{ id: hunk.id, lines: [row.index] }],
  });
  assert.match(result.warning!, /created a conflict/);
  assert.equal(result.state.canUndo, true);
  assert.equal(result.state.source.changeId, state.source.changeId);
  assert.equal(result.state.parent!.changeId, state.parent!.changeId);
  assert.equal(
    (
      await jj(root, [
        "log",
        "--no-graph",
        "--ignore-working-copy",
        "-r",
        `change_id("${target.changeId}")`,
        "-T",
        "conflict",
      ])
    ).stdout.trim(),
    "true",
  );
  assert.deepEqual(
    await treeAt(root, result.state.source.commitId),
    originalSource,
  );
  assert.equal(await readFile(path.join(root, newPath), "utf8"), source);
  await assert.rejects(readFile(path.join(root, "a.txt")), { code: "ENOENT" });
  const undone = await service.undo(result.state.version);
  assert.equal(undone.state.canUndo, false);
  assert.deepEqual(undone.state.source, state.source);
  assert.deepEqual(undone.state.parent, state.parent);
  assert.deepEqual(undone.state.targets, state.targets);
  assert.deepEqual(undone.state.files, state.files);
  assert.deepEqual(
    await treeAt(root, undone.state.targets[1].commitId),
    originalTarget,
  );
  assert.deepEqual(
    await treeAt(root, undone.state.parent!.commitId),
    originalParent,
  );
  assert.deepEqual(
    await treeAt(root, undone.state.source.commitId),
    originalSource,
  );
  assert.deepEqual((await readdir(root)).sort(), [".jj", newPath].sort());
  assert.equal(await readFile(path.join(root, newPath), "utf8"), source);
  await assert.rejects(readFile(path.join(root, "a.txt")), { code: "ENOENT" });
});

for (const api of ["direct", "legacy", "http"] as const) {
  test(`${api} custom destination preserves intermediate edits, unselected rows, source identity and exact undo`, async (t) => {
    const { root, service, state, base, middle, source } = await fixture(t);
    const input = request(state);
    let result: { state: State; warning?: string };
    if (api === "legacy") {
      const preview = await service.preview(input);
      result = await service.squash(preview.token);
    } else if (api === "http") {
      const app = express();
      app.use("/api", createApi(service));
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      const response = await fetch(
        `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/squash-lines`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      );
      assert.equal(response.status, 200);
      result = await response.json();
    } else result = await service.squashLines(input);
    assert.equal(result.warning, undefined);
    assert.equal(result.state.source.changeId, state.source.changeId);
    assert.equal(result.state.parent!.changeId, state.parent!.changeId);
    assert.equal(result.state.targets[1].changeId, input.target);
    assert.notEqual(
      result.state.targets[1].commitId,
      state.targets[1].commitId,
    );
    assert.equal(
      await fileAt(root, "@--"),
      base.replace("line 1\n", "line 1\nselected addition\n"),
    );
    assert.equal(
      await fileAt(root, "@-"),
      middle.replace("line 1\n", "line 1\nselected addition\n"),
    );
    assert.equal(await fileAt(root, "@"), source);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), source);
    assert.ok(
      result.state.files[0].hunks
        .flatMap((hunk) => hunk.rows)
        .some((row) => row.raw === "+unselected addition"),
    );
    assert.ok(
      !result.state.files[0].hunks
        .flatMap((hunk) => hunk.rows)
        .some((row) => row.raw === "+selected addition"),
    );
    assert.equal(result.state.canUndo, true);
    const undone = await service.undo(result.state.version);
    assert.deepEqual(undone.state.source, state.source);
    assert.deepEqual(undone.state.targets, state.targets);
    assert.deepEqual(undone.state.files, state.files);
    assert.equal(await fileAt(root, "@--"), base);
    assert.equal(await fileAt(root, "@-"), middle);
    assert.equal(await readFile(path.join(root, "a.txt"), "utf8"), source);
  });
}

test("custom destinations require exact eligible ancestor IDs, never expressions, prefixes or fallback", async (t) => {
  const { root, state } = await fixture(t);
  await jj(root, ["new", state.source.commitId, "-m", "Descendant"]);
  const descendant = (
    await jj(root, ["log", "--no-graph", "-r", "@", "-T", "change_id"])
  ).stdout.trim();
  await jj(root, ["new", state.targets[1].commitId, "-m", "Sibling"]);
  const sibling = (
    await jj(root, ["log", "--no-graph", "-r", "@", "-T", "change_id"])
  ).stdout.trim();
  const service = new ReviewService({
    repoPath: root,
    revision: state.source.changeId,
    toolRunner: async () => {
      assert.fail("invalid target must not mutate");
    },
  });
  const current = await service.getState();
  for (const target of [
    current.source.changeId,
    current.targets[1].changeId.slice(0, 8),
    "z".repeat(32),
    sibling,
    descendant,
    "z".repeat(1),
  ]) {
    await rejectsCode(
      service.squashLines({ ...request(current), target }),
      "INVALID_TARGET",
    );
  }
  for (const target of ["@--", "root()", "", null, 3]) {
    await rejectsCode(
      service.squashLines({ ...request(current), target } as ReturnType<
        typeof request
      >),
      "INVALID_REQUEST",
    );
  }
  assert.equal((await service.getState()).operation, current.operation);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    current.targets[1].commitId,
  ]);
  const restricted = await service.getState();
  assert.equal(restricted.parent!.changeId, current.parent!.changeId);
  await rejectsCode(
    service.squashLines({ ...request(current), version: restricted.version }),
    "INVALID_TARGET",
  );
});

test("rewriting a fixed custom destination invalidates old versions but preserves its change identity", async (t) => {
  const { root, service, state } = await fixture(t);
  const input = request(state);
  await jj(root, [
    "describe",
    "-r",
    input.target,
    "-m",
    "Rewritten destination",
  ]);
  const operation = (await service.getState()).operation;
  await rejectsCode(service.squashLines(input), "STALE_STATE");
  assert.equal((await service.getState()).operation, operation);
  const current = await service.getState();
  assert.equal(current.targets[1].changeId, input.target);
  assert.notEqual(current.targets[1].commitId, state.targets[1].commitId);
  const result = await service.squashLines({
    ...request(current),
    target: input.target,
  });
  assert.equal(result.state.targets[1].changeId, input.target);
});

test("an abandoned custom destination is rejected instead of silently using Parent", async (t) => {
  const { root, service, state, source } = await fixture(t);
  const input = request(state);
  await jj(root, ["abandon", input.target]);
  await rejectsCode(service.squashLines(input), "STALE_STATE");
  // Abandoning the revision that introduced the file causes rebase conflicts.
  // Resolve the source explicitly; this must not restore the vanished target.
  await writeFile(path.join(root, "a.txt"), source);
  const current = await service.getState();
  const hunk = current.files[0].hunks[0];
  await rejectsCode(
    service.squashLines({
      version: current.version,
      target: input.target,
      selections: [
        {
          id: hunk.id,
          lines: hunk.rows
            .filter((row) => /^[+-]/.test(row.raw))
            .map((row) => row.index),
        },
      ],
    }),
    "INVALID_TARGET",
  );
  assert.equal((await service.getState()).operation, current.operation);
});

test("custom target conflict eligibility changes during preparation reject before mutation", async (t) => {
  const { root, state } = await fixture(t);
  let injected = false;
  let mutations = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (!injected && args[0] === "file" && args[1] === "show") {
        injected = true;
        await jj(root, [
          "config",
          "set",
          "--repo",
          'revset-aliases."conflicts()"',
          `change_id("${state.targets[1].changeId}")`,
        ]);
      }
      return result;
    },
    toolRunner: async (command, args, cwd) => {
      mutations++;
      return run(command, args, cwd);
    },
  });
  await rejectsCode(service.squashLines(request(state)), "STALE_STATE");
  assert.equal(injected, true);
  assert.equal(mutations, 0);
  const current = await service.getState();
  assert.equal(
    current.operation,
    state.operation,
    "configuration-only race has no operation change",
  );
  assert.equal(current.parent!.changeId, state.parent!.changeId);
  assert.equal(
    current.targets.some(
      (target) => target.changeId === state.targets[1].changeId,
    ),
    false,
  );
  await rejectsCode(
    service.squashLines({ ...request(state), version: current.version }),
    "INVALID_TARGET",
  );
});

test("a custom ancestor with another divergent visible revision is not an eligible destination", async (t) => {
  const { root, state } = await fixture(t);
  const target = state.targets[1];
  await jj(root, [
    "describe",
    "-r",
    target.commitId,
    "-m",
    "First destination rewrite",
  ]);
  await jj(root, [
    "--at-operation",
    state.operation,
    "describe",
    "-r",
    target.commitId,
    "-m",
    "Concurrent destination rewrite",
  ]);
  await jj(root, ["status"]);
  const commits = (
    await jj(root, [
      "log",
      "--no-graph",
      "-r",
      `change_id("${state.source.changeId}")`,
      "-T",
      'commit_id ++ "\\n"',
    ])
  ).stdout
    .trim()
    .split("\n");
  assert.equal(commits.length, 2);
  const otherParent = (
    await jj(root, [
      "log",
      "--no-graph",
      "-r",
      `${commits[0]}-`,
      "-T",
      "commit_id",
    ])
  ).stdout.trim();
  // Retain one source/parent lineage, but both older ancestor copies.
  await jj(root, ["abandon", commits[0]]);
  await jj(root, ["abandon", otherParent]);
  const service = new ReviewService({
    repoPath: root,
    revision: state.source.changeId,
  });
  const current = await service.getState();
  assert.equal(current.source.changeId, state.source.changeId);
  assert.ok(current.parent);
  assert.equal(
    (
      await jj(root, [
        "log",
        "--no-graph",
        "-r",
        `change_id("${target.changeId}")`,
        "-T",
        'commit_id ++ "\\n"',
      ])
    ).stdout
      .trim()
      .split("\n").length,
    2,
  );
  assert.equal(
    current.targets.some((entry) => entry.changeId === target.changeId),
    false,
  );
  await rejectsCode(
    service.squashLines({
      ...request(state),
      version: current.version,
      target: target.changeId,
    }),
    "INVALID_TARGET",
  );
  assert.equal((await service.getState()).operation, current.operation);
});

test("older destination conflicts are reported and remain exactly undoable", async (t) => {
  const { root, service, source } = await fixture(t);
  await writeFile(
    path.join(root, "a.txt"),
    source.replace("line 26\n", "selected adjacent edit\n"),
  );
  const state = await service.getState();
  const hunk = state.files[0].hunks.find((hunk) =>
    hunk.rows.some((row) => row.raw === "+selected adjacent edit"),
  )!;
  const result = await service.squashLines({
    version: state.version,
    target: state.targets[1].changeId,
    selections: [
      {
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      },
    ],
  });
  assert.match(result.warning!, /created a conflict/);
  assert.equal(result.state.canUndo, true);
  assert.equal(result.state.source.changeId, state.source.changeId);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.source, state.source);
  assert.deepEqual(undone.state.targets, state.targets);
  assert.deepEqual(undone.state.files, state.files);
});

test("bookmark names matching source, parent and destination hashes cannot redirect a custom squash", async (t) => {
  const { root, state, source, base } = await fixture(t);
  await jj(root, ["new", "root()", "-m", "Unrelated branch"]);
  await writeFile(path.join(root, "a.txt"), "unrelated branch bytes\n");
  await jj(root, ["status"]);
  const outside = (
    await jj(root, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])
  ).stdout.trim();
  for (const revision of [state.source, state.parent!, state.targets[1]]) {
    await jj(root, [
      "bookmark",
      "create",
      revision.commitId,
      "-r",
      `commit_id("${outside}")`,
    ]);
  }
  const service = new ReviewService({
    repoPath: root,
    revision: state.source.changeId,
  });
  const current = await service.getState();
  assert.equal(current.source.commitId, state.source.commitId);
  const result = await service.squashLines(request(current));
  assert.equal(result.warning, undefined);
  assert.equal(result.state.canUndo, true);
  assert.equal(result.state.source.changeId, state.source.changeId);
  assert.equal(
    await fileAt(root, `change_id("${state.source.changeId}")`),
    source,
  );
  assert.equal(
    await fileAt(root, `change_id("${state.targets[1].changeId}")`),
    base.replace("line 1\n", "line 1\nselected addition\n"),
  );
  assert.equal(
    (
      await jj(root, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])
    ).stdout.trim(),
    outside,
  );
  assert.equal(
    await readFile(path.join(root, "a.txt"), "utf8"),
    "unrelated branch bytes\n",
  );
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.source, current.source);
  assert.deepEqual(undone.state.targets, current.targets);
});
