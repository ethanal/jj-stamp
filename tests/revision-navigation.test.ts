import assert from "node:assert/strict";
import test from "node:test";
import { RevisionNavigation } from "../src/revision-navigation.ts";
import type { RepoState } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function state(changeId: string, version: string): RepoState {
  return {
    repo: { name: "test", path: "/test" },
    version,
    source: { changeId, commitId: `commit-${version}`, description: changeId },
    parent: null,
    targets: [],
    files: [],
    operation: `op-${version}`,
    canUndo: false,
  };
}

function setup() {
  const posts: {
    version: string;
    changeId: string;
    result: ReturnType<typeof deferred<{ state: RepoState }>>;
  }[] = [];
  const states: RepoState[] = [];
  const busy: boolean[] = [];
  const errors: unknown[] = [];
  const intents: string[] = [];
  const events: unknown[] = [];
  const navigation = new RevisionNavigation({
    select(version, changeId) {
      const result = deferred<{ state: RepoState }>();
      posts.push({ version, changeId, result });
      events.push(["select", version, changeId]);
      return result.promise;
    },
    onState(value) {
      states.push(value);
      events.push(["state", value]);
    },
    onBusy(value) {
      busy.push(value);
      events.push(["busy", value]);
    },
    onError(error) {
      errors.push(error);
      events.push(["error", error]);
    },
    onIntent(changeId) {
      intents.push(changeId);
      events.push(["intent", changeId]);
    },
  });
  return { navigation, posts, states, busy, errors, intents, events };
}

test("held A then B then C sends only A,C with chained versions and one final render", async () => {
  const { navigation, posts, states, busy, intents, errors, events } = setup();
  navigation.request("A", "v0");
  assert.deepEqual(busy, [true], "busy must begin before request returns");
  assert.deepEqual(intents, ["A"]);
  assert.ok(
    events.findIndex((event) => JSON.stringify(event) === '["busy",true]') <
      events.findIndex(
        (event) => JSON.stringify(event) === '["select","v0","A"]',
      ),
  );
  navigation.request("B", "stale-b");
  navigation.request("C", "stale-c");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].changeId, "A");
  assert.equal(posts[0].version, "v0");
  assert.deepEqual(intents, ["A", "B", "C"]);
  const a = state("A", "v1");
  posts[0].result.resolve({ state: a });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].changeId, "C");
  assert.equal(posts[1].version, "v1");
  assert.deepEqual(
    states,
    [],
    "intermediate selection must not replace the queue",
  );
  assert.deepEqual(busy, [true]);
  const c = state("C", "v2");
  posts[1].result.resolve({ state: c });
  await tick();
  assert.deepEqual(states, [c]);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(errors, []);
});

test("each newly dispatched request chains its response version into the next", async () => {
  const { navigation, posts, states, busy } = setup();
  navigation.request("A", "v0");
  navigation.request("B", "v0");
  posts[0].result.resolve({ state: state("A", "v1") });
  await tick();
  navigation.request("C", "v0");
  navigation.request("D", "v0");
  posts[1].result.resolve({ state: state("B", "v2") });
  await tick();
  assert.deepEqual(
    posts.map(({ version, changeId }) => [version, changeId]),
    [
      ["v0", "A"],
      ["v1", "B"],
      ["v2", "D"],
    ],
  );
  assert.deepEqual(states, []);
  const d = state("D", "v3");
  posts[2].result.resolve({ state: d });
  await tick();
  assert.deepEqual(states, [d]);
  assert.deepEqual(busy, [true, false]);
});

test("reselecting in-flight A cancels queued B, without duplicating the POST", async () => {
  const { navigation, posts, states, intents, busy } = setup();
  navigation.request("A", "v0");
  navigation.request("B", "v0");
  navigation.request("A", "v0");
  navigation.request("A", "v0");
  const a = state("A", "v1");
  posts[0].result.resolve({ state: a });
  await tick();
  assert.equal(posts.length, 1);
  assert.deepEqual(states, [a]);
  assert.deepEqual(intents, ["A", "B", "A", "A"]);
  assert.deepEqual(busy, [true, false]);
});

test("a new target can replace an in-flight deduplication", async () => {
  const { navigation, posts } = setup();
  for (const changeId of ["A", "B", "A", "C", "C"])
    navigation.request(changeId, "v0");
  posts[0].result.resolve({ state: state("A", "v1") });
  await tick();
  assert.equal(posts.length, 2);
  assert.equal(posts[1].changeId, "C");
  posts[1].result.resolve({ state: state("C", "v2") });
  await tick();
  assert.equal(posts.length, 2);
});

test("first POST failure preserves the original error and drops all waiting intents without replay", async () => {
  const { navigation, posts, states, errors, busy } = setup();
  navigation.request("A", "v0");
  navigation.request("B", "v0");
  navigation.request("C", "v0");
  const error = {
    message: "response lost; server selection is uncertain",
    code: "NETWORK",
  };
  posts[0].result.reject(error);
  await tick();
  await tick();
  assert.equal(posts.length, 1);
  assert.deepEqual(states, []);
  assert.deepEqual(errors, [error]);
  assert.equal(errors[0], error);
  assert.deepEqual(busy, [true, false]);
  // Only a new explicit request resumes navigation, using the caller's version.
  navigation.request("D", "fresh-version");
  assert.equal(posts.length, 2);
  assert.equal(posts[1].changeId, "D");
  assert.equal(posts[1].version, "fresh-version");
  posts[1].result.resolve({ state: state("D", "v2") });
  await tick();
  assert.equal(posts.length, 2);
});

test("failed later POST publishes the last successful selection before reporting uncertainty", async () => {
  const { navigation, posts, states, errors, busy, events } = setup();
  navigation.request("A", "v0");
  navigation.request("B", "v0");
  posts[0].result.resolve({ state: state("A", "v1") });
  await tick();
  navigation.request("C", "v0");
  const b = state("B", "v2");
  posts[1].result.resolve({ state: b });
  await tick();
  navigation.request("D", "v0");
  assert.deepEqual(states, []);
  const error = new Error(
    "C may have changed selection before response failed",
  );
  posts[2].result.reject(error);
  await tick();
  assert.equal(posts.length, 3, "D is discarded and C is never retried");
  assert.deepEqual(states, [b]);
  assert.deepEqual(errors, [error]);
  assert.deepEqual(events.slice(-3), [
    ["state", b],
    ["error", error],
    ["busy", false],
  ]);
  assert.deepEqual(busy, [true, false]);
});

test("an idle drain uses its own initialVersion and never restores a previous drain's state", async () => {
  const { navigation, posts, states, busy } = setup();
  navigation.request("A", "v0");
  const a = state("A", "v1");
  posts[0].result.resolve({ state: a });
  await tick();
  navigation.request("B", "external-mutation-version");
  assert.equal(posts[1].version, "external-mutation-version");
  posts[1].result.reject(new Error("failed"));
  await tick();
  assert.deepEqual(states, [a]);
  assert.deepEqual(busy, [true, false, true, false]);
});

test("synchronous transport exceptions report once and settle busy", () => {
  const error = new Error("synchronous transport error");
  const events: unknown[] = [];
  let posts = 0;
  const navigation = new RevisionNavigation({
    select() {
      posts++;
      throw error;
    },
    onState(value) {
      events.push(value);
    },
    onBusy(value) {
      events.push(value);
    },
    onError(value) {
      events.push(value);
    },
  });
  assert.doesNotThrow(() => navigation.request("A", "v0"));
  assert.equal(posts, 1);
  assert.deepEqual(events, [true, error, false]);
});

for (const fails of [false, true]) {
  test(`dispose suppresses callbacks and queued POSTs after in-flight ${fails ? "failure" : "success"}`, async () => {
    const { navigation, posts, events } = setup();
    navigation.request("A", "v0");
    navigation.request("B", "v0");
    const before = [...events];
    navigation.dispose();
    navigation.dispose();
    navigation.request("C", "v0");
    assert.deepEqual(events, before);
    // The already-started transport remains alive and settles normally.
    if (fails) posts[0].result.reject(new Error("lost response"));
    else posts[0].result.resolve({ state: state("A", "v1") });
    await tick();
    assert.deepEqual(events, before);
    assert.equal(posts.length, 1);
    navigation.request("D", "v1");
    assert.equal(posts.length, 1);
  });
}

test("dispose before a request is a complete no-op", () => {
  const { navigation, posts, events } = setup();
  navigation.dispose();
  navigation.request("A", "v0");
  assert.deepEqual(events, []);
  assert.deepEqual(posts, []);
});

test("a caller's intent token guards a late cached preview independently of POST serialization", async () => {
  const previewA = deferred<string>();
  const previewB = deferred<string>();
  const responseA = deferred<{ state: RepoState }>();
  const responseB = deferred<{ state: RepoState }>();
  let token = 0;
  let displayedPreview = "";
  const navigation = new RevisionNavigation({
    select: (_version, changeId) =>
      changeId === "A" ? responseA.promise : responseB.promise,
    onIntent(changeId) {
      const current = ++token;
      const preview = changeId === "A" ? previewA.promise : previewB.promise;
      void preview.then((value) => {
        if (current === token) displayedPreview = value;
      });
    },
    onState() {
      token++;
      displayedPreview = "confirmed";
    },
    onBusy() {},
    onError() {},
  });
  navigation.request("A", "v0");
  navigation.request("B", "v0");
  previewB.resolve("preview-B");
  await tick();
  assert.equal(displayedPreview, "preview-B");
  responseA.resolve({ state: state("A", "v1") });
  await tick();
  responseB.resolve({ state: state("B", "v2") });
  await tick();
  previewA.resolve("late-preview-A");
  await tick();
  assert.equal(displayedPreview, "confirmed");
});

test("a request from final publication stays serialized and uses the acknowledged version", async () => {
  const posts: { version: string; changeId: string }[] = [];
  const states: RepoState[] = [];
  const busy: boolean[] = [];
  const navigation = new RevisionNavigation({
    async select(version, changeId) {
      posts.push({ version, changeId });
      return { state: state(changeId, changeId === "A" ? "v1" : "v2") };
    },
    onState(value) {
      states.push(value);
      if (value.source.changeId === "A") navigation.request("B", "stale");
    },
    onBusy(value) {
      busy.push(value);
    },
    onError(error) {
      assert.fail(String(error));
    },
  });
  navigation.request("A", "v0");
  await tick();
  assert.deepEqual(posts, [
    { version: "v0", changeId: "A" },
    { version: "v1", changeId: "B" },
  ]);
  assert.deepEqual(
    states.map((value) => value.source.changeId),
    ["A", "B"],
  );
  assert.deepEqual(busy, [true, false]);
});
