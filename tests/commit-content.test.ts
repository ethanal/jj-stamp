import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewService, ApiError } from "../server/service.ts";
import { jj, run, ProcessOutputLimitError } from "../server/process.ts";
import type { OperationTiming } from "../server/timing.ts";
import { startLocalServer } from "../server/http.ts";
import { createDemo } from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jj-commit-content-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = await createDemo(dir);
  const commitId = (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "commit_id",
    ])
  ).stdout;
  return { root, commitId };
}
const code = (value: string) => (error: unknown) =>
  error instanceof ApiError && error.code === value;
const op = async (root: string) =>
  (
    await jj(root, [
      "op",
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-n",
      "1",
      "-T",
      "id",
    ])
  ).stdout;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("cold immutable reads neither initialize selection nor snapshot; old contents survive rewrites", async (t) => {
  const { root, commitId } = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    revision: "invalid-revset(",
    jjRunner: async (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const before = await op(root);
  const content = await service.getCommit({ commitId });
  const file = await service.getCommitFile({
    commitId,
    path: content.files[0].path,
  });
  assert.equal(content.commitId, commitId);
  assert.ok(content.baseCommitId);
  assert.ok(file.oldFile && file.newFile);
  await writeFile(
    path.join(root, content.files[0].path),
    "unsnapshotted replacement\n",
  );
  assert.deepEqual(await service.getCommit({ commitId }), content);
  assert.deepEqual(
    await service.getCommitFile({ commitId, path: content.files[0].path }),
    file,
  );
  assert.equal(await op(root), before);
  assert.ok(calls.every((args) => args.includes("--ignore-working-copy")));
  await jj(root, ["describe", "-m", "external rewrite"]);
  const rewrittenOp = await op(root);
  assert.deepEqual(await service.getCommit({ commitId }), content);
  assert.deepEqual(
    await service.getCommitFile({ commitId, path: content.files[0].path }),
    file,
  );
  assert.equal(await op(root), rewrittenOp);
  await assert.rejects(service.getState(), code("INVALID_REVISION"));
});

test("display reads preserve selected revision, exact diff parsing, and the demand cache", async (t) => {
  const { root, commitId } = await fixture(t);
  let diffs = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (args[0] === "diff") diffs++;
      return jj(cwd, args, limits);
    },
  });
  const state = await service.getState();
  const content = await service.getCommit({ commitId });
  assert.deepEqual(content.files, state.files);
  assert.equal("version" in content, false);
  const baseline = diffs;
  await service.getCommit({ commitId: state.parent!.commitId });
  assert.equal(diffs, baseline + 1);
  assert.deepEqual(await service.getState(), state);
  assert.equal(
    diffs,
    baseline + 1,
    "speculative content did not evict demand diff",
  );
  const cold = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (args[0] === "diff") diffs++;
      return jj(cwd, args, limits);
    },
  });
  await cold.getCommit({ commitId });
  const afterRead = diffs;
  await cold.getState();
  assert.equal(
    diffs,
    afterRead + 1,
    "speculative read did not populate demand diff",
  );
});

test("full IDs, exact changed paths, literal filesets, absent sides, unsupported files and merge context", async (t) => {
  const { root, commitId } = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  for (const id of [
    "@",
    "all()",
    commitId.slice(0, 12),
    "a".repeat(41),
    "a".repeat(63),
    "A".repeat(40),
  ])
    await assert.rejects(
      service.getCommit({ commitId: id }),
      code("INVALID_REQUEST"),
    );
  for (const name of [
    "../secret",
    "/etc/passwd",
    "src/../secret",
    "src//file",
    "a\0b",
    "glob:*",
    "src/preferences.ts/",
  ])
    await assert.rejects(
      service.getCommitFile({ commitId, path: name }),
      code("INVALID_PATH"),
    );
  await assert.rejects(
    service.getCommitFile({ commitId, path: ".jj/repo/config.toml" }),
    code("INVALID_PATH"),
  );
  await writeFile(path.join(root, "literal[1]*.txt"), "literal content\n");
  await writeFile(path.join(root, "no-newline.txt"), "unsupported");
  await rm(path.join(root, "src/preferences.ts"));
  await jj(root, ["describe", "-m", "new and deleted"]);
  const id = (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "commit_id",
    ])
  ).stdout;
  assert.deepEqual(
    await service.getCommitFile({ commitId: id, path: "literal[1]*.txt" }),
    {
      oldFile: null,
      newFile: { name: "literal[1]*.txt", contents: "literal content\n" },
    },
  );
  assert.equal(
    (await service.getCommitFile({ commitId: id, path: "src/preferences.ts" }))
      .newFile,
    null,
  );
  await assert.rejects(
    service.getCommitFile({ commitId: id, path: "no-newline.txt" }),
    code("UNSUPPORTED_DIFF"),
  );
  const read = calls.find(
    (args) => args[0] === "file" && args.at(-1)!.includes("literal"),
  )!;
  assert.equal(read.at(-1), 'root-file:"literal[1]*.txt"');
  assert.ok(read.indexOf("--ignore-working-copy") < read.indexOf("--"));
  await jj(root, ["new", "@-", "-m", "other branch"]);
  const other = (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "commit_id",
    ])
  ).stdout;
  await jj(root, ["new", id, other]);
  const merge = (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "commit_id",
    ])
  ).stdout;
  await assert.rejects(
    service.getCommit({ commitId: merge }),
    code("UNSUPPORTED_DIFF"),
  );
});

test("bounded read lane is independent in both directions, timing contexts are isolated, shutdown drains accepted reads", async (t) => {
  const { root, commitId } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  let gate = true;
  const records: OperationTiming[] = [];
  const service = new ReviewService({
    repoPath: root,
    onTiming: (record) => records.push(record),
    jjRunner: async (cwd, args, limits) => {
      if (gate && limits) {
        entered.resolve();
        await release.promise;
      }
      return jj(cwd, args, limits);
    },
  });
  const reads = Array.from({ length: 18 }, () =>
    service.getCommit({ commitId }),
  );
  await entered.promise;
  await assert.rejects(service.getCommit({ commitId }), code("BUSY"));
  const state = await service.getState(); // must not wait for display work
  assert.equal(state.source.commitId, commitId);
  let drained = false;
  const drain = service.drain().then(() => {
    drained = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(drained, false);
  gate = false;
  release.resolve();
  await Promise.all(reads);
  await drain;
  assert.equal(records.filter((r) => r.name === "commit").length, 18);
  assert.equal(
    records
      .filter((r) => r.name === "commit")
      .reduce((sum, r) => sum + r.subprocesses.length, 0),
    3,
    "one initiator owns all deduplicated descriptor subprocesses",
  );
  assert.equal(records.find((r) => r.name === "state")!.subprocesses.length, 7);

  const serialEntered = deferred(),
    serialRelease = deferred();
  const blocked = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (!limits && args[0] === "root") {
        serialEntered.resolve();
        await serialRelease.promise;
      }
      return jj(cwd, args, limits);
    },
  });
  const stateRead = blocked.getState();
  await serialEntered.promise;
  assert.equal((await blocked.getCommit({ commitId })).commitId, commitId);
  serialRelease.resolve();
  await stateRead;
});

test("bounded subprocess capture and oversized display errors leave mutable state healthy", async (t) => {
  await assert.rejects(
    run(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000))"],
      process.cwd(),
      { maxOutputBytes: 100 },
    ),
    ProcessOutputLimitError,
  );
  const { root, commitId } = await fixture(t);
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (limits && args[0] === "diff")
        return { stdout: "x".repeat(2 * 1024 * 1024 + 1), stderr: "" };
      return jj(cwd, args, limits);
    },
  });
  await assert.rejects(
    service.getCommit({ commitId }),
    code("CONTENT_TOO_LARGE"),
  );
  await service.drain();
  const state = await service.getState();
  assert.equal(state.source.commitId, commitId);
  assert.equal(state.canUndo, false);
});

test("HTTP immutable contract keeps loopback POST protections and rejects revsets", async (t) => {
  const { root, commitId } = await fixture(t);
  const service = new ReviewService({ repoPath: root });
  const server = await startLocalServer({ service, assetsDir: root, port: 0 });
  t.after(() => server.close());
  const post = (route: string, body: unknown, protectedRequest = true) =>
    fetch(`${server.url}api/${route}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(protectedRequest ? { "X-Fold-Request": "1" } : {}),
      },
      body: JSON.stringify(body),
    });
  assert.equal((await post("commit", { commitId }, false)).status, 403);
  assert.equal((await post("commit", { commitId: "@" })).status, 400);
  assert.equal((await post("commit", { commitId, version: "x" })).status, 400);
  const response = await post("commit", { commitId });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const content = await response.json();
  assert.deepEqual(Object.keys(content).sort(), [
    "baseCommitId",
    "commitId",
    "files",
    "repo",
  ]);
  const file = await post("commit-file", {
    commitId,
    path: content.files[0].path,
  });
  assert.equal(file.status, 200);
  assert.deepEqual(Object.keys(await file.json()).sort(), [
    "newFile",
    "oldFile",
  ]);
});

test("both full hash lengths are accepted but exact identity mismatches fail closed", async (t) => {
  const { root } = await fixture(t);
  for (const length of [40, 64]) {
    const commitId = "a".repeat(length),
      parent = "b".repeat(length);
    const service = new ReviewService({
      repoPath: root,
      jjRunner: async (_cwd, args) => ({
        stdout:
          args[0] === "root"
            ? root
            : args[0] === "log"
              ? `${commitId}\n${parent}`
              : "",
        stderr: "",
      }),
    });
    assert.deepEqual(await service.getCommit({ commitId }), {
      repo: { name: path.basename(root), path: root },
      commitId,
      baseCommitId: parent,
      files: [],
    });
    await assert.rejects(
      service.getCommit({ commitId: "c".repeat(length) }),
      code("COMMIT_UNAVAILABLE"),
    );
  }
  const actualRoot = (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "root()",
      "-T",
      "commit_id",
    ])
  ).stdout;
  const rootContent = await new ReviewService({ repoPath: root }).getCommit({
    commitId: actualRoot,
  });
  assert.equal(rootContent.baseCommitId, null);
  assert.deepEqual(rootContent.files, []);
});

test("serial admission is bounded too; a failed read drains without affecting queued state", async (t) => {
  const { root, commitId } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (!limits && args[0] === "root") {
        entered.resolve();
        await release.promise;
      }
      if (limits && args[0] === "diff") throw new Error("display-only failure");
      return jj(cwd, args, limits);
    },
  });
  const states = Array.from({ length: 64 }, () => service.getState());
  await entered.promise;
  await assert.rejects(service.getState(), code("BUSY"));
  await assert.rejects(service.getCommit({ commitId }), /display-only failure/);
  release.resolve();
  await service.drain();
  const results = await Promise.all(states);
  assert.ok(results.every((state) => state.version === results[0].version));
});

test("HTTP shutdown waits for an accepted immutable read and drains its child", async (t) => {
  const { root, commitId } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (limits && args[0] === "diff") {
        entered.resolve();
        await release.promise;
      }
      return jj(cwd, args, limits);
    },
  });
  const server = await startLocalServer({ service, assetsDir: root, port: 0 });
  t.after(() => server.close());
  const response = fetch(`${server.url}api/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
    body: JSON.stringify({ commitId }),
  });
  await entered.promise;
  let closed = false;
  const close = server.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(closed, false);
  release.resolve();
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal((await result.json()).commitId, commitId);
  await close;
});

test("real jj large-file capture is bounded even when its changed patch is small", async (t) => {
  const { root } = await fixture(t);
  const large = ("unchanged ".repeat(10) + "\n").repeat(45000);
  assert.ok(Buffer.byteLength(large) > 4 * 1024 * 1024);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "snapshot.max-new-file-size",
    "10MiB",
  ]);
  await writeFile(path.join(root, "large.txt"), large);
  await jj(root, ["commit", "-m", "large base"]);
  await writeFile(
    path.join(root, "large.txt"),
    "changed first line\n" + large.slice(large.indexOf("\n") + 1),
  );
  await jj(root, ["describe", "-m", "small change in large file"]);
  const commitId = (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "commit_id",
    ])
  ).stdout;
  const before = await op(root);
  const service = new ReviewService({ repoPath: root });
  assert.ok(
    (await service.getCommit({ commitId })).files[0].patch.length < 2000,
  );
  await assert.rejects(
    service.getCommitFile({ commitId, path: "large.txt" }),
    code("CONTENT_TOO_LARGE"),
  );
  await service.drain();
  assert.equal(await op(root), before);
  assert.equal((await service.getState()).source.commitId, commitId);
});

test("warm immutable file reads only show file sides; callers cannot poison descriptor membership", async (t) => {
  const { root, commitId } = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const state = await service.getState();
  calls.length = 0;
  const content = await service.getCommit({ commitId });
  assert.equal(calls.length, 3);
  const expected = structuredClone(content);
  content.repo.path = "/invalid";
  content.baseCommitId = "0".repeat(40);
  content.files[0].path = "injected.txt";
  content.files[0].hunks[0].rows[0].raw = "+poisoned";
  content.files.length = 1;
  assert.deepEqual(await service.getCommit({ commitId }), expected);
  await assert.rejects(
    service.getCommitFile({ commitId, path: "injected.txt" }),
    code("INVALID_PATH"),
  );
  calls.length = 0;
  for (let i = 0; i < 2; i++)
    for (const file of expected.files)
      await service.getCommitFile({ commitId, path: file.path });
  assert.equal(calls.length, expected.files.length * 4);
  assert.ok(calls.every((args) => args[0] === "file" && args[1] === "show"));
  assert.deepEqual(await service.getState(), state);
});

test("descriptor inflight errors are not cached and the next read retries", async (t) => {
  const { root, commitId } = await fixture(t);
  const entered = deferred(),
    release = deferred();
  let diffs = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      if (limits && args[0] === "diff") {
        diffs++;
        if (diffs === 1) {
          entered.resolve();
          await release.promise;
          throw new Error("transient read failure");
        }
      }
      return jj(cwd, args, limits);
    },
  });
  const first = service.getCommit({ commitId });
  const second = service.getCommit({ commitId });
  const failures = Promise.all([
    assert.rejects(first, /transient read failure/),
    assert.rejects(second, /transient read failure/),
  ]);
  await entered.promise;
  release.resolve();
  await failures;
  assert.equal(diffs, 1);
  assert.equal((await service.getCommit({ commitId })).commitId, commitId);
  assert.equal(diffs, 2);
  await service.getCommit({ commitId });
  assert.equal(diffs, 2);
});

test("display descriptor LRU enforces both ten-entry and eight-MiB budgets without retaining oversized entries", async (t) => {
  const { root } = await fixture(t);
  const calls = new Map<string, number>();
  const ids = Array.from({ length: 15 }, (_, i) =>
    (i + 1).toString(16).padStart(40, "0"),
  );
  let rowLength = 1;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (_cwd, args) => {
      const expression = args[args.indexOf("-r") + 1];
      const id = /^commit_id\("([0-9a-f]+)"\)$/.exec(expression)?.[1];
      if (args.includes("-r"))
        assert.ok(id, "explicit immutable revision function required");
      if (args[0] === "diff") calls.set(id!, (calls.get(id!) ?? 0) + 1);
      return {
        stderr: "",
        stdout:
          args[0] === "root"
            ? root
            : args[0] === "log"
              ? `${id}\n${"f".repeat(40)}`
              : `diff --git a/file.txt b/file.txt\nnew file mode 100644\n--- /dev/null\n+++ b/file.txt\n@@ -0,0 +1 @@\n+${"x".repeat(rowLength)}\n`,
      };
    },
  });
  for (const commitId of ids.slice(0, 10))
    await service.getCommit({ commitId });
  await service.getCommit({ commitId: ids[0] }); // touch the oldest
  await service.getCommit({ commitId: ids[10] });
  await service.getCommit({ commitId: ids[0] });
  assert.equal(calls.get(ids[0]), 1);
  await service.getCommit({ commitId: ids[1] });
  assert.equal(
    calls.get(ids[1]),
    2,
    "eleventh entry evicted the least-recently used",
  );

  rowLength = 600000; // Each descriptor estimates >2 MiB; fewer than ten fit.
  for (const commitId of ids.slice(11)) await service.getCommit({ commitId });
  await service.getCommit({ commitId: ids[11] });
  assert.equal(
    calls.get(ids[11]),
    2,
    "byte budget evicted a large descriptor before the entry limit",
  );
  await service.getCommit({ commitId: ids[14] });
  assert.equal(
    calls.get(ids[14]),
    1,
    "recent retained descriptor remains warm",
  );

  rowLength = 2096900; // Fits the raw diff limit, exceeds estimated retention budget.
  const oversized = "e".repeat(40);
  await service.getCommit({ commitId: oversized });
  await service.getCommit({ commitId: oversized });
  assert.equal(
    calls.get(oversized),
    2,
    "oversized descriptor was never retained",
  );
  await service.getCommit({ commitId: ids[14] });
  assert.equal(
    calls.get(ids[14]),
    1,
    "oversized descriptor did not evict useful cache entries",
  );
});

test("hex-named source and parent bookmarks cannot redirect cold or cached immutable reads", async (t) => {
  const { root, commitId } = await fixture(t);
  const warm = new ReviewService({ repoPath: root });
  const content = await warm.getCommit({ commitId });
  const filePath = content.files[0].path;
  const expected = await warm.getCommitFile({ commitId, path: filePath });
  assert.notEqual(expected.oldFile!.contents, expected.newFile!.contents);
  await jj(root, [
    "bookmark",
    "create",
    content.baseCommitId!,
    "-r",
    `commit_id("${commitId}")`,
  ]);
  await jj(root, [
    "bookmark",
    "create",
    commitId,
    "-r",
    `commit_id("${content.baseCommitId}")`,
  ]);
  for (const service of [warm, new ReviewService({ repoPath: root })]) {
    assert.deepEqual(await service.getCommit({ commitId }), content);
    assert.deepEqual(
      await service.getCommitFile({ commitId, path: filePath }),
      expected,
    );
  }
});

test("source bookmark introduced between metadata and diff cannot poison the descriptor cache", async (t) => {
  const { root, commitId } = await fixture(t);
  const baseline = new ReviewService({ repoPath: root });
  const expected = await baseline.getCommit({ commitId });
  const filePath = expected.files[0].path;
  const expectedFile = await baseline.getCommitFile({
    commitId,
    path: filePath,
  });
  let injected = false;
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, limits) => {
      calls.push(args);
      if (args[0] === "diff" && !injected) {
        injected = true;
        await jj(root, [
          "bookmark",
          "create",
          commitId,
          "-r",
          `commit_id("${expected.baseCommitId}")`,
        ]);
      }
      return jj(cwd, args, limits);
    },
  });
  assert.deepEqual(await service.getCommit({ commitId }), expected);
  assert.ok(injected);
  assert.deepEqual(await service.getCommit({ commitId }), expected);
  assert.deepEqual(
    await service.getCommitFile({ commitId, path: filePath }),
    expectedFile,
  );
  assert.equal(calls.filter((args) => args[0] === "diff").length, 1);
  for (const args of calls.filter((args) => args.includes("-r")))
    assert.match(
      args[args.indexOf("-r") + 1],
      /^commit_id\("(?:[0-9a-f]{40}|[0-9a-f]{64})"\)$/,
    );
  assert.deepEqual(
    await new ReviewService({ repoPath: root }).getCommit({ commitId }),
    expected,
  );
});
