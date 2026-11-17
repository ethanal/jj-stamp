import assert from "node:assert/strict";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import {
  changeSignature,
  projectSquash,
  refsFromSelection,
  refsFromFile,
  type RowRef,
} from "../src/optimistic.ts";
import { RequestError } from "../src/api.ts";
import { SquashQueue, type SquashTransport } from "../src/squash-queue.ts";
import type { DiffFile, RepoState } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const PARENT = "pppppppppppppppppppppppppppppppp";
const OLDER = "oooooooooooooooooooooooooooooooo";

function initial(): RepoState {
  const patch =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,4 +1,4 @@\n before\n-old1\n-old2\n+new1\n+new2\n after\n";
  const parsed = parseFile(patch, "a");
  return {
    repo: { name: "test", path: "/test" },
    version: "v0",
    source: { changeId: "source", commitId: "c0", description: "source" },
    parent: { changeId: PARENT, commitId: "parent-c0", description: "Parent" },
    targets: [
      { changeId: PARENT, commitId: "parent-c0", description: "Parent" },
      { changeId: OLDER, commitId: "older-c0", description: "Older ancestor" },
    ],
    operation: "op0",
    canUndo: false,
    files: [
      {
        path: "a",
        patch,
        additions: 2,
        deletions: 2,
        hunks: parsed.hunks.map((hunk) => ({ ...hunk, id: "original" })),
      },
    ],
  };
}
function refs(state: RepoState, ...lines: number[]): RowRef[] {
  return refsFromSelection(state, { [state.files[0].hunks[0].id]: lines });
}
function acknowledge(
  state: RepoState,
  selected: RowRef[],
  version: string,
  trim = false,
): RepoState {
  const next = structuredClone(projectSquash(state, selected));
  next.version = version;
  next.operation = `op-${version}`;
  next.canUndo = true;
  next.source.commitId = `commit-${version}`;
  if (next.parent) next.parent.commitId = `parent-${version}`;
  for (const target of next.targets)
    target.commitId = `target-${target.changeId}-${version}`;
  for (const file of next.files)
    for (const hunk of file.hunks) {
      hunk.id = `authoritative-${version}`;
      if (trim) {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
          hunk.header,
        )!;
        let oldFirst = Number(match[1]) + (Number(match[2] ?? 1) === 0 ? 1 : 0);
        let newFirst = Number(match[3]) + (Number(match[4] ?? 1) === 0 ? 1 : 0);
        while (hunk.rows[0]?.raw[0] === " ") {
          hunk.rows.shift();
          oldFirst++;
          newFirst++;
        }
        while (hunk.rows.at(-1)?.raw[0] === " ") hunk.rows.pop();
        const oldCount = hunk.rows.filter((row) => row.raw[0] !== "+").length;
        const newCount = hunk.rows.filter((row) => row.raw[0] !== "-").length;
        hunk.header = `@@ -${oldCount ? oldFirst : oldFirst - 1},${oldCount} +${newCount ? newFirst : newFirst - 1},${newCount} @@`;
      }
      hunk.rows.forEach((row, i) => {
        row.index = i + 1;
      });
    }
  return next;
}
function setup() {
  type Input = Parameters<SquashTransport["squash"]>[0];
  type Result = Awaited<ReturnType<SquashTransport["squash"]>>;
  const posts: { input: Input; result: ReturnType<typeof deferred<Result>> }[] =
    [];
  const reads: ReturnType<typeof deferred<RepoState>>[] = [];
  const queue = new SquashQueue({
    squash(input) {
      const result = deferred<Result>();
      posts.push({ input, result });
      return result.promise;
    },
    readState() {
      const result = deferred<RepoState>();
      reads.push(result);
      return result.promise;
    },
  });
  const state = initial();
  queue.replace(state);
  return { queue, posts, reads, state };
}

test("projection is synchronous and enqueues continue during one in-flight mutation", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 1);
  assert.ok(
    !queue
      .getSnapshot()
      .view!.files[0].hunks[0].rows.some((row) => row.raw === "-old1"),
  );
  const second = refs(queue.getSnapshot().view!, 3); // +new1 after the deletion disappeared
  queue.enqueue(second);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 2);
  assert.equal(queue.getSnapshot().view!.files[0].additions, 1);
  assert.equal(queue.getSnapshot().view!.files[0].deletions, 1);
  const authoritative1 = acknowledge(state, first, "v1", true);
  posts[0].result.resolve({ state: authoritative1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].input, {
    target: PARENT,
    version: "v0",
    selections: [{ id: "original", lines: [2] }],
  });
  assert.deepEqual(posts[1].input, {
    target: PARENT,
    version: "v1",
    selections: [{ id: "authoritative-v1", lines: [2] }],
  });
  assert.equal(queue.getSnapshot().confirmed, authoritative1);
  assert.equal(queue.getSnapshot().pending, 1);
  // Use an untrimmed fixture for projection: the actual changed coordinates match
  // even though the tool's context and indices have changed between requests.
  const authoritative2 = acknowledge(
    acknowledge(state, first, "v1"),
    second,
    "v2",
  );
  posts[1].result.resolve({ state: authoritative2 });
  await tick();
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().view!.version, "v2");
  assert.equal(queue.getSnapshot().halted, false);
});

test("renamed-file selections carry the move once while subsequent queued edits use the new path", async () => {
  const { queue, posts, reads, state } = setup();
  state.files[0].oldPath = "old/a";
  state.files[0].patch = state.files[0].patch
    .replace("a/a b/a\n", "a/old/a b/a\nrename from old/a\nrename to a\n")
    .replace("--- a/a\n", "--- a/old/a\n");
  queue.replace(state);
  const first = refs(state, 2);
  queue.enqueue(first);
  const partial = queue.getSnapshot().view!;
  assert.equal(partial.files[0].oldPath, undefined);
  assert.ok(!partial.files[0].patch.includes("rename from"));
  const rest = refsFromFile(partial, "a");
  queue.enqueue(rest);
  assert.deepEqual(queue.getSnapshot().view!.files, []);
  const authoritative1 = acknowledge(state, first, "v1", true);
  posts[0].result.resolve({ state: authoritative1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].input.version, "v1");
  assert.equal(posts[1].input.selections[0].id, "authoritative-v1");
  posts[1].result.resolve({
    state: acknowledge(authoritative1, rest, "v2"),
  });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.deepEqual(queue.getSnapshot().view!.files, []);
  assert.equal(reads.length, 0);
  assert.equal(state.files[0].oldPath, "old/a", "input state stays unchanged");
});

test("normal acknowledgements preserve speculative file identity, hunk IDs, and render epoch", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  const projected = queue.getSnapshot().view!;
  const files = projected.files,
    epoch = queue.getSnapshot().epoch;
  const selectionNotYetEnqueued = refs(projected, 3);
  const actual = acknowledge(state, first, "v1", true);
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(queue.getSnapshot().view!.files, files);
  assert.equal(queue.getSnapshot().view!.files[0].hunks[0].id, "original");
  assert.equal(queue.getSnapshot().epoch, epoch);
  assert.equal(queue.getSnapshot().view!.version, "v1");
  assert.equal(queue.getSnapshot().view!.canUndo, true);
  queue.enqueue(selectionNotYetEnqueued);
  assert.deepEqual(posts[1].input, {
    target: PARENT,
    version: "v1",
    selections: [{ id: "authoritative-v1", lines: [2] }],
  });
  posts[1].result.resolve({
    state: acknowledge(
      acknowledge(state, first, "v1"),
      selectionNotYetEnqueued,
      "v2",
    ),
  });
  await tick();
});

test("a waiting renamed-file batch compacts edits selected before and after the projected move", async () => {
  const { queue, posts, reads, state } = setup();
  state.files[0].oldPath = "old/a";
  state.files[0].patch = state.files[0].patch
    .replace("a/a b/a\n", "a/old/a b/a\nrename from old/a\nrename to a\n")
    .replace("--- a/a\n", "--- a/old/a\n");
  const patch =
    "diff --git a/other b/other\nnew file mode 100644\n--- /dev/null\n+++ b/other\n@@ -0,0 +1 @@\n+unrelated\n";
  state.files.push({
    path: "other",
    patch,
    additions: 1,
    deletions: 0,
    hunks: parseFile(patch, "other").hunks.map((hunk) => ({
      ...hunk,
      id: "other",
    })),
  });
  queue.replace(state);
  const unrelated = refsFromFile(state, "other");
  queue.enqueue(unrelated);
  queue.enqueue(refs(state, 2));
  const shifted = refs(queue.getSnapshot().view!, 2);
  assert.equal(shifted[0].text, "old2");
  assert.equal(shifted[0].line, 2);
  queue.enqueue(shifted);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 2);
  const authoritative1 = acknowledge(state, unrelated, "v1");
  assert.equal(authoritative1.files[0].oldPath, "old/a");
  posts[0].result.resolve({ state: authoritative1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].input, {
    version: "v1",
    selections: [{ id: "authoritative-v1", lines: [2, 3] }],
    target: PARENT,
  });
  posts[1].result.resolve({
    state: acknowledge(authoritative1, refs(authoritative1, 2, 3), "v2"),
  });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  const remaining = queue.getSnapshot().view!.files[0];
  assert.equal(remaining.oldPath, undefined);
  assert.equal(remaining.additions, 2);
  assert.equal(remaining.deletions, 0);
  assert.equal(reads.length, 0);
});

test("acknowledging an earlier job leaves the entire later speculative view unchanged", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 4);
  queue.enqueue(first);
  const second = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(second);
  const view = queue.getSnapshot().view,
    epoch = queue.getSnapshot().epoch;
  const actual = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(queue.getSnapshot().view, view);
  assert.equal(queue.getSnapshot().epoch, epoch);
  posts[1].result.resolve({ state: acknowledge(actual, second, "v2") });
  await tick();
  assert.equal(queue.getSnapshot().view!.files, view!.files);
  assert.equal(queue.getSnapshot().epoch, epoch);
});

test("network/tool failure discards every speculative job, reloads once, and never retries", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  const epoch = queue.getSnapshot().epoch;
  posts[0].result.reject(new Error("Network connection lost"));
  await tick();
  assert.equal(reads.length, 1);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().recovering, true);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().view, state);
  assert.throws(() => queue.replace(state), /Wait/);
  assert.throws(() => queue.enqueue(first), /paused/);
  // The failed HTTP response could have hidden a successful real mutation.
  const fresh = acknowledge(state, first, "actually-committed");
  reads[0].resolve(fresh);
  await tick();
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.confirmed, fresh);
  assert.equal(snapshot.view, fresh);
  assert.equal(snapshot.recovering, false);
  assert.equal(snapshot.halted, true);
  assert.ok(snapshot.epoch > epoch);
  assert.match(snapshot.error, /Network connection lost/);
  assert.equal(posts.length, 1);
  queue.clearError();
  assert.equal(queue.getSnapshot().error, "");
  assert.equal(queue.getSnapshot().halted, true);
  assert.throws(() => queue.enqueue(refs(fresh, 2)), /paused/);
  queue.replace(fresh);
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(posts.length, 1);
});

test("definite stale rejection cancels queued selections and resumes only after a fresh read, without replay", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  const epoch = queue.getSnapshot().epoch;
  posts[0].result.reject(
    new RequestError("Selection is stale.", 409, "STALE_STATE"),
  );
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 1);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().view, state);
  assert.equal(queue.getSnapshot().recovering, true);
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().error, "");
  assert.deepEqual(queue.getSnapshot().errorDetails, []);
  assert.match(queue.getSnapshot().notice, /Repository changed; refreshing/);
  assert.throws(() => queue.enqueue(first), /paused/);
  assert.throws(() => queue.replace(state), /Wait/);

  const fresh = structuredClone(state);
  fresh.version = "external";
  fresh.operation = "external-operation";
  fresh.source.commitId = "external-commit";
  fresh.files[0].hunks[0].id = "fresh-hunk";
  reads[0].resolve(fresh);
  await tick();
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.confirmed, fresh);
  assert.equal(snapshot.view, fresh);
  assert.equal(snapshot.recovering, false);
  assert.equal(snapshot.halted, false);
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.error, "");
  assert.deepEqual(snapshot.errorDetails, []);
  assert.ok(snapshot.epoch > epoch);
  assert.match(snapshot.notice, /Diff refreshed/);
  assert.match(snapshot.notice, /Selection and queued squashes were canceled/);
  assert.match(snapshot.notice, /Nothing was squashed by the rejected request/);
  await tick();
  assert.equal(
    posts.length,
    1,
    "neither rejected nor queued jobs are replayed",
  );
  assert.equal(reads.length, 1);

  const explicit = refs(fresh, 4);
  queue.enqueue(explicit);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].input, {
    target: PARENT,
    version: "external",
    selections: [{ id: "fresh-hunk", lines: [4] }],
  });
  posts[1].result.resolve({ state: acknowledge(fresh, explicit, "v-next") });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().notice, "1 line squashed.");
});

test("stale rejection after an acknowledged squash preserves earlier success and cancels the remaining queue", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  const actual = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(posts.length, 2);
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  posts[1].result.reject(
    new RequestError("Repository changed.", 409, "STALE_STATE"),
  );
  await tick();
  assert.equal(queue.getSnapshot().view, actual);
  assert.equal(queue.getSnapshot().confirmed, actual);
  const fresh = { ...actual, version: "external" };
  reads[0].resolve(fresh);
  await tick();
  assert.equal(queue.getSnapshot().view, fresh);
  assert.equal(queue.getSnapshot().confirmed, fresh);
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.match(
    queue.getSnapshot().notice,
    /Nothing was squashed by the rejected request/,
  );
  assert.equal(posts.length, 2);
  assert.equal(reads.length, 1);
});

test("stale rejection stays halted with both diagnostics when its recovery read fails", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  const actual = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual });
  await tick();
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  posts[1].result.reject(
    new RequestError("Selection is stale.", 409, "STALE_STATE"),
  );
  await tick();
  reads[0].reject(
    new RequestError("Cannot reload.", 409, "SOURCE_UNAVAILABLE", "missing\n"),
  );
  await tick();
  const snapshot = queue.getSnapshot();
  assert.equal(snapshot.view, actual);
  assert.equal(snapshot.confirmed, actual);
  assert.equal(snapshot.halted, true);
  assert.equal(snapshot.recovering, false);
  assert.equal(snapshot.pending, 0);
  assert.equal(snapshot.notice, "");
  assert.match(snapshot.error, /Reload also failed: Cannot reload/);
  assert.deepEqual(snapshot.errorDetails, [
    { label: "Squash", code: "STALE_STATE", output: undefined },
    { label: "Reload", code: "SOURCE_UNAVAILABLE", output: "missing\n" },
  ]);
  assert.equal(posts.length, 2);
  assert.equal(reads.length, 1);
  queue.clearError();
  assert.equal(queue.getSnapshot().halted, true);
  assert.throws(() => queue.enqueue(refs(actual, 2)), /paused/);
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(reads.length, 1);
});

for (const error of [
  new RequestError("Selection is stale.", 500, "STALE_STATE"),
  new RequestError("Conflict.", 409, "OTHER_CONFLICT"),
  new RequestError("Selection is stale.", 409),
  Object.assign(new Error("Selection is stale."), {
    status: 409,
    code: "STALE_STATE",
  }),
]) {
  test(`nondefinite stale rejection stays halted after a fresh read: ${error.constructor.name} ${"status" in error ? error.status : ""} ${"code" in error ? error.code : ""}`, async () => {
    const { queue, posts, reads, state } = setup();
    queue.enqueue(refs(state, 2));
    queue.enqueue(refs(queue.getSnapshot().view!, 2));
    posts[0].result.reject(error);
    await tick();
    reads[0].resolve(state);
    await tick();
    assert.equal(queue.getSnapshot().view, state);
    assert.equal(queue.getSnapshot().halted, true);
    assert.equal(queue.getSnapshot().recovering, false);
    assert.equal(queue.getSnapshot().pending, 0);
    assert.match(queue.getSnapshot().error, new RegExp(error.message));
    assert.deepEqual(
      queue.getSnapshot().errorDetails,
      error instanceof RequestError && error.code
        ? [{ label: "Squash", code: error.code, output: undefined }]
        : [],
    );
    assert.equal(queue.getSnapshot().notice, "");
    assert.throws(() => queue.enqueue(refs(state, 2)), /paused/);
    assert.equal(posts.length, 1);
    assert.equal(reads.length, 1);
  });
}

test("failed reload rolls back to last acknowledged state, not the initial or speculative state", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  const actual = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual });
  await tick();
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  posts[1].result.reject(new Error("stale version"));
  await tick();
  reads[0].reject(new Error("offline"));
  await tick();
  assert.equal(queue.getSnapshot().view, actual);
  assert.equal(queue.getSnapshot().confirmed, actual);
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().recovering, false);
  assert.match(queue.getSnapshot().error, /Reload also failed: offline/);
  assert.equal(posts.length, 2);
  assert.equal(reads.length, 1);
});

for (const warning of [undefined, "descendant conflict"]) {
  test(`known ${warning ? "warning" : "unexpected changes"} result halts at actual state without a GET`, async () => {
    const { queue, posts, reads, state } = setup();
    const first = refs(state, 2);
    queue.enqueue(first);
    queue.enqueue(refs(queue.getSnapshot().view!, 2));
    const actual = warning
      ? acknowledge(state, first, "v1")
      : { ...state, version: "unexpected" };
    posts[0].result.resolve({ state: actual, warning });
    await tick();
    assert.equal(queue.getSnapshot().view, actual);
    assert.equal(queue.getSnapshot().confirmed, actual);
    assert.equal(queue.getSnapshot().pending, 0);
    assert.equal(queue.getSnapshot().halted, true);
    assert.equal(reads.length, 0);
    assert.equal(posts.length, 1);
    assert.match(
      queue.getSnapshot().error,
      warning ? /descendant conflict/ : /differed/,
    );
  });
}

test("a stale queued before-signature cannot dispatch a mutation", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  // Deliberately corrupt the saved checkpoint to exercise the alignment guard.
  const internals = queue as unknown as { jobs: { beforeSignature: string }[] };
  internals.jobs[1].beforeSignature = changeSignature(state);
  const actual = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 1);
  assert.match(queue.getSnapshot().error, /no longer matches/);
  reads[0].resolve(actual);
  await tick();
  assert.equal(queue.getSnapshot().view, actual);
  assert.equal(queue.getSnapshot().halted, true);
});

test("invalid/duplicate selection is atomic; replace is blocked while any job is pending", async () => {
  const { queue, posts, state } = setup();
  const before = queue.getSnapshot();
  const first = refs(state, 2);
  assert.throws(() => queue.enqueue([]), /at least one/);
  assert.throws(() => queue.enqueue([first[0], first[0]]), /Duplicate/);
  assert.equal(queue.getSnapshot(), before);
  assert.equal(posts.length, 0);
  queue.enqueue(first);
  assert.throws(() => queue.replace(state), /Wait/);
  const projected = queue.getSnapshot();
  assert.throws(() => queue.enqueue(first), /no longer match/);
  assert.equal(queue.getSnapshot(), projected);
  first[0].text = "caller mutation after enqueue";
  posts[0].result.resolve({ state: acknowledge(state, refs(state, 2), "v1") });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
});

test("subscriptions and snapshot reads are stable, with safe subscribe/unsubscribe during publication", async () => {
  const { queue, posts, state } = setup();
  const getSnapshot = queue.getSnapshot,
    subscribe = queue.subscribe;
  assert.equal(getSnapshot(), queue.getSnapshot());
  let initialCalls = 0,
    laterCalls = 0;
  let stopInitial = () => {};
  let stopLater = () => {};
  stopInitial = subscribe(() => {
    initialCalls++;
    stopInitial();
    stopLater = subscribe(() => {
      laterCalls++;
    });
  });
  const selected = refs(state, 2);
  queue.enqueue(selected);
  assert.equal(initialCalls, 1);
  assert.equal(laterCalls, 0);
  posts[0].result.resolve({ state: acknowledge(state, selected, "v1") });
  await tick();
  assert.equal(initialCalls, 1);
  assert.equal(laterCalls, 1);
  stopLater();
  const idle = queue.getSnapshot();
  queue.clearError();
  assert.equal(queue.getSnapshot(), idle);
  assert.equal(laterCalls, 1);
});

test("a broken subscriber cannot interrupt optimistic projection or dispatch", (t) => {
  const { queue, posts, state } = setup();
  const logged = t.mock.method(console, "error", () => {});
  queue.subscribe(() => {
    throw new Error("observer failed");
  });
  assert.doesNotThrow(() => queue.enqueue(refs(state, 2)));
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 1);
  assert.equal(logged.mock.callCount(), 1);
});

test("synchronous transport exceptions are caught and recovered without retry", async () => {
  const state = initial();
  let writes = 0,
    reads = 0;
  const queue = new SquashQueue({
    squash() {
      writes++;
      throw new Error("synchronous tool error");
    },
    async readState() {
      reads++;
      return state;
    },
  });
  queue.replace(state);
  assert.doesNotThrow(() => queue.enqueue(refs(state, 2)));
  await tick();
  assert.equal(writes, 1);
  assert.equal(reads, 1);
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().view, state);
});

test("queued deletion coordinates track earlier moved rows and independent files", async () => {
  const { queue, posts, state } = setup();
  const other = structuredClone(state.files[0]);
  other.path = "b";
  other.hunks[0].id = "other-file";
  other.patch = other.patch.replaceAll("a/a", "a/b").replaceAll("b/a", "b/b");
  state.files.push(other);
  queue.replace(state);
  const first = refs(state, 2);
  queue.enqueue(first);
  const view1 = queue.getSnapshot().view!;
  const second = refs(view1, 2);
  assert.equal(second[0].text, "old2");
  assert.equal(second[0].line, 2, "old2 moved from old line 3 to old line 2");
  queue.enqueue(second);
  const view2 = queue.getSnapshot().view!;
  const third = refsFromSelection(view2, { "other-file": [4] });
  queue.enqueue(third);
  const files = queue.getSnapshot().view!.files;
  const epoch = queue.getSnapshot().epoch;
  let actual = acknowledge(state, first, "v1");
  // Real IDs are unique across files; the helper normally models just one file.
  actual.files[1].hunks[0].id = "other-v1";
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.deepEqual(posts[1].input, {
    target: PARENT,
    version: "v1",
    selections: [
      { id: "authoritative-v1", lines: [2] },
      { id: "other-v1", lines: [4] },
    ],
  });
  actual = acknowledge(actual, [...second, ...third], "v2");
  actual.files[1].hunks[0].id = "other-v2";
  posts[1].result.resolve({ state: actual });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(queue.getSnapshot().notice, "2 lines squashed.");
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().view!.files, files);
  assert.equal(queue.getSnapshot().epoch, epoch);
});

test("subscribers can enqueue during acknowledgement without parallel POSTs", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  const actual1 = acknowledge(state, first, "v1");
  let second: RowRef[] = [];
  const stop = queue.subscribe(() => {
    if (
      queue.getSnapshot().pending === 0 &&
      queue.getSnapshot().confirmed === actual1
    ) {
      stop();
      second = refs(queue.getSnapshot().view!, 2);
      queue.enqueue(second);
    }
  });
  posts[0].result.resolve({ state: actual1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(queue.getSnapshot().pending, 1);
  posts[1].result.resolve({ state: acknowledge(actual1, second, "v2") });
  await tick();
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
});

test("squash diagnostics survive successful and failed reloads, and dismissal never resumes work", async () => {
  for (const reloadFails of [false, true]) {
    const { queue, posts, reads, state } = setup();
    queue.enqueue(refs(state, 2));
    queue.enqueue(refs(queue.getSnapshot().view!, 2));
    const output = "patch: hunk FAILED\nCaused by: permission denied\n";
    posts[0].result.reject(
      new RequestError("Tool failed.", 500, "TOOL_FAILED", output),
    );
    await tick();
    const primary = { label: "Squash", code: "TOOL_FAILED", output };
    assert.deepEqual(queue.getSnapshot().errorDetails, [primary]);
    if (reloadFails)
      reads[0].reject(
        new RequestError(
          "Cannot reload.",
          409,
          "SOURCE_UNAVAILABLE",
          "selected change missing\n",
        ),
      );
    else reads[0].resolve(state);
    await tick();
    assert.deepEqual(
      queue.getSnapshot().errorDetails,
      reloadFails
        ? [
            primary,
            {
              label: "Reload",
              code: "SOURCE_UNAVAILABLE",
              output: "selected change missing\n",
            },
          ]
        : [primary],
    );
    assert.equal(posts.length, 1);
    assert.equal(reads.length, 1);
    queue.clearError();
    assert.deepEqual(queue.getSnapshot().errorDetails, []);
    assert.equal(queue.getSnapshot().halted, true);
    assert.throws(() => queue.enqueue(refs(state, 2)), /paused/);
    queue.replace(state);
    assert.deepEqual(queue.getSnapshot().errorDetails, []);
  }
});

for (const order of [
  ["+new1", "-old1", "-old2", "+new2"],
  ["+new2", "-old2", "-old1", "+new1"],
]) {
  test(`waiting selections compact with shifted deletion coordinates: ${order}`, async () => {
    const { queue, posts, state } = setup();
    let actual = state;
    let afterFirst!: RepoState;
    for (const [index, raw] of order.entries()) {
      const view = queue.getSnapshot().view!;
      const row = view.files[0].hunks[0].rows.find((row) => row.raw === raw)!;
      const selected = refs(view, row.index);
      queue.enqueue(selected);
      actual = acknowledge(actual, selected, `v${index + 1}`);
      if (!index) afterFirst = actual;
      assert.equal(posts.length, 1);
      assert.equal(queue.getSnapshot().pending, Math.min(index + 1, 2));
    }
    const files = queue.getSnapshot().view!.files;
    const epoch = queue.getSnapshot().epoch;
    assert.deepEqual(files, []);
    posts[0].result.resolve({ state: afterFirst });
    await tick();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].input, {
      target: PARENT,
      version: afterFirst.version,
      selections: [
        {
          id: "authoritative-v1",
          lines: order[0] === "+new1" ? [2, 3, 5] : [2, 3, 4],
        },
      ],
    });
    posts[1].result.resolve({ state: actual });
    await tick();
    assert.equal(queue.getSnapshot().halted, false);
    assert.equal(queue.getSnapshot().pending, 0);
    assert.equal(queue.getSnapshot().notice, "3 lines squashed.");
    assert.equal(queue.getSnapshot().view!.files, files);
    assert.equal(queue.getSnapshot().epoch, epoch);
  });
}

test("new selections form a fresh batch while the compacted squash is in flight", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 4);
  queue.enqueue(first);
  const second = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(second);
  const third = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(third);
  const actual1 = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual1 });
  await tick();
  const dispatched = structuredClone(posts[1].input);
  const fourth = refs(queue.getSnapshot().view!, 3);
  queue.enqueue(fourth);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].input, dispatched);
  assert.equal(queue.getSnapshot().pending, 2);
  const actual2 = acknowledge(
    acknowledge(actual1, second, "intermediate"),
    third,
    "v2",
  );
  posts[1].result.resolve({ state: actual2 });
  await tick();
  assert.equal(posts.length, 3);
  assert.equal(posts[2].input.version, "v2");
  posts[2].result.resolve({ state: acknowledge(actual2, fourth, "v3") });
  await tick();
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
});

test("invalid selections cannot alter a compacted waiting batch", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 4);
  queue.enqueue(first);
  const second = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(second);
  const third = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(third);
  const before = queue.getSnapshot();
  const remaining = refs(before.view!, 3);
  assert.throws(() => queue.enqueue([...remaining, ...remaining]), /Duplicate/);
  assert.throws(() => queue.enqueue(second), /no longer match/);
  assert.equal(queue.getSnapshot(), before);
  const actual1 = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual1 });
  await tick();
  assert.deepEqual(posts[1].input.selections, [
    { id: "authoritative-v1", lines: [2, 3] },
  ]);
  posts[1].result.resolve({
    state: acknowledge(
      acknowledge(actual1, second, "intermediate"),
      third,
      "v2",
    ),
  });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
});

test("selections enqueued by acknowledgement subscribers join the still-unsent batch", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 4);
  queue.enqueue(first);
  const second = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(second);
  const actual1 = acknowledge(state, first, "v1");
  let third: RowRef[] = [];
  const stop = queue.subscribe(() => {
    if (queue.getSnapshot().confirmed === actual1) {
      stop();
      third = refs(queue.getSnapshot().view!, 2);
      queue.enqueue(third);
    }
  });
  posts[0].result.resolve({ state: actual1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(queue.getSnapshot().pending, 1);
  assert.deepEqual(posts[1].input.selections, [
    { id: "authoritative-v1", lines: [2, 3] },
  ]);
  posts[1].result.resolve({
    state: acknowledge(
      acknowledge(actual1, second, "intermediate"),
      third,
      "v2",
    ),
  });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
});

test("whole-file squash queues only remaining rows behind an in-flight partial squash", async () => {
  const { queue, posts, state } = setup();
  const partial = refs(state, 2);
  queue.enqueue(partial);
  const remaining = refsFromFile(queue.getSnapshot().view!, "a");
  assert.equal(remaining.length, 3);
  queue.enqueue(remaining);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 2);
  assert.deepEqual(queue.getSnapshot().view!.files, []);
  const firstAck = acknowledge(state, partial, "v1", true);
  posts[0].result.resolve({ state: firstAck });
  await tick();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].input, {
    target: PARENT,
    version: "v1",
    selections: [{ id: "authoritative-v1", lines: [1, 2, 3] }],
  });
  posts[1].result.resolve({ state: acknowledge(firstAck, remaining, "v2") });
  await tick();
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
  assert.deepEqual(queue.getSnapshot().confirmed!.files, []);
});

test("pure rename squashes project immediately and compact with waiting text selections", async () => {
  const { queue, posts, reads, state } = setup();
  for (const [oldPath, path] of [
    ["old.ts", "new.ts"],
    ["before.ts", "after.ts"],
  ]) {
    const patch = `diff --git a/${oldPath} b/${path}\nrename from ${oldPath}\nrename to ${path}\n`;
    state.files.push({
      oldPath,
      path,
      patch,
      hunks: [],
      additions: 0,
      deletions: 0,
    });
  }
  queue.replace(state);
  const first = refsFromFile(state, "new.ts");
  queue.enqueue(first);
  assert.deepEqual(posts[0].input, {
    version: "v0",
    selections: [{ id: 'rename:["old.ts","new.ts"]', lines: [] }],
    target: PARENT,
  });
  assert.deepEqual(
    queue.getSnapshot().view!.files.map((file) => file.path),
    ["a", "after.ts"],
  );
  const second = refsFromFile(queue.getSnapshot().view!, "after.ts");
  queue.enqueue(second);
  const third = refsFromFile(queue.getSnapshot().view!, "a");
  queue.enqueue(third);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 2);
  assert.deepEqual(queue.getSnapshot().view!.files, []);

  const firstAck = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: firstAck });
  await tick();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[1].input, {
    version: "v1",
    selections: [
      { id: "authoritative-v1", lines: [2, 3, 4, 5] },
      { id: 'rename:["before.ts","after.ts"]', lines: [] },
    ],
    target: PARENT,
  });
  const final = acknowledge(
    acknowledge(firstAck, second, "intermediate"),
    third,
    "v2",
  );
  posts[1].result.resolve({ state: final });
  await tick();
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().error, "");
  assert.equal(queue.getSnapshot().notice, "4 lines and 1 rename squashed.");
  assert.deepEqual(queue.getSnapshot().confirmed!.files, []);
  assert.deepEqual(queue.getSnapshot().view!.files, []);
  assert.equal(reads.length, 0);
  assert.equal(posts.length, 2);
});

for (const target of [undefined, OLDER])
  test(`a ${target ? "custom" : "Parent"} pure rename acknowledgement reports a rename, never a fake squashed line`, async () => {
    const { queue, posts, reads, state } = setup();
    state.files = [
      {
        oldPath: "old.ts",
        path: "new.ts",
        patch:
          "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n",
        hunks: [],
        additions: 0,
        deletions: 0,
      },
    ];
    queue.replace(state);
    const selected = refsFromFile(state, "new.ts");
    queue.enqueue(selected, target);
    assert.equal(posts[0].input.target, target ?? PARENT);
    assert.deepEqual(queue.getSnapshot().view!.files, []);
    posts[0].result.resolve({ state: acknowledge(state, selected, "v1") });
    await tick();
    assert.equal(queue.getSnapshot().pending, 0);
    assert.equal(queue.getSnapshot().halted, false);
    assert.equal(queue.getSnapshot().notice, "1 rename squashed.");
    assert.equal(posts.length, 1);
    assert.equal(reads.length, 0);
  });

test("a successful response that retains the pure rename halts instead of masking a projection mismatch", async () => {
  const { queue, posts, reads, state } = setup();
  state.files.push({
    oldPath: "old.ts",
    path: "new.ts",
    patch:
      "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n",
    hunks: [],
    additions: 0,
    deletions: 0,
  });
  queue.replace(state);
  queue.enqueue(refsFromFile(state, "new.ts"));
  queue.enqueue(refsFromFile(queue.getSnapshot().view!, "a"));
  const unchanged = { ...structuredClone(state), version: "v1" };
  posts[0].result.resolve({ state: unchanged });
  await tick();
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.match(queue.getSnapshot().error, /differed from the projected/);
  assert.equal(queue.getSnapshot().confirmed, unchanged);
  assert.equal(queue.getSnapshot().view, unchanged);
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 0);
});

test("unexpected rename metadata in a text-squash acknowledgement cancels waiting pure renames", async () => {
  const { queue, posts, reads, state } = setup();
  state.files.push({
    oldPath: "old.ts",
    path: "new.ts",
    patch:
      "diff --git a/old.ts b/new.ts\nrename from old.ts\nrename to new.ts\n",
    hunks: [],
    additions: 0,
    deletions: 0,
  });
  queue.replace(state);
  const selected = refs(state, 2);
  queue.enqueue(selected);
  queue.enqueue(refsFromFile(queue.getSnapshot().view!, "new.ts"));
  const unexpected = acknowledge(state, selected, "v1");
  unexpected.files[1].oldPath = "unexpected-old.ts";
  posts[0].result.resolve({ state: unexpected });
  await tick();
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.match(queue.getSnapshot().error, /differed from the projected/);
  assert.equal(queue.getSnapshot().confirmed, unexpected);
  assert.equal(queue.getSnapshot().view, unexpected);
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 0);
});

test("older ancestor batches pin full change IDs through rewritten revisions", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 4);
  queue.enqueue(first, OLDER);
  const second = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(second, OLDER);
  const third = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(third, OLDER);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 2);
  const actual1 = acknowledge(state, first, "v1", true);
  assert.notEqual(actual1.source.commitId, state.source.commitId);
  assert.notEqual(
    actual1.targets.find((target) => target.changeId === OLDER)!.commitId,
    state.targets.find((target) => target.changeId === OLDER)!.commitId,
  );
  posts[0].result.resolve({ state: actual1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].input, {
    version: "v0",
    target: OLDER,
    selections: [{ id: "original", lines: [4] }],
  });
  assert.deepEqual(posts[1].input, {
    version: "v1",
    target: OLDER,
    selections: [{ id: "authoritative-v1", lines: [1, 2] }],
  });
  posts[1].result.resolve({
    state: acknowledge(
      acknowledge(acknowledge(state, first, "v1"), second, "intermediate"),
      third,
      "v2",
    ),
  });
  await tick();
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(reads.length, 0);
});

test("default Parent is resolved at enqueue, not again when a waiting batch dispatches", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  const second = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(second);
  const actual1 = acknowledge(state, first, "v1");
  actual1.parent = actual1.targets.find((target) => target.changeId === OLDER)!;
  posts[0].result.resolve({ state: actual1 });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[0].input.target, PARENT);
  assert.equal(posts[1].input.target, PARENT);
  posts[1].result.resolve({ state: acknowledge(actual1, second, "v2") });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  // A new batch may use the newly authoritative Parent after the queue is idle.
  const third = refs(queue.getSnapshot().view!, 2);
  queue.enqueue(third);
  assert.equal(posts[2].input.target, OLDER);
  posts[2].result.resolve({
    state: acknowledge(acknowledge(actual1, second, "v2"), third, "v3"),
  });
  await tick();
});

for (const destination of [PARENT, OLDER]) {
  test(`pending batches reject destination changes atomically: ${destination}`, async () => {
    const { queue, posts, state } = setup();
    let publications = 0;
    queue.subscribe(() => publications++);
    const first = refs(state, 4);
    queue.enqueue(first, destination);
    for (const hasWaitingBatch of [false, true]) {
      if (hasWaitingBatch)
        queue.enqueue(refs(queue.getSnapshot().view!, 2), destination);
      const before = queue.getSnapshot();
      const beforePublications = publications;
      const selected = refs(before.view!, 2);
      const other = destination === PARENT ? OLDER : undefined;
      assert.throws(
        () => queue.enqueue(selected, other),
        /pending squashes before changing the destination revision/,
      );
      assert.throws(
        () => queue.enqueue(selected, destination.slice(0, 8)),
        /pending squashes before changing the destination revision/,
      );
      assert.equal(queue.getSnapshot(), before);
      assert.equal(publications, beforePublications);
      assert.equal(posts.length, 1);
    }
    const actual1 = acknowledge(state, first, "v1");
    posts[0].result.resolve({ state: actual1 });
    await tick();
    assert.equal(posts.length, 2);
    assert.equal(posts[1].input.target, destination);
    assert.deepEqual(posts[1].input.selections, [
      { id: "authoritative-v1", lines: [2] },
    ]);
    posts[1].result.resolve({
      state: acknowledge(actual1, refs(actual1, 2), "v2"),
    });
    await tick();
    assert.equal(queue.getSnapshot().halted, false);
  });
}

test("destination eligibility is validated before any optimistic mutation", async () => {
  const { queue, posts, state } = setup();
  for (const target of [
    "",
    "missing",
    OLDER.slice(0, 8),
    state.source.changeId,
  ]) {
    const before = queue.getSnapshot();
    assert.throws(() => queue.enqueue(refs(state, 2), target), /revision/);
    assert.equal(queue.getSnapshot(), before);
    assert.equal(posts.length, 0);
  }
  const unavailable = {
    ...state,
    squashUnavailable: "This source revision cannot be squashed.",
  };
  queue.replace(unavailable);
  const blocked = queue.getSnapshot();
  assert.throws(
    () => queue.enqueue(refs(unavailable, 2), OLDER),
    /This source revision cannot be squashed/,
  );
  assert.equal(queue.getSnapshot(), blocked);
  assert.equal(posts.length, 0);
  const noParent = { ...state, parent: null };
  queue.replace(noParent);
  const before = queue.getSnapshot();
  assert.throws(() => queue.enqueue(refs(noParent, 2)), /No Parent revision/);
  assert.equal(queue.getSnapshot(), before);
  const selected = refs(noParent, 2);
  queue.enqueue(selected, OLDER);
  assert.equal(posts[0].input.target, OLDER);
  posts[0].result.resolve({ state: acknowledge(noParent, selected, "v1") });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
});

test("a changed source revision with identical projected changes cancels waiting batches", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first, OLDER);
  queue.enqueue(refs(queue.getSnapshot().view!, 2), OLDER);
  const actual = acknowledge(state, first, "v1");
  actual.source.changeId = "different-source-revision";
  assert.equal(
    changeSignature(actual),
    changeSignature(projectSquash(state, first)),
  );
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 0);
  assert.equal(queue.getSnapshot().view, actual);
  assert.equal(queue.getSnapshot().confirmed, actual);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, true);
  assert.match(queue.getSnapshot().error, /source revision changed/);
});

test("source identity is checked again before a waiting batch dispatches", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first);
  queue.enqueue(refs(queue.getSnapshot().view!, 2));
  const internals = queue as unknown as {
    jobs: { sourceChangeId: string }[];
  };
  internals.jobs[1].sourceChangeId = "another-source-with-identical-changes";
  const actual = acknowledge(state, first, "v1");
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 1);
  assert.match(queue.getSnapshot().error, /source revision no longer matches/);
  reads[0].resolve(actual);
  await tick();
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().pending, 0);
});

for (const unavailable of [false, true]) {
  test(`a ${unavailable ? "blocked" : "missing"} pinned destination halts without falling back to Parent`, async () => {
    const { queue, posts, reads, state } = setup();
    const first = refs(state, 2);
    queue.enqueue(first, OLDER);
    queue.enqueue(refs(queue.getSnapshot().view!, 2), OLDER);
    const actual = acknowledge(state, first, "v1");
    if (unavailable)
      actual.squashUnavailable = "Revision is no longer mutable.";
    else
      actual.targets = actual.targets.filter(
        (target) => target.changeId !== OLDER,
      );
    assert.equal(actual.parent!.changeId, PARENT);
    posts[0].result.resolve({ state: actual });
    await tick();
    assert.equal(posts.length, 1);
    assert.equal(reads.length, 0);
    assert.equal(queue.getSnapshot().view, actual);
    assert.equal(queue.getSnapshot().pending, 0);
    assert.equal(queue.getSnapshot().halted, true);
    assert.match(
      queue.getSnapshot().error,
      /destination revision is no longer eligible/,
    );
    queue.clearError();
    assert.throws(() => queue.enqueue(refs(actual, 2)), /paused/);
    assert.equal(posts.length, 1);
  });
}

test("destination eligibility is checked again before a waiting batch dispatches", async () => {
  const { queue, posts, reads, state } = setup();
  const first = refs(state, 2);
  queue.enqueue(first, OLDER);
  queue.enqueue(refs(queue.getSnapshot().view!, 2), OLDER);
  const actual = acknowledge(state, first, "v1");
  const stop = queue.subscribe(() => {
    if (queue.getSnapshot().confirmed === actual) {
      stop();
      actual.targets = actual.targets.filter(
        (target) => target.changeId !== OLDER,
      );
    }
  });
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 1);
  assert.match(
    queue.getSnapshot().error,
    /destination revision is no longer eligible/,
  );
  reads[0].resolve(actual);
  await tick();
  assert.equal(queue.getSnapshot().view, actual);
  assert.equal(queue.getSnapshot().halted, true);
  assert.equal(queue.getSnapshot().pending, 0);
});

function metadataOnly(kind: "copy" | "mode" | "rename"): DiffFile {
  return {
    path: `${kind}.sh`,
    ...(kind === "copy" ? { copyFrom: "source.sh" } : {}),
    ...(kind === "rename" ? { oldPath: "old.sh" } : {}),
    oldMode: "100644",
    newMode: "100755",
    patch: `diff --git a/${kind}.sh b/${kind}.sh\nold mode 100644\nnew mode 100755\n`,
    additions: 0,
    deletions: 0,
    hunks: [],
  };
}

for (const target of [undefined, OLDER]) {
  test(`metadata-only copies and executable changes compact with text and report metadata labels for ${target ? "custom destination" : "Parent"}`, async () => {
    const { queue, posts, reads, state } = setup();
    state.files.push(
      metadataOnly("copy"),
      metadataOnly("mode"),
      metadataOnly("rename"),
    );
    queue.replace(state);
    const first = refsFromFile(state, "a");
    queue.enqueue(first, target);
    const copy = refsFromFile(queue.getSnapshot().view!, "copy.sh");
    queue.enqueue(copy, target);
    const mode = refsFromFile(queue.getSnapshot().view!, "mode.sh");
    queue.enqueue(mode, target);
    const rename = refsFromFile(queue.getSnapshot().view!, "rename.sh");
    queue.enqueue(rename, target);
    assert.deepEqual(queue.getSnapshot().view!.files, []);
    assert.equal(queue.getSnapshot().pending, 2);
    const firstAck = acknowledge(state, first, "v1");
    posts[0].result.resolve({ state: firstAck });
    await tick();
    assert.equal(posts.length, 2);
    assert.equal(posts[0].input.target, target ?? PARENT);
    assert.equal(posts[1].input.target, target ?? PARENT);
    assert.deepEqual(posts[1].input.selections, [
      { id: 'copy:["source.sh","copy.sh"]', lines: [] },
      { id: 'mode:["mode.sh","100644","100755"]', lines: [] },
      { id: 'rename:["old.sh","rename.sh"]', lines: [] },
    ]);
    posts[1].result.resolve({
      state: acknowledge(firstAck, [...copy, ...mode, ...rename], "v2"),
    });
    await tick();
    assert.equal(
      queue.getSnapshot().notice,
      "1 rename and 1 copy and 1 mode change squashed.",
    );
    assert.equal(queue.getSnapshot().halted, false);
    assert.equal(reads.length, 0);
  });

  test(`copy and mode transitions move with first text edits, while waiting edits remap normally for ${target ? "custom destination" : "Parent"}`, async () => {
    const { queue, posts, reads, state } = setup();
    state.files[0].copyFrom = "source";
    state.files[0].oldMode = "100644";
    state.files[0].newMode = "100755";
    state.files[0].patch = state.files[0].patch.replace(
      "\n",
      "\ncopy from source\ncopy to a\nold mode 100644\nnew mode 100755\n",
    );
    queue.replace(state);
    const first = refs(state, 2);
    queue.enqueue(first, target);
    const partial = queue.getSnapshot().view!;
    assert.equal(partial.files[0].copyFrom, undefined);
    assert.equal(partial.files[0].newMode, undefined);
    const second = refsFromFile(partial, "a");
    queue.enqueue(second, target);
    const firstAck = acknowledge(state, first, "v1", true);
    posts[0].result.resolve({ state: firstAck });
    await tick();
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[1].input, {
      target: target ?? PARENT,
      version: "v1",
      selections: [{ id: "authoritative-v1", lines: [1, 2, 3] }],
    });
    posts[1].result.resolve({ state: acknowledge(firstAck, second, "v2") });
    await tick();
    assert.equal(queue.getSnapshot().halted, false);
    assert.equal(queue.getSnapshot().pending, 0);
    assert.deepEqual(queue.getSnapshot().confirmed!.files, []);
    assert.equal(state.files[0].copyFrom, "source");
    assert.equal(reads.length, 0);
  });
}

for (const metadata of [
  { copyFrom: "unexpected-source" },
  { oldMode: "100644", newMode: "100755" },
] as const) {
  test(`unexpected ${"copyFrom" in metadata ? "copy" : "mode"} metadata in text acknowledgement cancels waiting squashes`, async () => {
    const { queue, posts, reads, state } = setup();
    state.files.push(metadataOnly("copy"));
    queue.replace(state);
    const selected = refs(state, 2);
    queue.enqueue(selected);
    queue.enqueue(refsFromFile(queue.getSnapshot().view!, "copy.sh"));
    const unexpected = acknowledge(state, selected, "v1");
    Object.assign(unexpected.files[0], metadata);
    posts[0].result.resolve({ state: unexpected });
    await tick();
    assert.equal(queue.getSnapshot().halted, true);
    assert.equal(queue.getSnapshot().pending, 0);
    assert.equal(queue.getSnapshot().confirmed, unexpected);
    assert.match(queue.getSnapshot().error, /differed from the projected/);
    assert.equal(posts.length, 1);
    assert.equal(reads.length, 0);
  });
}

const DESCENDANT = "dddddddddddddddddddddddddddddddd";

function withDescendant(state: RepoState): RepoState {
  state.targets.push({
    changeId: DESCENDANT,
    commitId: "descendant-c0",
    description: "Descendant",
    isDescendant: true,
  });
  return state;
}

/** Independent native-result fixture: do not derive ACKs using our projection. */
function textResult(
  state: RepoState,
  body: string,
  version: string,
): RepoState {
  const patch = `diff --git a/a b/a\n--- a/a\n+++ b/a\n${body}\n`;
  const parsed = parseFile(patch, "a");
  return {
    ...structuredClone(state),
    version,
    operation: `op-${version}`,
    canUndo: true,
    files: [
      {
        path: "a",
        patch,
        additions: parsed.hunks
          .flatMap((hunk) => hunk.rows)
          .filter((row) => row.raw[0] === "+").length,
        deletions: parsed.hunks
          .flatMap((hunk) => hunk.rows)
          .filter((row) => row.raw[0] === "-").length,
        hunks: parsed.hunks.map((hunk) => ({
          ...hunk,
          id: `native-${version}`,
        })),
      },
    ],
  };
}

test("descendant jobs project and compact NEW offsets using the selected target role, with independent ACKs", async () => {
  const { queue, posts, reads, state } = setup();
  withDescendant(state);
  queue.replace(state);
  queue.enqueue(refs(state, 4), DESCENDANT); // Remove +new1, NEW -1.
  const firstView = queue.getSnapshot().view!;
  assert.deepEqual(refs(firstView, 2, 3, 4), [
    { path: "a", kind: "-", line: 2, text: "old1" },
    { path: "a", kind: "-", line: 3, text: "old2" },
    { path: "a", kind: "+", line: 2, text: "new2" },
  ]);
  queue.enqueue(refs(firstView, 2), DESCENDANT); // Restore old1, NEW +1.
  const next = refs(queue.getSnapshot().view!, 4);
  assert.deepEqual(next, [{ path: "a", kind: "+", line: 3, text: "new2" }]);
  queue.enqueue(next, DESCENDANT);
  assert.equal(posts.length, 1);
  assert.equal(queue.getSnapshot().pending, 2);
  const firstAck = textResult(
    state,
    "@@ -1,4 +1,3 @@\n before\n-old1\n-old2\n+new2\n after",
    "v1",
  );
  posts[0].result.resolve({ state: firstAck });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(posts.length, 2);
  assert.deepEqual(
    posts.map((post) => post.input),
    [
      {
        target: DESCENDANT,
        version: "v0",
        selections: [{ id: "original", lines: [4] }],
      },
      {
        target: DESCENDANT,
        version: "v1",
        selections: [{ id: "native-v1", lines: [2, 4] }],
      },
    ],
  );
  const finalAck = textResult(
    state,
    "@@ -1,4 +1,3 @@\n before\n old1\n-old2\n after",
    "v2",
  );
  posts[1].result.resolve({ state: finalAck });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().confirmed, finalAck);
  assert.equal(
    changeSignature(queue.getSnapshot().view!),
    changeSignature(finalAck),
  );
  assert.equal(reads.length, 0);
});

test("ancestor targets stay backward even when descendant targets are available", async () => {
  const { queue, posts, reads, state } = setup();
  withDescendant(state);
  queue.replace(state);
  queue.enqueue(refs(state, 2), OLDER);
  assert.equal(refs(queue.getSnapshot().view!, 2)[0].line, 2);
  const actual = textResult(
    state,
    "@@ -1,3 +1,4 @@\n before\n-old2\n+new1\n+new2\n after",
    "v1",
  );
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(posts[0].input.target, OLDER);
  assert.equal(reads.length, 0);
});

for (const phase of ["acknowledgement", "dispatch"] as const) {
  test(`a descendant target changing role at ${phase} cannot dispatch queued changes with the wrong direction`, async () => {
    const { queue, posts, reads, state } = setup();
    withDescendant(state);
    queue.replace(state);
    queue.enqueue(refs(state, 4), DESCENDANT);
    queue.enqueue(refs(queue.getSnapshot().view!, 2), DESCENDANT);
    const actual = textResult(
      state,
      "@@ -1,4 +1,3 @@\n before\n-old1\n-old2\n+new2\n after",
      "v1",
    );
    if (phase === "acknowledgement")
      delete actual.targets.find((target) => target.changeId === DESCENDANT)!
        .isDescendant;
    else
      queue.subscribe(() => {
        if (queue.getSnapshot().confirmed === actual)
          delete actual.targets.find(
            (target) => target.changeId === DESCENDANT,
          )!.isDescendant;
      });
    posts[0].result.resolve({ state: actual });
    await tick();
    assert.equal(posts.length, 1);
    assert.equal(queue.getSnapshot().halted, true);
    assert.match(queue.getSnapshot().error, /changed direction/);
    if (phase === "dispatch") {
      assert.equal(reads.length, 1);
      reads[0].resolve(actual);
      await tick();
    } else {
      assert.equal(reads.length, 0);
      assert.equal(queue.getSnapshot().confirmed, actual);
    }
  });
}

for (const kind of ["rename", "copy"] as const) {
  for (const warning of [false, true]) {
    test(`forward ${kind} serializes without guessing and adopts native ${warning ? "warning" : "success"} state once`, async () => {
      const { queue, posts, reads, state } = setup();
      withDescendant(state);
      if (kind === "rename") state.files[0].oldPath = "old/a";
      else state.files[0].copyFrom = "old/a";
      state.files[0].patch = state.files[0].patch
        .replace("a/a b/a", `a/old/a b/a\n${kind} from old/a\n${kind} to a`)
        .replace("--- a/a", "--- a/old/a");
      const unrelated = metadataOnly("mode");
      state.files.push(unrelated);
      queue.replace(state);
      queue.enqueue(refs(state, 2), DESCENDANT);
      const before = queue.getSnapshot();
      assert.equal(before.view, state);
      assert.match(before.notice, /metadata/);
      assert.equal(posts.length, 1);
      assert.deepEqual(posts[0].input, {
        version: "v0",
        target: DESCENDANT,
        selections: [{ id: "original", lines: [2] }],
      });
      for (const selected of [
        refs(state, 4),
        refsFromFile(state, unrelated.path),
      ]) {
        assert.throws(
          () => queue.enqueue(selected, DESCENDANT),
          /Wait for the pending file metadata squash/,
        );
        assert.equal(
          queue.getSnapshot(),
          before,
          "rejected enqueue must be atomic",
        );
      }
      // The real path inventory may differ after native rename/copy subtraction.
      const actual = textResult(
        state,
        "@@ -1,4 +1,3 @@\n before\n-old1\n-old2\n+new2\n after",
        "v1",
      );
      actual.files[0].path = "restored-original";
      posts[0].result.resolve({
        state: actual,
        ...(warning ? { warning: "Native forward conservation warning" } : {}),
      });
      await tick();
      assert.equal(posts.length, 1);
      assert.equal(reads.length, 0);
      assert.equal(queue.getSnapshot().confirmed, actual);
      assert.equal(queue.getSnapshot().view, actual);
      assert.equal(queue.getSnapshot().pending, 0);
      assert.equal(queue.getSnapshot().halted, warning);
      assert.ok(queue.getSnapshot().epoch > before.epoch);
      if (warning)
        assert.match(queue.getSnapshot().error, /conservation warning/);
      else assert.equal(queue.getSnapshot().error, "");
    });
  }
}

test("forward mode-only changes project immediately and accept metadata-free native confirmation", async () => {
  const { queue, posts, reads, state } = setup();
  withDescendant(state);
  const entry = metadataOnly("mode");
  state.files = [entry];
  queue.replace(state);
  queue.enqueue(refsFromFile(state, entry.path), DESCENDANT);
  assert.deepEqual(queue.getSnapshot().view!.files, []);
  const actual = { ...structuredClone(state), files: [], version: "v1" };
  posts[0].result.resolve({ state: actual });
  await tick();
  assert.equal(queue.getSnapshot().halted, false);
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(changeSignature(queue.getSnapshot().confirmed!), "[]");
  assert.equal(posts.length, 1);
  assert.equal(reads.length, 0);
});
