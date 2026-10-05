import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewService, type State } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

const paths = (state: State) => state.files.map((file) => file.path).sort();
async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-watch-scope-"),
  );
  const repoPath = await createDemo(directory);
  let commands = 0;
  const service = new ReviewService({
    repoPath,
    jjRunner: async (...args) => {
      commands++;
      return jj(...args);
    },
  });
  t.after(async () => {
    await service.drain();
    await rm(directory, { recursive: true, force: true });
  });
  return { repoPath, service, commands: () => commands };
}

test("watch paths reuse published state without extra commands and are isolated from observers", async (t) => {
  const { repoPath, service, commands } = await fixture(t);
  const seen: string[][] = [];
  assert.deepEqual(service.getWatchPaths(), []);
  service.subscribeWatchPaths((files) => {
    files.length = 0;
  });
  const unsubscribe = service.subscribeWatchPaths((files) => seen.push(files));
  const initial = await service.getState();
  assert.deepEqual(seen, [paths(initial)]);
  const before = commands();
  assert.equal(await service.getWatchRoot(), repoPath);
  const copy = service.getWatchPaths();
  copy.length = 0;
  assert.deepEqual(service.getWatchPaths(), paths(initial));
  assert.equal(commands(), before, "scope access never runs jj");
  await service.getState();
  assert.equal(seen.length, 1, "unchanged scope must not restart observation");
  await mkdir(path.join(repoPath, "docs"));
  await writeFile(path.join(repoPath, "docs/new.txt"), "new path\n");
  const changed = await service.getState();
  assert.deepEqual(service.getWatchPaths(), paths(changed));
  assert.deepEqual(seen.at(-1), paths(changed));
  assert.equal(seen.length, 2);
  unsubscribe();
  await writeFile(path.join(repoPath, "docs/another.txt"), "another path\n");
  await service.getState();
  assert.equal(seen.length, 2, "unsubscribed observers must stay detached");
});

test("scope follows confirmed revision selection and missing-source fallback, not immutable reads or failures", async (t) => {
  const { repoPath, service } = await fixture(t);
  const initial = await service.getState();
  await jj(repoPath, ["new", "-m", "Watch another change"]);
  await mkdir(path.join(repoPath, "other"));
  await writeFile(path.join(repoPath, "other/only.txt"), "other content\n");
  const pinned = await service.getState();
  assert.deepEqual(
    service.getWatchPaths(),
    paths(initial),
    "moving @ must not switch the selected scope",
  );
  const otherId = (
    await jj(repoPath, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "change_id",
    ])
  ).stdout.trim();
  const selected = await service.selectRevision({
    version: pinned.version,
    changeId: otherId,
  });
  assert.deepEqual(service.getWatchPaths(), ["other/only.txt"]);
  await service.getCommit({ commitId: initial.source.commitId });
  await service.getLog({ includeOutput: false });
  assert.deepEqual(service.getWatchPaths(), paths(selected.state));
  await assert.rejects(
    service.selectRevision({
      version: initial.version,
      changeId: initial.source.changeId,
    }),
    { code: "STALE_STATE" },
  );
  assert.deepEqual(
    service.getWatchPaths(),
    paths(selected.state),
    "failed selection must retain the old scope",
  );
  await jj(repoPath, ["abandon", otherId]);
  const fallback = await service.getState();
  assert.notEqual(fallback.source.changeId, otherId);
  assert.deepEqual(service.getWatchPaths(), paths(fallback));
});

test("squash and undo update scope; throwing/rejecting observers cannot change mutation success", async (t) => {
  const { service } = await fixture(t);
  service.subscribeWatchPaths(() => {
    throw new Error("observer failure");
  });
  service.subscribeWatchPaths(async () => {
    throw new Error("async observer failure");
  });
  const seen: string[][] = [];
  service.subscribeWatchPaths((files) => seen.push(files));
  const initial = await service.getState();
  const selections = initial.files.flatMap((file) =>
    file.hunks.map((hunk) => ({
      id: hunk.id,
      lines: hunk.rows
        .filter((row) => /^[+-]/.test(row.raw))
        .map((row) => row.index),
    })),
  );
  const squashed = await service.squashLines({
    version: initial.version,
    selections,
  });
  assert(squashed.state.canUndo);
  assert.deepEqual(service.getWatchPaths(), []);
  const undone = await service.undo(squashed.state.version);
  assert.deepEqual(service.getWatchPaths(), paths(undone.state));
  assert.deepEqual(paths(undone.state), paths(initial));
  assert.deepEqual(seen, [paths(initial), [], paths(undone.state)]);
});
