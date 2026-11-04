import assert from "node:assert/strict";
import test from "node:test";
import { CommentOverlays } from "../src/comment-overlays.ts";
import type { ReviewCommentOverlay } from "../src/review-comments.ts";

const overlay = (body: string): ReviewCommentOverlay => ({
  comments: [{ id: "example", body, startLine: 1, endLine: 1 }],
  unmapped: [],
  issues: [],
  editable: true,
});

test("live overlays deduplicate, bound concurrency and invalidate independently of code identity", async () => {
  const started: string[] = [];
  const finish: Array<(value: ReviewCommentOverlay) => void> = [];
  const store = new CommentOverlays(
    (path, version) =>
      new Promise((resolve) => {
        started.push(`${version}:${path}`);
        finish.push(resolve);
      }),
  );
  const a = store.get("a.ts", "v1");
  assert.equal(store.get("a.ts", "v1"), a);
  const b = store.get("b.ts", "v1");
  const queued = store.get("c.ts", "v1");
  const rejected = assert.rejects(queued, /view changed/);
  await Promise.resolve();
  assert.deepEqual(started, ["v1:a.ts", "v1:b.ts"]);
  const updated = store.get("a.ts", "v2");
  await rejected;
  finish[0](overlay("old"));
  finish[1](overlay("old"));
  await Promise.all([a, b]);
  // Completion releases a slot, then starts the new-version request.
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["v1:a.ts", "v1:b.ts", "v2:a.ts"]);
  finish[2](overlay("new"));
  assert.equal((await updated).comments[0].body, "new");
  assert.equal((await store.get("a.ts", "v2")).comments[0].body, "new");
  assert.equal(started.length, 3);
});

test("failed overlay reads are not replayed or cached; a later explicit request can retry", async () => {
  let calls = 0;
  const store = new CommentOverlays(async () => {
    if (++calls === 1) throw new Error("read failed");
    return overlay("recovered");
  });
  await assert.rejects(store.get("a.ts", "v1"), /read failed/);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal((await store.get("a.ts", "v1")).comments[0].body, "recovered");
});

test("overlay retention is bounded by entry count", async () => {
  let calls = 0;
  const store = new CommentOverlays(async () => {
    calls++;
    return overlay("body");
  });
  for (let i = 0; i < 33; i++) await store.get(`${i}.ts`, "v1");
  await store.get("32.ts", "v1");
  assert.equal(calls, 33);
  await store.get("0.ts", "v1");
  assert.equal(calls, 34);
});

test("oversized overlays bypass retention", async () => {
  let calls = 0;
  const store = new CommentOverlays(async () => {
    calls++;
    return overlay("x".repeat(2 * 1024 * 1024));
  });
  await store.get("a.ts", "v1");
  await new Promise<void>((resolve) => setImmediate(resolve));
  await store.get("a.ts", "v1");
  assert.equal(calls, 2);
});

test("returning to a previous version cannot admit an earlier generation's response", async () => {
  const finish: Array<(value: ReviewCommentOverlay) => void> = [];
  const store = new CommentOverlays(
    () => new Promise((resolve) => finish.push(resolve)),
  );
  const old = store.get("a.ts", "v1");
  const other = store.get("b.ts", "v2");
  const current = store.get("a.ts", "v1");
  await Promise.resolve();
  finish[0](overlay("old generation"));
  await old;
  await new Promise<void>((resolve) => setImmediate(resolve));
  finish[2](overlay("current generation"));
  finish[1](overlay("other revision"));
  await Promise.all([current, other]);
  assert.equal(
    (await store.get("a.ts", "v1")).comments[0].body,
    "current generation",
  );
});
