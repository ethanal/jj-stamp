import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  request,
  type ClientRequest,
  type IncomingMessage,
} from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { createApi } from "../server/api.ts";
import {
  watchFilesystemEvents,
  watchFilesystemEventsForTest,
  watchFilesystemEventsWithLimit,
  type FilesystemChange,
  type FilesystemEventBackend,
  type FilesystemEventHandlers,
} from "../server/fs-events.ts";
import { startLocalServer } from "../server/http.ts";
import { jj } from "../server/process.ts";
import { ReviewService } from "../server/service.ts";

const HEAD_A = "a".repeat(128);
const HEAD_B = "b".repeat(128);

async function eventually(
  predicate: () => boolean,
  message: string,
  timeout = 4000,
) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function quiet(ms = 125) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fakeWorkspace(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-events-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".jj/repo/op_heads/heads"), {
    recursive: true,
  });
  await writeFile(path.join(root, ".jj/repo/op_heads/heads", HEAD_A), "");
  return root;
}

async function collectWatcher(root: string, paths: readonly string[]) {
  const changes: FilesystemChange[] = [];
  const unavailableErrors: unknown[] = [];
  const controller = new AbortController();
  const watcher = await watchFilesystemEvents(
    root,
    {
      change: (change) => changes.push(change),
      unavailable: (error) => unavailableErrors.push(error),
    },
    controller.signal,
    paths,
  );
  return {
    changes,
    watcher,
    unavailable: () => unavailableErrors.length,
    unavailableErrors,
  };
}

test("scoped watcher reports leaf edits and atomic saves but ignores unrelated siblings", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await mkdir(path.join(root, "src/b"), { recursive: true });
  await writeFile(path.join(root, "src/a/file.ts"), "one");
  const observed = await collectWatcher(root, ["src/a/file.ts"]);
  t.after(() => observed.watcher.close());

  await writeFile(path.join(root, "cache.txt"), "ignored");
  await writeFile(path.join(root, "src/b/other.ts"), "ignored");
  await quiet(150);
  assert.equal(observed.changes.length, 0);

  await writeFile(path.join(root, "src/a/file.ts"), "two");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "ordinary scoped file write was not reported",
  );
  assert.deepEqual(observed.changes.at(-1)?.heads, [HEAD_A]);

  observed.changes.length = 0;
  await writeFile(path.join(root, "src/a/.file.ts.tmp"), "three");
  await rename(
    path.join(root, "src/a/.file.ts.tmp"),
    path.join(root, "src/a/file.ts"),
  );
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "atomic save in the scoped directory was not reported",
  );

  observed.changes.length = 0;
  await writeFile(path.join(root, ".jj/repo/op_heads/heads", HEAD_B), "");
  await rm(path.join(root, ".jj/repo/op_heads/heads", HEAD_A));
  await eventually(
    () =>
      observed.changes.some(
        (change) =>
          !change.workspace &&
          change.heads?.length === 1 &&
          change.heads[0] === HEAD_B,
      ),
    "operation-head replacement was not reported",
  );
  assert.equal(observed.unavailable(), 0);
});

test("large unrelated trees are never traversed or counted", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await writeFile(path.join(root, "src/a/file.ts"), "one");
  for (let index = 0; index < 20; index++)
    await mkdir(path.join(root, `generated/${index}/deep/tree`), {
      recursive: true,
    });
  const watched: string[] = [];
  const watcher = await watchFilesystemEventsForTest({
    maxDirectories: 3,
    afterDirectoryWatch: async (directory) => {
      watched.push(path.relative(root, directory) || ".");
    },
  })(root, { change() {}, unavailable() {} }, new AbortController().signal, [
    "src/a/file.ts",
  ]);
  t.after(() => watcher.close());
  assert.deepEqual(watched.sort(), [".", "src", "src/a"]);
});

test("a root changed file watches only the root nonrecursively", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "node_modules/pkg/deep"), { recursive: true });
  await writeFile(path.join(root, "README.md"), "one");
  const watched: string[] = [];
  const changes: FilesystemChange[] = [];
  const watcher = await watchFilesystemEventsForTest({
    maxDirectories: 1,
    afterDirectoryWatch: async (directory) => {
      watched.push(path.relative(root, directory) || ".");
    },
  })(
    root,
    { change: (change) => changes.push(change), unavailable() {} },
    new AbortController().signal,
    ["README.md"],
  );
  t.after(() => watcher.close());
  assert.deepEqual(watched, ["."]);

  await writeFile(path.join(root, "node_modules/pkg/deep/file.js"), "ignored");
  await quiet(150);
  assert.equal(changes.length, 0);
  await writeFile(path.join(root, "README.md"), "two");
  await eventually(
    () => changes.some((change) => change.workspace),
    "root file edit was not reported",
  );
});

test("deleted or initially missing scoped directories are guarded until recreated", async (t) => {
  const root = await fakeWorkspace(t);
  const observed = await collectWatcher(root, ["src/a/file.ts"]);
  t.after(() => observed.watcher.close());

  await writeFile(path.join(root, "unrelated"), "ignored");
  await quiet(100);
  assert.deepEqual(observed.changes, []);
  await mkdir(path.join(root, "src"));
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "creation of the first scoped directory was not reported",
  );
  await quiet(100);
  observed.changes.length = 0;
  await mkdir(path.join(root, "src/a"));
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "creation of the leaf scoped directory was not reported",
  );
  await quiet(100);
  observed.changes.length = 0;
  await writeFile(path.join(root, "src/a/file.ts"), "created");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "file in a recreated scoped directory was not reported",
  );

  await quiet(100);
  observed.changes.length = 0;
  await rm(path.join(root, "src"), { recursive: true });
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "scoped directory deletion was not reported",
  );
  await quiet(150);
  observed.changes.length = 0;
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "recreated scoped directory was not reported",
  );
  await quiet(150);
  observed.changes.length = 0;
  await writeFile(path.join(root, "src/a/later.ts"), "later");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "recreated scoped directory did not regain its watcher",
  );
});

test("same-path replacement reattaches the scoped watcher without following symlinks", async (t) => {
  const root = await fakeWorkspace(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, "swap/nested"), { recursive: true });
  const observed = await collectWatcher(root, ["swap/nested/file.ts"]);
  t.after(() => observed.watcher.close());

  await rm(path.join(root, "swap"), { recursive: true });
  await symlink(outside, path.join(root, "swap"), "dir");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "symlink replacement was not reported",
  );
  await quiet(150);
  observed.changes.length = 0;
  await mkdir(path.join(outside, "nested"));
  await writeFile(path.join(outside, "nested/escaped.ts"), "outside");
  await quiet(150);
  assert.deepEqual(observed.changes, []);

  await rm(path.join(root, "swap"));
  await mkdir(path.join(root, "swap/nested"), { recursive: true });
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "same-path directory recreation was not reported",
  );
  await quiet(150);
  observed.changes.length = 0;
  await writeFile(path.join(root, "swap/nested/later.txt"), "later");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "replacement directory remained bound to the deleted inode",
  );
  assert.equal(observed.unavailable(), 0);
});

test("delete and recreate of the same scoped directory forcefully reattaches its watcher", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "src/a"), { recursive: true });
  await writeFile(path.join(root, "src/a/file.ts"), "before");
  const observed = await collectWatcher(root, ["src/a/file.ts"]);
  t.after(() => observed.watcher.close());

  await rm(path.join(root, "src/a"), { recursive: true });
  await mkdir(path.join(root, "src/a"));
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "delete and recreation of the scoped directory was not reported",
  );
  await quiet(200);
  observed.changes.length = 0;
  await writeFile(path.join(root, "src/a/later.ts"), "later");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "recreated same-path directory retained a stale native watcher",
  );
  assert.equal(observed.unavailable(), 0);
});

test("watch directory count is bounded by explicit scopes and ancestors", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "one/two"), { recursive: true });
  const controller = new AbortController();
  await assert.rejects(
    watchFilesystemEventsWithLimit(2)(
      root,
      { change() {}, unavailable() {} },
      controller.signal,
      ["one/two/file.ts"],
    ),
    /selected workspace scopes and their ancestors.*limit 2/i,
  );
});

test("native setup cancellation closes a provisional scoped watcher", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "src"));
  let entered!: () => void;
  const watching = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const changes: FilesystemChange[] = [];
  const controller = new AbortController();
  const pending = watchFilesystemEventsForTest({
    afterDirectoryWatch: async () => {
      entered();
      await blocked;
    },
  })(
    root,
    { change: (change) => changes.push(change), unavailable() {} },
    controller.signal,
    ["src/file.ts"],
  );
  await watching;
  controller.abort();
  release();
  await assert.rejects(pending, { name: "AbortError" });
  await writeFile(path.join(root, "src/after-cancel"), "closed");
  await quiet(100);
  assert.deepEqual(changes, []);
});

test("dynamic scopes serialize, invalidate additions once, and remove old watches", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "old"));
  await mkdir(path.join(root, "next"));
  const observed = await collectWatcher(root, ["old/file.ts"]);
  t.after(() => observed.watcher.close());

  observed.watcher.setPaths(["next/one.ts", "next/two.ts"]);
  await eventually(
    () => observed.changes.filter((change) => change.workspace).length === 1,
    "adding a new directory scope did not emit one gap invalidation",
  );
  await quiet(100);
  assert.equal(observed.changes.length, 1);

  observed.changes.length = 0;
  observed.watcher.setPaths(["next/renamed.ts"]);
  await quiet(150);
  assert.deepEqual(
    observed.changes,
    [],
    "an identical containing-directory scope caused read feedback",
  );
  await writeFile(path.join(root, "old/ignored.ts"), "old");
  await quiet(150);
  assert.deepEqual(observed.changes, []);
  await writeFile(path.join(root, "next/observed.ts"), "next");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "new scope was not active",
  );

  observed.changes.length = 0;
  observed.watcher.setPaths([]);
  await quiet(150);
  assert.deepEqual(
    observed.changes,
    [],
    "removal-only update emitted a change",
  );
  await writeFile(path.join(root, "next/after-remove.ts"), "ignored");
  await quiet(150);
  assert.deepEqual(observed.changes, []);
});

test("superseded scope work cannot resurrect stale watches or leak after close", async (t) => {
  const root = await fakeWorkspace(t);
  for (const directory of ["old", "stale", "latest", "closing"])
    await mkdir(path.join(root, directory));
  let blockedDirectory = "";
  let entered!: () => void;
  let watching = new Promise<void>((resolve) => (entered = resolve));
  let release!: () => void;
  let gate = new Promise<void>((resolve) => (release = resolve));
  const changes: FilesystemChange[] = [];
  const unavailable: unknown[] = [];
  const watcher = await watchFilesystemEventsForTest({
    afterDirectoryWatch: async (directory) => {
      if (path.basename(directory) !== blockedDirectory) return;
      entered();
      await gate;
    },
  })(
    root,
    {
      change: (change) => changes.push(change),
      unavailable: (error) => unavailable.push(error),
    },
    new AbortController().signal,
    ["old/file.ts"],
  );

  blockedDirectory = "stale";
  watcher.setPaths(["stale/file.ts"]);
  await watching;
  watcher.setPaths(["latest/file.ts"]);
  release();
  await eventually(
    () => changes.some((change) => change.workspace),
    "latest scope reconciliation did not finish",
  );
  await quiet(100);
  changes.length = 0;
  await writeFile(path.join(root, "stale/ignored.ts"), "stale");
  await quiet(150);
  assert.equal(changes.length, 0);
  await writeFile(path.join(root, "latest/observed.ts"), "latest");
  await eventually(
    () => changes.some((change) => change.workspace),
    "superseding scope was not installed",
  );

  await quiet(100);
  changes.length = 0;
  blockedDirectory = "closing";
  watching = new Promise<void>((resolve) => (entered = resolve));
  gate = new Promise<void>((resolve) => (release = resolve));
  watcher.setPaths(["closing/file.ts"]);
  await watching;
  watcher.close();
  release();
  await writeFile(path.join(root, "closing/after-close.ts"), "closed");
  await quiet(150);
  assert.equal(changes.length, 0);
  assert.equal(unavailable.length, 0);
});

test("empty paths watch only operation heads", async (t) => {
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "huge/deep/tree"), { recursive: true });
  const observed = await collectWatcher(root, []);
  t.after(() => observed.watcher.close());
  await writeFile(path.join(root, "workspace.txt"), "ignored");
  await writeFile(path.join(root, "huge/deep/tree/file.ts"), "ignored");
  await quiet(150);
  assert.deepEqual(observed.changes, []);
  await writeFile(path.join(root, ".jj/repo/op_heads/heads", HEAD_B), "");
  await eventually(
    () => observed.changes.some((change) => change.heads?.includes(HEAD_B)),
    "operation heads were not watched with an empty diff",
  );
});

test("unsafe scope paths fail closed", async (t) => {
  const root = await fakeWorkspace(t);
  for (const selectedPath of [
    "/absolute/file.ts",
    "../escape.ts",
    "src/../escape.ts",
    ".jj/repo/file",
    ".git/index",
  ]) {
    await assert.rejects(
      watchFilesystemEvents(
        root,
        { change() {}, unavailable() {} },
        new AbortController().signal,
        [selectedPath],
      ),
      { code: "WATCH_UNSAFE_WORKSPACE" },
    );
  }
});

test("head reads are serialized and retain invalidations that arrive during a slow read", async (t) => {
  const root = await fakeWorkspace(t);
  const HEAD_C = "c".repeat(128);
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let slowStarted!: () => void;
  const started = new Promise<void>((resolve) => (slowStarted = resolve));
  let releaseSlow!: () => void;
  const slow = new Promise<void>((resolve) => (releaseSlow = resolve));
  const changes: FilesystemChange[] = [];
  const backend = watchFilesystemEventsForTest({
    readHeads: async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) return [HEAD_A];
        if (calls === 2) {
          slowStarted();
          await slow;
          return [HEAD_A];
        }
        return [HEAD_C];
      } finally {
        active--;
      }
    },
  });
  const watcher = await backend(
    root,
    { change: (change) => changes.push(change), unavailable() {} },
    new AbortController().signal,
    [],
  );
  t.after(() => watcher.close());

  await writeFile(path.join(root, ".jj/repo/op_heads/heads", HEAD_B), "");
  await started;
  await writeFile(path.join(root, ".jj/repo/op_heads/heads", HEAD_C), "");
  releaseSlow();
  await eventually(
    () => changes.some((change) => change.heads?.[0] === HEAD_C),
    "newer head invalidation was lost behind a slow read",
  );
  assert.equal(maxActive, 1);
  assert.equal(changes.at(-1)?.heads?.[0], HEAD_C);
});

test("more than 64 operation heads are represented as null", async (t) => {
  const root = await fakeWorkspace(t);
  await rm(path.join(root, ".jj/repo/op_heads/heads", HEAD_A));
  for (let index = 0; index < 65; index++) {
    await writeFile(
      path.join(
        root,
        ".jj/repo/op_heads/heads",
        index.toString(16).padStart(128, "0"),
      ),
      "",
    );
  }
  const observed = await collectWatcher(root, ["workspace.txt"]);
  t.after(() => observed.watcher.close());
  await writeFile(path.join(root, "workspace.txt"), "change");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "workspace change was not reported with many heads",
  );
  assert.equal(observed.changes.at(-1)?.heads, null);
});

test("symlinked repository metadata and linked targets fail closed", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-events-links-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const metadata = path.join(base, "metadata");
  await mkdir(path.join(metadata, "repo/op_heads/heads"), { recursive: true });
  await writeFile(path.join(metadata, "repo/op_heads/heads", HEAD_A), "");

  const symlinkedJj = path.join(base, "symlinked-jj");
  await mkdir(symlinkedJj);
  await symlink(metadata, path.join(symlinkedJj, ".jj"), "dir");
  await assert.rejects(
    watchFilesystemEvents(
      symlinkedJj,
      { change() {}, unavailable() {} },
      new AbortController().signal,
      [],
    ),
    { code: "WATCH_UNSAFE_METADATA" },
  );

  const linked = path.join(base, "linked-target");
  await mkdir(path.join(linked, ".jj"), { recursive: true });
  await symlink(metadata, path.join(base, "metadata-link"), "dir");
  await writeFile(path.join(linked, ".jj/repo"), "../../metadata-link/repo");
  await assert.rejects(
    watchFilesystemEvents(
      linked,
      { change() {}, unavailable() {} },
      new AbortController().signal,
      [],
    ),
    { code: "WATCH_UNSAFE_METADATA" },
  );
});

test("a warm service exposes its watch root without another subprocess", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-watch-root-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  await jj(base, ["git", "init", "--no-colocate", root]);
  let subprocesses = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, options) => {
      subprocesses++;
      return jj(cwd, args, options);
    },
  });
  await service.getState();
  const warmCount = subprocesses;
  assert.equal(await service.getWatchRoot(), await realpath(root));
  assert.equal(subprocesses, warmCount);
});

test("service drain waits for a cold event-root initialization", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-watch-drain-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  await jj(base, ["git", "init", "--no-colocate", root]);
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args, options) => {
      if (first) {
        first = false;
        started();
        await blocked;
      }
      return jj(cwd, args, options);
    },
  });
  const watchRoot = service.getWatchRoot();
  await firstStarted;
  let drained = false;
  const drain = service.drain().then(() => (drained = true));
  await quiet(50);
  assert.equal(drained, false);
  release();
  await Promise.all([watchRoot, drain]);
  assert.equal(drained, true);
});

test("failed cold initialization is awaited but does not reject drain", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-watch-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => (started = resolve));
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve));
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async () => {
      started();
      await blocked;
      throw new Error("expected initialization failure");
    },
  });
  const initialization = service.getWatchRoot();
  await firstStarted;
  let drained = false;
  const drain = service.drain().then(() => (drained = true));
  await quiet(50);
  assert.equal(drained, false);
  release();
  await assert.rejects(initialization, /expected initialization failure/);
  await drain;
  assert.equal(drained, true);
});

test("real linked jj workspace resolves shared operation heads and keeps workspace changes distinct", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-linked-events-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const main = path.join(base, "main");
  const linked = path.join(base, "linked");
  await jj(base, ["git", "init", "--no-colocate", main]);
  await jj(main, ["workspace", "add", linked]);
  const observed = await collectWatcher(linked, ["linked-file.txt"]);
  t.after(() => observed.watcher.close());

  await writeFile(path.join(linked, "linked-file.txt"), "workspace bytes");
  await eventually(
    () => observed.changes.some((change) => change.workspace),
    "linked workspace file was not reported",
  );

  await quiet();
  observed.changes.length = 0;
  await jj(main, ["describe", "-m", "shared operation changed"]);
  const expectedHeads = (
    await readdir(path.join(main, ".jj/repo/op_heads/heads"))
  )
    .filter((name) => name !== "lock")
    .sort();
  await eventually(
    () =>
      observed.changes.some(
        (change) =>
          change.workspace === false &&
          JSON.stringify(change.heads) === JSON.stringify(expectedHeads),
      ),
    "shared operation heads were not reported to the linked workspace",
  );
  assert.ok(expectedHeads.every((head) => /^[0-9a-f]{32,128}$/.test(head)));
});

interface SseConnection {
  request: ClientRequest;
  response: IncomingMessage;
  ended: Promise<void>;
  text(): string;
}

function connectSse(url: string, headers: Record<string, string> = {}) {
  return new Promise<SseConnection>((resolve, reject) => {
    let body = "";
    const req = request(url, { headers }, (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("error", reject);
      const ended = new Promise<void>((resolveEnded) => {
        if (response.complete) resolveEnded();
        else {
          const done = () => resolveEnded();
          response.once("end", done);
          response.once("close", done);
        }
      });
      resolve({ request: req, response, ended, text: () => body });
    });
    req.on("error", reject);
    req.end();
  });
}

async function injectedServer(
  service: ReviewService,
  backend: FilesystemEventBackend,
  maxEventClients = 32,
) {
  if (!(service instanceof ReviewService)) {
    const fake = service as ReviewService & {
      getWatchPaths?: () => string[];
      subscribeWatchPaths?: (listener: (paths: string[]) => void) => () => void;
    };
    fake.getWatchPaths ??= () => [];
    fake.subscribeWatchPaths ??= () => () => {};
  }
  const app = express();
  const api = createApi(service, { eventBackend: backend, maxEventClients });
  app.use("/api", api);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    api,
    server,
    url: `http://127.0.0.1:${address.port}/api/events`,
    async close() {
      api.closeEvents();
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

// A production HTTP connection verifies middleware, SSE framing, and graceful
// shutdown together; deterministic backend lifecycle behavior is covered by
// the injected-router test below.
test("HTTP events are same-origin SSE and server shutdown closes the stream", async (t) => {
  const root = await fakeWorkspace(t);
  const assetsDir = path.join(root, "client");
  await mkdir(assetsDir);
  await writeFile(path.join(assetsDir, "index.html"), "ok");
  const service = {
    getWatchRoot: async () => root,
    getWatchPaths: () => ["visible.txt"],
    subscribeWatchPaths: () => () => {},
    drain: async () => {},
  } as unknown as ReviewService;
  const local = await startLocalServer({ service, assetsDir, port: 0 });
  t.after(() => local.close());

  const forbidden = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = request(
        new URL("api/events", local.url),
        { headers: { Origin: "http://attacker.invalid" } },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => (body += chunk));
          response.on("end", () =>
            resolve({ status: response.statusCode!, body }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.body, /FORBIDDEN/);

  const stream = await connectSse(new URL("api/events", local.url).href);
  assert.equal(stream.response.statusCode, 200);
  assert.match(stream.response.headers["content-type"]!, /text\/event-stream/);
  await eventually(
    () => stream.text().includes("event: ready\n"),
    "missing ready event",
  );
  await writeFile(path.join(root, "visible.txt"), "changed");
  await eventually(
    () => stream.text().includes("event: change\n"),
    "missing filesystem change event",
  );
  assert.doesNotMatch(stream.text(), /visible\.txt|jj-stamp-events-/);

  await local.close();
  await stream.ended;
});

test("API shares one lazy watcher, bounds clients, emits path-free data, and cleans up the last subscriber", async (t) => {
  let starts = 0;
  let closes = 0;
  let handlers: FilesystemEventHandlers | undefined;
  const backend: FilesystemEventBackend = async (_root, next) => {
    starts++;
    handlers = next;
    return { setPaths() {}, close: () => closes++ };
  };
  const service = {
    getWatchRoot: async () => "/unused",
  } as ReviewService;
  const local = await injectedServer(service, backend, 1);
  t.after(() => local.close());

  const head = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      let body = "";
      const req = request(local.url, { method: "HEAD" }, (response) => {
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      });
      req.on("error", reject);
      req.end();
    },
  );
  assert.deepEqual(head, { status: 204, body: "" });
  assert.equal(starts, 0);

  const first = await connectSse(local.url);
  await eventually(
    () => first.text().includes("event: ready\n"),
    "missing ready event",
  );
  assert.equal(starts, 1);

  const refused = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      const req = request(local.url, (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode!, body }),
        );
      });
      req.on("error", reject);
      req.end();
    },
  );
  assert.equal(refused.status, 503);
  assert.match(refused.body, /BUSY/);

  handlers!.change({ workspace: true, heads: [HEAD_B] });
  await eventually(
    () => first.text().includes('data: {"workspace":true,"heads":['),
    "missing change data",
  );
  assert.doesNotMatch(first.text(), /path|unused/);

  handlers!.change({
    workspace: false,
    heads: Array.from({ length: 65 }, (_, index) =>
      index.toString(16).padStart(128, "0"),
    ),
  });
  await eventually(
    () => first.text().includes('data: {"workspace":false,"heads":null}'),
    "oversized head hints were not bounded at the SSE boundary",
  );

  first.request.destroy();
  first.response.destroy();
  await eventually(() => closes === 1, "last subscriber did not close watcher");

  const second = await connectSse(local.url);
  await eventually(
    () => second.text().includes("event: ready\n"),
    "watcher did not restart for a new subscriber",
  );
  assert.equal(starts, 2);
  local.api.closeEvents();
  await second.ended;
  assert.equal(closes, 2);
});

test("native first-initialization failures emit unavailable before ending", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-events-broken-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".jj/repo/op_heads"), { recursive: true });
  const service = {
    getWatchRoot: async () => root,
  } as ReviewService;
  const local = await injectedServer(service, watchFilesystemEvents);
  t.after(() => local.close());

  const stream = await connectSse(local.url);
  await stream.ended;
  assert.match(
    stream.text(),
    /event: unavailable\ndata: \{"code":"WATCH_HEADS_UNAVAILABLE","message":/,
  );
});

test("watcher setup failures emit unavailable and end without restarting", async (t) => {
  let starts = 0;
  const backend: FilesystemEventBackend = async () => {
    starts++;
    throw new Error("watch unavailable at a private path");
  };
  const service = {
    getWatchRoot: async () => "/private/root",
  } as ReviewService;
  const local = await injectedServer(service, backend);
  t.after(() => local.close());

  const first = await connectSse(local.url);
  await first.ended;
  assert.match(
    first.text(),
    /event: unavailable\ndata: \{"code":"WATCH_UNAVAILABLE","message":/,
  );
  assert.doesNotMatch(first.text(), /private|path/);

  const second = await connectSse(local.url);
  await second.ended;
  assert.match(second.text(), /event: unavailable/);
  assert.equal(starts, 1);
});

test("disconnect cancels pending initialization before a backend is created", async (t) => {
  let resolveRoot!: (root: string) => void;
  const root = new Promise<string>((resolve) => (resolveRoot = resolve));
  let starts = 0;
  const backend: FilesystemEventBackend = async () => {
    starts++;
    return { setPaths() {}, close() {} };
  };
  const service = {
    getWatchRoot: () => root,
  } as ReviewService;
  const local = await injectedServer(service, backend);
  t.after(() => local.close());

  const connection = connectSse(local.url);
  // Headers are flushed before root initialization, so the connection exists
  // while setup is pending and can be cancelled by its owner.
  const stream = await connection;
  stream.request.destroy();
  stream.response.destroy();
  await quiet(50);
  resolveRoot("/unused");
  await quiet();
  assert.equal(starts, 0);
});

function failurePayload(stream: SseConnection) {
  const data = /event: unavailable\ndata: ([^\n]+)/.exec(stream.text())?.[1];
  assert(data, "expected an unavailable event with diagnostics");
  return JSON.parse(data) as { code: string; message: string };
}

function captureWarnings(t: TestContext) {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  t.after(() => {
    console.warn = original;
  });
  return warnings;
}

test("directory-limit failures report the actual limit and persist across reconnects", async (t) => {
  const warnings = captureWarnings(t);
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "src"));
  const service = {
    getWatchRoot: async () => root,
    getWatchPaths: () => ["src/file.ts"],
    subscribeWatchPaths: () => () => {},
  } as unknown as ReviewService;
  const local = await injectedServer(
    service,
    watchFilesystemEventsWithLimit(1),
  );
  t.after(() => local.close());
  const first = await connectSse(local.url);
  await first.ended;
  const failure = failurePayload(first);
  assert.equal(failure.code, "WATCH_DIRECTORY_LIMIT");
  assert.match(failure.message, /limit 1/);
  assert.match(
    failure.message,
    /selected workspace scopes and their ancestors/i,
  );
  assert.doesNotMatch(first.text(), new RegExp(root));
  assert.equal(warnings.length, 1);
  const second = await connectSse(local.url);
  await second.ended;
  assert.deepEqual(failurePayload(second), failure);
  assert.equal(warnings.length, 1, "reconnects must not spam the terminal");
});

test("runtime watcher failures preserve the OS error without exposing filenames in SSE", async (t) => {
  const warnings = captureWarnings(t);
  let handlers!: FilesystemEventHandlers;
  let closes = 0;
  const backend: FilesystemEventBackend = async (_root, next) => {
    handlers = next;
    return {
      setPaths() {},
      close: () => {
        closes++;
      },
    };
  };
  const local = await injectedServer(
    { getWatchRoot: async () => "/unused" } as ReviewService,
    backend,
  );
  t.after(() => local.close());
  const stream = await connectSse(local.url);
  await eventually(
    () => stream.text().includes("event: ready"),
    "missing ready event",
  );
  const original = Object.assign(
    new Error("ENOSPC: watch '/private/project/file'"),
    { code: "ENOSPC" },
  );
  handlers.unavailable(original);
  await stream.ended;
  const failure = failurePayload(stream);
  assert.equal(failure.code, "ENOSPC");
  assert.match(failure.message, /watch\/resource limits/);
  assert.doesNotMatch(stream.text(), /private|project/);
  assert.equal(closes, 1);
  assert.equal(warnings.length, 1);
  assert.equal(
    warnings[0][1],
    original,
    "terminal retains the original filesystem error",
  );
  handlers.unavailable(original);
  assert.equal(warnings.length, 1);
});

test("native runtime scope errors reach the stream with a useful failure code", async (t) => {
  captureWarnings(t);
  const root = await fakeWorkspace(t);
  await mkdir(path.join(root, "over-limit"));
  let update!: (paths: string[]) => void;
  const service = {
    getWatchRoot: async () => root,
    getWatchPaths: () => [],
    subscribeWatchPaths: (listener: (paths: string[]) => void) => {
      update = listener;
      return () => {};
    },
  } as unknown as ReviewService;
  const local = await injectedServer(
    service,
    watchFilesystemEventsWithLimit(1),
  );
  t.after(() => local.close());
  const stream = await connectSse(local.url);
  await eventually(
    () => stream.text().includes("event: ready"),
    "missing ready event",
  );
  update(["over-limit/file.ts"]);
  await stream.ended;
  assert.equal(failurePayload(stream).code, "WATCH_DIRECTORY_LIMIT");
});
