import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewService } from "../server/service.ts";
import { jj, run } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

test("graph shows local and remote bookmark labels, filters worktree helpers, and follows moves", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-graph-bookmarks-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await createDemo(directory);
  const service = new ReviewService({ repoPath: root });
  const initial = await service.getState();
  const empty = await service.getLog({ includeOutput: false });
  for (const row of empty.rows)
    assert.deepEqual(row.bookmarks, row.revision ? [] : undefined);

  await jj(root, [
    "bookmark",
    "create",
    "main",
    "-r",
    initial.parent!.changeId,
  ]);
  await jj(root, [
    "bookmark",
    "create",
    "ethan/feature",
    "hidden-git-worktree",
    "keep-git-worktree-extra",
    "-r",
    initial.source.changeId,
  ]);
  const local = await service.getLog({ includeOutput: false });
  const labels = (graph: typeof local, changeId: string) =>
    graph.rows.find((row) => row.revision?.changeId === changeId)!.bookmarks;
  assert.deepEqual(labels(local, initial.source.changeId), [
    "ethan/feature",
    "keep-git-worktree-extra",
  ]);
  assert.deepEqual(labels(local, initial.parent!.changeId), ["main"]);
  assert.notEqual(local.version, empty.version);
  assert.equal(
    (await service.getState()).source.changeId,
    initial.source.changeId,
  );

  // A local bare remote exercises jj's real display rules, without network I/O.
  const remote = path.join(directory, "remote.git");
  await run("git", ["init", "--bare", remote], directory);
  await jj(root, ["git", "remote", "add", "origin", remote]);
  await jj(root, [
    "git",
    "push",
    "--remote",
    "origin",
    "--bookmark",
    "ethan/feature",
    "--bookmark",
    "hidden-git-worktree",
  ]);
  const aligned = await service.getLog({ includeOutput: false });
  assert.deepEqual(labels(aligned, initial.source.changeId), [
    "ethan/feature",
    "keep-git-worktree-extra",
  ]);

  await jj(root, [
    "bookmark",
    "set",
    "ethan/feature",
    "hidden-git-worktree",
    "-r",
    initial.parent!.changeId,
    "--allow-backwards",
  ]);
  const moved = await service.getLog({ includeOutput: false });
  assert.deepEqual(labels(moved, initial.source.changeId), [
    "ethan/feature@origin",
    "keep-git-worktree-extra",
  ]);
  assert.deepEqual(labels(moved, initial.parent!.changeId), [
    "ethan/feature*",
    "main",
  ]);
  assert.notEqual(moved.version, aligned.version);
  assert.equal(moved.version, (await service.getState()).version);
  assert.ok(
    moved.rows.every(
      (row) =>
        row.bookmarks?.every((name) => !name.includes("hidden-git-worktree")) ??
        true,
    ),
  );

  // All graph API variants use the same structured bookmark metadata.
  assert.deepEqual((await service.getLog()).rows, moved.rows);
});
