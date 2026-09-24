import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ContentStore,
  contentBytes,
  type ContentLoaders,
  type ContentStoreLimits,
  type FileContents,
  type PinnedCommit,
} from "../src/content-store";
import type { DiffFile, LogRow, RepoState } from "../src/types";

const repo = { name: "repo", path: "/repositories/one" };
const file = (path = "one.ts", unsupported?: string): DiffFile => ({
  path,
  patch: "@@ -1 +1 @@\n-a\n+b\n",
  additions: 1,
  deletions: 1,
  hunks: [],
  ...(unsupported ? { unsupported } : {}),
});
const commit = (id: string, files: DiffFile[] = []): PinnedCommit => ({
  repo,
  commitId: id,
  baseCommitId: "base",
  files,
});
const contents = (text = "source", path = "one.ts"): FileContents => ({
  oldFile: { name: path, contents: "old" },
  newFile: { name: path, contents: text },
});
const row = (commitId: string): LogRow => ({
  graph: "○",
  revision: { commitId, changeId: "stable-change-id", description: "commit" },
});
const state = (id: string, files: DiffFile[] = []): RepoState => ({
  repo,
  version: "live-version",
  source: row(id).revision!,
  parent: null,
  targets: [],
  files,
  operation: "op",
  canUndo: false,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
// All scheduling is microtask-based; no wall-clock threshold or network needed.
const settle = async () => {
  for (let index = 0; index < 1000; index++) await Promise.resolve();
};
function fixture(
  overrides: Partial<ContentLoaders> = {},
  limits: Partial<ContentStoreLimits> = {},
) {
  const calls: string[] = [];
  const store = new ContentStore(
    repo.path,
    {
      loadCommit: async (id) => {
        calls.push(`diff:${id}`);
        return overrides.loadCommit ? overrides.loadCommit(id) : commit(id);
      },
      loadFile: async (id, path) => {
        calls.push(`file:${id}:${path}`);
        return overrides.loadFile ? overrides.loadFile(id, path) : contents();
      },
    },
    limits,
  );
  return { store, calls };
}

test("nearest unique commit rows first, ignoring connector rows; diffs before supported full files", async () => {
  const { store, calls } = fixture(
    {
      loadCommit: async (id) =>
        commit(id, [file(), file("binary", "binary file")]),
    },
    { speculativeCommits: 3 },
  );
  store.seed(state("c", [file("active.ts")]));
  store.setCandidates(
    [
      row("a"),
      { graph: "│" },
      { graph: "├─╮" },
      row("a"),
      row("b"),
      row("c"),
      row("d"),
      row("e"),
    ],
    "c",
  );
  await settle();
  assert.deepEqual(calls, [
    "file:c:active.ts",
    "diff:b",
    "file:b:one.ts",
    "diff:d",
    "file:d:one.ts",
    "diff:a",
    "file:a:one.ts",
  ]);
  assert.deepEqual(store.snapshot().speculative.commits, ["b", "d", "a"]);
  assert.deepEqual(store.snapshot().demand.commits, ["c"]);
});

test("absent selected commit uses log order and default caps are 10 speculative and 30 demanded", async () => {
  const { store, calls } = fixture();
  store.setCandidates(
    Array.from({ length: 50 }, (_, n) => row(`s${n}`)),
    "absent",
  );
  await settle();
  assert.equal(store.snapshot().speculative.entries, 10);
  assert.deepEqual(
    calls,
    Array.from({ length: 10 }, (_, n) => `diff:s${n}`),
  );
  for (let n = 0; n < 35; n++) await store.getCommit(`d${n}`);
  assert.equal(store.snapshot().demand.entries, 30);
  assert.deepEqual(
    store.snapshot().demand.commits,
    Array.from({ length: 30 }, (_, n) => `d${n + 5}`),
  );
});

test("promotion transfers content references, touches only on demand, and does not refill vacated speculative slots", async () => {
  const { store, calls } = fixture(
    {},
    { speculativeCommits: 2, demandCommits: 2 },
  );
  await store.getCommit("old-demand");
  const log = [row("a"), row("b"), row("c")];
  store.setCandidates(log, "selected");
  await settle();
  const bytes = store.snapshot().speculative.diffBytes;
  const cached = await store.getCommit("a", false);
  assert.ok(cached);
  assert.deepEqual(store.snapshot().demand.commits, ["old-demand"]);
  assert.strictEqual(await store.getCommit("a"), cached);
  assert.equal(store.snapshot().speculative.entries, 1);
  assert.equal(
    store.snapshot().demand.diffBytes,
    contentBytes(commit("old-demand")) + contentBytes(cached),
  );
  assert.equal(
    store.snapshot().speculative.diffBytes,
    bytes - contentBytes(cached),
  );
  for (let i = 0; i < 10; i++)
    store.setCandidates(
      log.map((r) => ({ ...r, graph: "new topology" })),
      "selected",
    );
  await settle();
  assert.deepEqual(calls, ["diff:old-demand", "diff:a", "diff:b"]);
  await store.getCommit("old-demand");
  await store.getCommit("new-demand");
  assert.deepEqual(store.snapshot().demand.commits, [
    "old-demand",
    "new-demand",
  ]);
});

test("one active background read, foreground starts immediately, and matching reads deduplicate", async () => {
  const first = deferred<PinnedCommit>();
  const demanded = deferred<PinnedCommit>();
  const { store, calls } = fixture({
    loadCommit: (id) =>
      id === "a"
        ? first.promise
        : id === "demand"
          ? demanded.promise
          : Promise.resolve(commit(id)),
  });
  store.setCandidates([row("a"), row("b")], "selected");
  await settle();
  assert.deepEqual(calls, ["diff:a"]);
  const foreground = store.getCommit("demand");
  const duplicate = store.getCommit("demand");
  assert.strictEqual(foreground, duplicate);
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:demand"]);
  first.resolve(commit("a"));
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:demand"]);
  demanded.resolve(commit("demand"));
  await foreground;
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:demand", "diff:b"]);
  assert.equal(store.snapshot().deduplicated, 1);
});

test("demand adopts active speculative work without copying or duplicate I/O, including during pause", async () => {
  const pending = deferred<PinnedCommit>();
  const { store, calls } = fixture({ loadCommit: () => pending.promise });
  store.setCandidates([row("a")], "selected");
  await settle();
  const demand = store.getCommit("a");
  store.setPaused(true);
  const value = commit("a");
  pending.resolve(value);
  assert.strictEqual(await demand, value);
  assert.strictEqual(await store.getCommit("a"), value);
  assert.equal(store.snapshot().speculative.entries, 0);
  assert.equal(store.snapshot().demand.entries, 1);
  assert.deepEqual(calls, ["diff:a"]);
});

test("same commit survives log refresh and overlapping candidate sets; obsolete out-of-order completion is discarded", async () => {
  const pending = deferred<PinnedCommit>();
  const { store, calls } = fixture(
    {
      loadCommit: (id) =>
        id === "a" ? pending.promise : Promise.resolve(commit(id)),
    },
    { speculativeCommits: 2 },
  );
  store.setCandidates([row("a"), row("b"), row("c")], "selected");
  await settle();
  store.setCandidates([row("b"), row("c")], "selected");
  pending.resolve(commit("a"));
  await settle();
  assert.equal(await store.getCommit("a", false), undefined);
  assert.deepEqual(store.snapshot().speculative.commits, ["b", "c"]);
  const b = await store.getCommit("b", false);
  store.setCandidates([row("b"), row("d")], "selected");
  await settle();
  assert.strictEqual(await store.getCommit("b", false), b);
  assert.deepEqual(calls, ["diff:a", "diff:b", "diff:c", "diff:d"]);
  assert.equal(store.snapshot().discarded, 1);
});

test("still-eligible in-flight work survives selection reprioritization", async () => {
  const pending = deferred<PinnedCommit>();
  const { store, calls } = fixture({
    loadCommit: (id) =>
      id === "a" ? pending.promise : Promise.resolve(commit(id)),
  });
  store.setCandidates([row("a"), row("b"), row("c")], "b");
  await settle();
  store.setCandidates([row("a"), row("b"), row("c")], "c");
  pending.resolve(commit("a"));
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:b"]);
  assert.ok(await store.getCommit("a", false));
  assert.equal(store.snapshot().discarded, 0);
});

test("pause suppresses scheduling and invalidates speculative completion even after an immediate resume", async () => {
  const pending = deferred<PinnedCommit>();
  let attempts = 0;
  const { store, calls } = fixture({
    loadCommit: async (id) => (++attempts === 1 ? pending.promise : commit(id)),
  });
  store.setPaused(true);
  store.setCandidates([row("a"), row("b")], "selected");
  await settle();
  assert.deepEqual(calls, []);
  store.setPaused(false);
  await settle();
  store.setPaused(true);
  store.setPaused(false);
  pending.resolve(commit("a"));
  await settle();
  assert.equal(store.snapshot().discarded, 1);
  assert.deepEqual(calls, ["diff:a", "diff:a", "diff:b"]);
});

test("separate speculative byte caps reserve before I/O and remember full-capacity rejections on unchanged refreshes", async () => {
  const unit = contentBytes(commit("a"));
  const { store, calls } = fixture(
    {},
    {
      speculativeDiffBytes: unit,
      diffReservationBytes: unit,
    },
  );
  await store.getCommit("demand");
  const before = store.snapshot().demand;
  const log = [row("a"), row("b"), row("c")];
  store.setCandidates(log, "selected");
  await settle();
  for (let i = 0; i < 20; i++) {
    store.setCandidates(log, "selected");
    await settle();
  }
  assert.deepEqual(calls, ["diff:demand", "diff:a"]);
  assert.deepEqual(store.snapshot().demand, before);
  assert.equal(store.snapshot().demandEvictions, 0);
  assert.equal(store.snapshot().speculative.diffBytes, unit);
  assert.equal(store.snapshot().rejectedTasks, 2);
});

test("reservation overrun rejects response instead of evicting nearer content, with no fetch/evict/refill loop", async () => {
  const unit = contentBytes(commit("a"));
  const large = commit("b", [file()]);
  const { store, calls } = fixture(
    { loadCommit: async (id) => (id === "b" ? large : commit(id)) },
    {
      speculativeDiffBytes: unit + 8,
      diffReservationBytes: 1,
    },
  );
  const log = [row("a"), row("b")];
  store.setCandidates(log, "selected");
  await settle();
  assert.equal(await store.getCommit("b", false), undefined);
  assert.ok(await store.getCommit("a", false));
  for (let i = 0; i < 10; i++) store.setCandidates(log, "selected");
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:b"]);
  assert.equal(store.snapshot().speculative.diffBytes, unit);
  assert.equal(store.snapshot().speculativeEvictions, 0);
});

test("oversized file results do not throw away useful diffs or retry on routine refresh", async () => {
  const { store, calls } = fixture(
    {
      loadCommit: async (id) => commit(id, [file()]),
      loadFile: async () => contents("x".repeat(100)),
    },
    { maxFileBytes: 50, fileReservationBytes: 1 },
  );
  const log = [row("a"), row("b")];
  store.setCandidates(log, "selected");
  await settle();
  store.setCandidates(log, "selected");
  await settle();
  assert.deepEqual(calls, [
    "diff:a",
    "file:a:one.ts",
    "diff:b",
    "file:b:one.ts",
  ]);
  assert.equal(store.snapshot().speculative.files, 0);
  assert.ok(await store.getCommit("a", false));
  assert.ok(await store.getCommit("b", false));
});

test("selected background contents cannot evict or touch demand LRU", async () => {
  const oneFile = contentBytes(contents());
  const { store, calls } = fixture(
    {},
    { demandFileBytes: oneFile, fileReservationBytes: 1 },
  );
  store.seed(state("older", [file()]));
  await store.getFile("older", "one.ts");
  store.seed(state("selected", [file()]));
  const before = store.snapshot().demand;
  store.setCandidates([], "selected");
  await settle();
  assert.deepEqual(store.snapshot().demand, before);
  assert.deepEqual(calls, ["file:older:one.ts"]);
  await store.getFile("selected", "one.ts");
  assert.ok(await store.getCommit("older", false));
  assert.ok(await store.getCommit("selected", false));
  assert.equal(store.snapshot().demand.fileBytes, oneFile);
});

test("background estimate overrun cannot evict demand files even if its reservation fit", async () => {
  const bytes = contentBytes(contents());
  const { store, calls } = fixture(
    {},
    { demandFileBytes: bytes + 1, fileReservationBytes: 1 },
  );
  store.seed(state("older", [file()]));
  await store.getFile("older", "one.ts");
  store.seed(state("selected", [file()]));
  const before = store.snapshot().demand;
  store.setCandidates([], "selected");
  await settle();
  assert.deepEqual(store.snapshot().demand, before);
  assert.deepEqual(calls, ["file:older:one.ts", "file:selected:one.ts"]);
  store.setCandidates([], "selected");
  await settle();
  assert.equal(calls.length, 2);
});

test("full file reads deduplicate, preserve null versus empty sides, and survive consumer unmounts", async () => {
  const pending = deferred<FileContents>();
  const { store, calls } = fixture({ loadFile: () => pending.promise });
  store.seed(state("root", [file()]));
  assert.equal((await store.getCommit("root")).baseCommitId, null);
  const a = store.getFile("root", "one.ts");
  const b = store.getFile("root", "one.ts");
  assert.strictEqual(a, b);
  const value: FileContents = {
    oldFile: null,
    newFile: { name: "one.ts", contents: "" },
  };
  pending.resolve(value);
  assert.strictEqual(await a, value);
  assert.strictEqual(await store.getFile("root", "one.ts"), value);
  assert.deepEqual(calls, ["file:root:one.ts"]);
});

test("seed is repo-isolated, preserves immutable content, and skips known unsupported/unchanged file reads", async () => {
  const { store, calls } = fixture();
  store.seed(state("a", [file("binary", "unsupported binary")]));
  const first = await store.getCommit("a");
  store.seed({ ...state("a"), operation: "different", version: "fresh" });
  assert.strictEqual(await store.getCommit("a"), first);
  await assert.rejects(store.getFile("a", "binary"), /unsupported binary/);
  await assert.rejects(store.getFile("a", "not-changed"), /Not a changed file/);
  assert.throws(
    () =>
      store.seed({ ...state("a"), repo: { name: "other", path: "/other" } }),
    /different repository/,
  );
  assert.deepEqual(calls, []);
  const second = new ContentStore("/other", {
    loadCommit: async (id) => ({
      ...commit(id),
      repo: { name: "other", path: "/other" },
    }),
    loadFile: async () => contents(),
  });
  assert.equal((await second.getCommit("a")).repo.path, "/other");
  assert.equal(first.repo.path, repo.path);
});

test("rewrites sharing a change ID are different full-commit cache keys", async () => {
  const { store, calls } = fixture();
  store.seed(state("full-old-commit"));
  store.seed(state("full-new-commit"));
  assert.notStrictEqual(
    await store.getCommit("full-old-commit"),
    await store.getCommit("full-new-commit"),
  );
  store.setCandidates(
    [row("full-old-commit"), row("full-new-commit")],
    "full-new-commit",
  );
  await settle();
  assert.deepEqual(calls, []);
  assert.equal(store.snapshot().demand.entries, 2);
});

test("background errors are optional, remembered per candidate set, and demand can retry", async () => {
  let fail = true;
  const { store, calls } = fixture({
    loadCommit: async (id) => {
      if (id === "a" && fail) throw new Error("temporary");
      return commit(id);
    },
  });
  const log = [row("a"), row("b")];
  store.setCandidates(log, "selected");
  await settle();
  store.setCandidates(log, "selected");
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:b"]);
  fail = false;
  assert.equal((await store.getCommit("a")).commitId, "a");
  assert.deepEqual(calls, ["diff:a", "diff:b", "diff:a"]);
});

test("mismatched response IDs and synchronous loader errors never poison caches; demand errors are retryable", async () => {
  let attempt = 0;
  const { store } = fixture({
    loadCommit: (id) => {
      attempt++;
      if (attempt === 1) throw new Error("sync failure");
      return Promise.resolve(commit(attempt === 2 ? "wrong" : id));
    },
  });
  await assert.rejects(store.getCommit("a"), /sync failure/);
  await assert.rejects(store.getCommit("a"), /identity mismatch/);
  assert.equal(await store.getCommit("a", false), undefined);
  assert.equal((await store.getCommit("a")).commitId, "a");
});

test("out-of-order demanded completions don't change recency or revive evicted buckets", async () => {
  const a = deferred<PinnedCommit>();
  const b = deferred<PinnedCommit>();
  const { store } = fixture(
    { loadCommit: (id) => (id === "a" ? a.promise : b.promise) },
    { demandCommits: 1 },
  );
  const old = store.getCommit("a");
  const recent = store.getCommit("b");
  b.resolve(commit("b"));
  await recent;
  a.resolve(commit("a"));
  await old;
  assert.deepEqual(store.snapshot().demand.commits, ["b"]);
  assert.equal(await store.getCommit("a", false), undefined);
});

test("a second demand can re-adopt an evicted in-flight bucket without duplicate I/O", async () => {
  const a = deferred<PinnedCommit>();
  const { store, calls } = fixture(
    {
      loadCommit: (id) =>
        id === "a" ? a.promise : Promise.resolve(commit(id)),
    },
    { demandCommits: 1 },
  );
  const first = store.getCommit("a");
  await store.getCommit("b");
  const last = store.getCommit("a");
  assert.strictEqual(first, last);
  const value = commit("a");
  a.resolve(value);
  await last;
  assert.strictEqual(await store.getCommit("a", false), value);
  assert.deepEqual(calls, ["diff:a", "diff:b"]);
});

test("dispose drops pending completions and prevents future activity", async () => {
  const pending = deferred<PinnedCommit>();
  const { store, calls } = fixture({ loadCommit: () => pending.promise });
  store.setCandidates([row("a"), row("b")], "selected");
  await settle();
  store.dispose();
  pending.resolve(commit("a"));
  await settle();
  assert.equal(store.snapshot().speculative.entries, 0);
  assert.equal(store.snapshot().demand.entries, 0);
  assert.equal(store.snapshot().inflight, 0);
  assert.deepEqual(calls, ["diff:a"]);
  assert.throws(() => store.getCommit("a"), /disposed/);
});

test("oversized demanded values are delivered but not retained; zero budgets disable retention/prefetch", async () => {
  const value = commit("a", [file()]);
  const { store, calls } = fixture(
    { loadCommit: async () => value },
    { demandDiffBytes: 1, speculativeDiffBytes: 0 },
  );
  assert.strictEqual(await store.getCommit("a"), value);
  assert.equal(await store.getCommit("a", false), undefined);
  store.setCandidates([row("b"), row("c")], "a");
  await settle();
  assert.deepEqual(calls, ["diff:a"]);
  assert.equal(store.snapshot().demand.diffBytes, 0);
});

test("confirmed metadata refreshes do not touch the browsing LRU", async () => {
  const { store } = fixture();
  store.seed(state("displayed"));
  await store.getCommit("hovered");
  assert.deepEqual(store.snapshot().demand.commits, ["displayed", "hovered"]);
  store.seed({ ...state("displayed"), version: "refreshed" });
  assert.deepEqual(store.snapshot().demand.commits, ["displayed", "hovered"]);
});

test("oversized displayed diff is accounted outside retention, displaces farthest speculation, and never causes refill", async () => {
  const unit = contentBytes(commit("a"));
  const { store, calls } = fixture(
    {},
    {
      demandDiffBytes: 1,
      demandFileBytes: 0,
      speculativeDiffBytes: 2 * unit,
      speculativeFileBytes: 0,
      diffReservationBytes: 1,
      fileReservationBytes: 1,
    },
  );
  const log = [row("a"), row("b"), row("c")];
  store.setCandidates(log, "displayed");
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:b"]);
  store.seed(state("displayed", [{ ...file(), patch: "x".repeat(1000) }]));
  assert.ok(store.snapshot().externalDisplayedBytes > 2 * unit);
  assert.equal(store.snapshot().demand.diffBytes, 0);
  assert.equal(store.snapshot().speculative.diffBytes, 0);
  for (let index = 0; index < 10; index++)
    store.setCandidates(log, "displayed");
  await settle();
  assert.deepEqual(calls, ["diff:a", "diff:b"]);
  // The active display remains available independently of reusable retention.
  assert.equal(
    (await store.getCommit("displayed")).files[0].patch.length,
    1000,
  );
  assert.equal(store.snapshot().speculativeEvictions, 2);
});

test("distance ties retain an existing speculative bucket instead of replacing it", async () => {
  const { store, calls } = fixture({}, { speculativeCommits: 1 });
  store.setCandidates([row("d")], "c");
  await settle();
  store.setCandidates([row("a"), row("b"), row("c"), row("d"), row("e")], "c");
  await settle();
  assert.deepEqual(store.snapshot().speculative.commits, ["d"]);
  assert.deepEqual(calls, ["diff:d"]);
});

test("full-file speculative I/O is adopted by demand and survives candidate removal", async () => {
  const pending = deferred<FileContents>();
  const { store, calls } = fixture({
    loadCommit: async (id) => commit(id, [file()]),
    loadFile: () => pending.promise,
  });
  store.setCandidates([row("a")], "selected");
  await settle();
  assert.deepEqual(calls, ["diff:a", "file:a:one.ts"]);
  assert.equal(store.snapshot().backgroundActive, 1);
  const foreground = store.getFile("a", "one.ts");
  store.setCandidates([], "selected");
  const value = contents();
  pending.resolve(value);
  assert.strictEqual(await foreground, value);
  assert.strictEqual(await store.getFile("a", "one.ts"), value);
  assert.deepEqual(calls, ["diff:a", "file:a:one.ts"]);
});
