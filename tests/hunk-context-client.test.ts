import assert from "node:assert/strict";
import test from "node:test";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import {
  createHunkContextClient,
  hunkContextCacheKey,
  supportsHunkContext,
  type ScopeWorker,
} from "../src/hunk-context-client.ts";
import {
  HUNK_CONTEXT_SCHEMA,
  type HunkContextRequest,
  type HunkContextResponse,
} from "../src/hunk-context-protocol.ts";
import type { Hunk } from "../src/types.ts";

class FakeWorker implements ScopeWorker {
  onmessage: ScopeWorker["onmessage"] = null;
  onerror: ScopeWorker["onerror"] = null;
  onmessageerror: ScopeWorker["onmessageerror"] = null;
  requests: HunkContextRequest[] = [];
  terminated = false;
  postMessage(request: HunkContextRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(contexts = {}, index = this.requests.length - 1) {
    const { id, schema } = this.requests[index];
    this.onmessage?.({
      data: { id, schema, contexts },
    } as MessageEvent<HunkContextResponse>);
  }
  fail() {
    this.onerror?.({ message: "crashed" } as ErrorEvent);
  }
}
const hunks: Hunk[] = [
  {
    id: "h",
    header: "@@ -2 +2 @@",
    rows: [
      { index: 1, raw: "-old();", oldLine: 2 },
      { index: 2, raw: "+new();", newLine: 2 },
    ],
  },
];
const files: FileDiffLoadedFiles = {
  oldFile: { name: "file.ts", contents: "function f() {\nold();\n}" },
  newFile: { name: "file.ts", contents: "function f() {\nnew();\n}" },
};
const contexts = {
  h: { scopes: [{ label: "function f() {", oldLine: 1, newLine: 1 }] },
};
function fixture(options: Parameters<typeof createHunkContextClient>[0] = {}) {
  const workers: FakeWorker[] = [];
  const client = createHunkContextClient({
    ...options,
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
  });
  const infer = (
    identity = "repo/full-source/full-base/patch",
    path = "file.ts",
  ) => client.inferCachedHunkContexts(identity, path, hunks, files);
  return { client, workers, infer };
}

test("deduplicates in-flight work and caches compact immutable results including empty", async () => {
  const { client, workers, infer } = fixture();
  const one = infer();
  const two = infer();
  assert.equal(one, two);
  assert.equal(workers[0].requests.length, 1);
  assert.deepEqual(
    workers[0].requests[0].hunks[0].rows.map((row) => row.raw),
    ["-", "+"],
  );
  workers[0].reply(contexts);
  assert.deepEqual(await one, contexts);
  assert.equal(await infer(), await two);
  assert.ok(Object.isFrozen((await one).h.scopes));
  const empty = infer("empty");
  workers[0].reply();
  await empty;
  assert.deepEqual(client.peekCachedHunkContexts("empty", "file.ts"), {});
  assert.deepEqual(await infer("empty"), {});
  assert.equal(workers[0].requests.length, 2);
  assert.equal(client.stats().deduplicated, 1);
  assert.equal(client.stats().pendingBytes, 0);
  client.dispose();
});

test("key isolates repositories, immutable rewrites, base, patch, path, and schema", async () => {
  assert.notEqual(
    hunkContextCacheKey("id", "p", "v1"),
    hunkContextCacheKey("id", "p", "v2"),
  );
  assert.notEqual(
    hunkContextCacheKey("a,b", "c"),
    hunkContextCacheKey("a", "b,c"),
  );
  const { client, workers, infer } = fixture({ schema: "test-schema" });
  for (const identity of [
    "repo-a/full-commit-a/base-a/patch-a",
    "repo-b/full-commit-a/base-a/patch-a",
    "repo-a/full-commit-b/base-a/patch-a",
    "repo-a/full-commit-a/base-b/patch-a",
    "repo-a/full-commit-a/base-a/patch-b",
  ]) {
    const result = infer(identity);
    workers[0].reply();
    await result;
  }
  const result = infer("repo-a/full-commit-a/base-a/patch-a", "other.ts");
  workers[0].reply();
  await result;
  assert.equal(workers[0].requests.length, 6);
  assert.ok(
    workers[0].requests.every((request) => request.schema === "test-schema"),
  );
  client.dispose();
});

test("LRU entry and byte eviction; oversized result is served without retention", async () => {
  const { client, workers, infer } = fixture({ maxEntries: 2 });
  for (const id of ["a", "b"]) {
    const result = infer(id);
    workers[0].reply();
    await result;
  }
  await infer("a");
  const c = infer("c");
  workers[0].reply();
  await c;
  assert.equal(client.peekCachedHunkContexts("b", "file.ts"), undefined);
  assert.deepEqual(client.peekCachedHunkContexts("a", "file.ts"), {});
  assert.equal(client.stats().evictions, 1);
  const entryBytes = client.stats().bytes / 2;
  client.dispose();
  const limited = fixture({ maxBytes: entryBytes + 5 });
  for (const id of ["a", "b"]) {
    const result = limited.infer(id);
    limited.workers[0].reply();
    await result;
  }
  assert.equal(limited.client.stats().entries, 1);
  assert.ok(limited.client.stats().bytes <= entryBytes + 5);
  const oversized = limited.infer("huge");
  limited.workers[0].reply({ h: { scopes: [{ label: "x".repeat(1000) }] } });
  assert.ok((await oversized).h);
  assert.equal(
    limited.client.peekCachedHunkContexts("huge", "file.ts"),
    undefined,
  );
  limited.client.dispose();
});

test("serial dispatch, bounded queue, dedup at capacity, and retry after capacity frees", async () => {
  const { client, workers, infer } = fixture({ maxPending: 2 });
  const one = infer("a");
  const two = infer("b");
  assert.equal(infer("b"), two);
  assert.equal(workers[0].requests.length, 1);
  assert.equal(client.stats().queued, 1);
  await assert.rejects(infer("c"), /queue is full/);
  workers[0].reply();
  await one;
  assert.equal(workers[0].requests.length, 2);
  const three = infer("c");
  workers[0].reply();
  await two;
  workers[0].reply();
  await three;
  assert.equal(client.stats().pending, 0);
  client.dispose();
});

test("input byte budget bounds source and identity retention, independently of count", async () => {
  const first = fixture();
  const pending = first.infer("a");
  const size = first.client.stats().pendingBytes;
  first.workers[0].reply();
  await pending;
  first.client.dispose();
  const { client, workers, infer } = fixture({ maxPendingBytes: size });
  const a = infer("a");
  await assert.rejects(infer("b"), /input budget/);
  workers[0].reply();
  await a;
  await assert.rejects(infer("x".repeat(size)), /input budget/);
  assert.equal(client.stats().pendingBytes, 0);
  client.dispose();
});

test("crash rejects active and queued jobs, resets worker, ignores stale response, retries", async () => {
  const { client, workers, infer } = fixture();
  const one = infer("a");
  const two = infer("b");
  const oldHandler = workers[0].onmessage!;
  const assertions = [
    assert.rejects(one, /crashed/),
    assert.rejects(two, /crashed/),
  ];
  workers[0].fail();
  await Promise.all(assertions);
  assert.ok(workers[0].terminated);
  assert.equal(client.stats().pending, 0);
  const retry = infer("a");
  oldHandler(
    new MessageEvent("message", {
      data: {
        id: workers[0].requests[0].id,
        schema: HUNK_CONTEXT_SCHEMA,
        contexts,
      },
    }),
  );
  assert.equal(client.stats().entries, 0);
  workers[1].reply();
  await retry;
  client.dispose();
});

test("extractor errors are retryable without restarting a healthy worker", async () => {
  const { client, workers, infer } = fixture();
  const pending = infer();
  const rejected = assert.rejects(pending, /grammar load/);
  const { id, schema } = workers[0].requests[0];
  workers[0].onmessage!({
    data: { id, schema, error: "grammar load" },
  } as MessageEvent<HunkContextResponse>);
  await rejected;
  const retry = infer();
  workers[0].reply();
  await retry;
  assert.equal(workers.length, 1);
  assert.equal(workers[0].requests.length, 2);
  client.dispose();
});

test("unavailable workers and constructor/postMessage failures do not poison the cache", async () => {
  let attempts = 0;
  const worker = new FakeWorker();
  const client = createHunkContextClient({
    createWorker: () => {
      if (++attempts === 1) throw new Error("unavailable");
      return worker;
    },
  });
  await assert.rejects(
    client.inferCachedHunkContexts("id", "file.ts", hunks, files),
    /unavailable/,
  );
  const retry = client.inferCachedHunkContexts("id", "file.ts", hunks, files);
  worker.reply();
  await retry;
  assert.equal(attempts, 2);
  client.dispose();
  const broken = createHunkContextClient({
    createWorker: () => ({
      ...new FakeWorker(),
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      terminate() {},
      postMessage() {
        throw new Error("clone failed");
      },
    }),
  });
  await assert.rejects(
    broken.inferCachedHunkContexts("id", "file.ts", hunks, files),
    /clone failed/,
  );
  assert.equal(broken.stats().pending, 0);
  broken.dispose();
});

test("timeout terminates stuck worker and permits retry", async () => {
  const { client, workers, infer } = fixture({ timeoutMs: 10 });
  await assert.rejects(infer(), /timed out/);
  assert.ok(workers[0].terminated);
  const retry = infer();
  workers[1].reply();
  await retry;
  client.dispose();
});

test("message errors and incompatible schemas reject safely and permit retry", async () => {
  const { client, workers, infer } = fixture();
  const first = infer();
  const rejected = assert.rejects(first, /decoded/);
  workers[0].onmessageerror!({} as MessageEvent);
  await rejected;
  const second = infer();
  const mismatch = assert.rejects(second, /schema/);
  workers[1].onmessage!({
    data: { id: workers[1].requests[0].id, schema: "wrong", contexts: {} },
  } as MessageEvent<HunkContextResponse>);
  await mismatch;
  const third = infer();
  workers[2].reply();
  await third;
  client.dispose();
});

test("unsupported paths resolve empty without starting a worker", async () => {
  const { client, workers, infer } = fixture();
  assert.ok(supportsHunkContext("src/THING.TSX"));
  assert.ok(supportsHunkContext("Rakefile"));
  assert.equal(supportsHunkContext("file.h"), false);
  assert.deepEqual(await infer("id", "image.png"), {});
  assert.equal(workers.length, 0);
  client.dispose();
});
