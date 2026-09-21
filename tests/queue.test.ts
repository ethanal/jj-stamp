import assert from "node:assert/strict";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import {
  changeSignature,
  projectSquash,
  refsFromSelection,
  type RowRef,
} from "../src/optimistic.ts";
import { RequestError } from "../src/api.ts";
import { SquashQueue, type SquashTransport } from "../src/squash-queue.ts";
import type { RepoState } from "../src/types.ts";

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
function initial(): RepoState {
  const patch =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,4 +1,4 @@\n before\n-old1\n-old2\n+new1\n+new2\n after\n";
  const parsed = parseFile(patch, "a");
  return {
    repo: { name: "test", path: "/test" },
    version: "v0",
    source: { changeId: "source", commitId: "c0", description: "source" },
    parent: null,
    targets: [],
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
    version: "v0",
    selections: [{ id: "original", lines: [2] }],
  });
  assert.deepEqual(posts[1].input, {
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
    version: "v1",
    selections: [{ id: "authoritative-v1", lines: [2] }],
  });
  actual = acknowledge(actual, second, "v2");
  actual.files[1].hunks[0].id = "other-v2";
  posts[1].result.resolve({ state: actual });
  await tick();
  assert.deepEqual(posts[2].input, {
    version: "v2",
    selections: [{ id: "other-v2", lines: [4] }],
  });
  actual = acknowledge(actual, third, "v3");
  actual.files[1].hunks[0].id = "other-v3";
  posts[2].result.resolve({ state: actual });
  await tick();
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
