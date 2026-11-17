import assert from "node:assert/strict";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import {
  projectSquash,
  refsFromSelection,
  type RowRef,
} from "../src/optimistic.ts";
import { SquashQueue, type SquashTransport } from "../src/squash-queue.ts";
import type { RepoState } from "../src/types.ts";

function mergeState(): RepoState {
  const patch =
    "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,4 @@\n before\n+selected\n+remaining\n after\n";
  return {
    repo: { name: "merge", path: "/merge" },
    source: { changeId: "merge", commitId: "merge-v0", description: "Merge" },
    parent: null,
    targets: ["left", "right", "older"].map((changeId) => ({
      changeId,
      commitId: `${changeId}-v0`,
      description: changeId,
    })),
    version: "v0",
    operation: "op0",
    files: [
      {
        path: "a",
        patch,
        additions: 2,
        deletions: 0,
        hunks: parseFile(patch, "a").hunks.map((hunk) => ({
          ...hunk,
          id: "h0",
        })),
      },
    ],
    canUndo: false,
  };
}

function refs(state: RepoState, text: string): RowRef[] {
  const hunk = state.files[0].hunks[0];
  const line = hunk.rows.find((row) => row.raw === `+${text}`)!;
  assert(line);
  return refsFromSelection(state, { [hunk.id]: [line.index] });
}

function setup(state = mergeState()) {
  type Input = Parameters<SquashTransport["squash"]>[0];
  type Result = Awaited<ReturnType<SquashTransport["squash"]>>;
  const posts: { input: Input; resolve: (value: Result) => void }[] = [];
  const queue = new SquashQueue({
    squash: (input) =>
      new Promise<Result>((resolve) => posts.push({ input, resolve })),
    readState: async () =>
      assert.fail("Successful explicit squashes need no recovery"),
  });
  queue.replace(state);
  return { queue, posts, state };
}

test("merge queue never infers a destination from eligible targets", () => {
  const { queue, posts, state } = setup();
  assert.throws(
    () => queue.enqueue(refs(state, "selected")),
    /No Parent revision/,
  );
  assert.equal(posts.length, 0);
  assert.equal(queue.getSnapshot().view, state);
  assert.equal(queue.getSnapshot().pending, 0);
});

test("either direct parent or an older ancestor is accepted explicitly without a default", async () => {
  for (const target of ["left", "right", "older"]) {
    const { queue, posts, state } = setup();
    const selected = refs(state, "selected");
    queue.enqueue(selected, target);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].input.target, target);
    assert.equal(posts[0].input.version, state.version);
    posts[0].resolve({
      state: {
        ...projectSquash(state, selected),
        version: "v1",
        operation: "op1",
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(queue.getSnapshot().pending, 0);
    assert.equal(queue.getSnapshot().halted, false);
  }
});

test("a queued explicit merge destination stays pinned through source and target rewrites", async () => {
  const { queue, posts, state } = setup();
  const first = refs(state, "selected");
  queue.enqueue(first, "right");
  const second = refs(queue.getSnapshot().view!, "remaining");
  queue.enqueue(second, "right");
  assert.equal(posts.length, 1);
  const rewritten = structuredClone(projectSquash(state, first));
  rewritten.version = "v1";
  rewritten.operation = "op1";
  rewritten.source.commitId = "merge-rewritten";
  rewritten.targets.reverse();
  rewritten.targets.forEach((target) => {
    target.commitId += "-rewritten";
  });
  rewritten.files[0].hunks[0].id = "rewritten-hunk";
  posts[0].resolve({ state: rewritten });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(posts.length, 2);
  assert.equal(
    posts[1].input.target,
    "right",
    "Never fall back to target ordering",
  );
  assert.equal(posts[1].input.version, "v1");
  assert.equal(posts[1].input.selections[0].id, "rewritten-hunk");
  assert.equal(queue.getSnapshot().view!.parent, null);
  posts[1].resolve({
    state: {
      ...projectSquash(rewritten, second),
      version: "v2",
      operation: "op2",
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(queue.getSnapshot().pending, 0);
  assert.equal(queue.getSnapshot().halted, false);
});
