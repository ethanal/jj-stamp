import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { Request, Response } from "express";
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { ConfigStore, resolveConfigPath } from "../server/config.ts";
import { startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";
import { defaultConfig } from "../src/config.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-config-"));
  const configPath = path.join(root, "settings", "config.json");
  const store = new ConfigStore(configPath);
  t.after(async () => {
    store.close();
    await store.drain();
    await rm(root, { recursive: true, force: true });
  });
  return { root, configPath, store };
}

async function serverFixture(t: TestContext) {
  const fixtureValue = await fixture(t);
  const local = await startLocalServer({
    service: new ReviewService({ repoPath: fixtureValue.root }),
    assetsDir: fixtureValue.root,
    configPath: fixtureValue.configPath,
    port: 0,
  });
  t.after(() => local.close());
  return { ...fixtureValue, local };
}

function post(url: string, value: unknown, extra: Record<string, string> = {}) {
  return fetch(new URL("api/config", url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Fold-Request": "1",
      ...extra,
    },
    body: JSON.stringify(value),
  });
}

async function stream(url: string, t: TestContext) {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(new URL("api/config/events", url), {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  async function next() {
    const timeout = setTimeout(() => controller.abort(), 4000);
    try {
      while (!buffer.includes("\n\n")) {
        const { done, value } = await reader.read();
        assert.equal(done, false, "stream closed before expected event");
        buffer += decoder.decode(value, { stream: true });
      }
      const end = buffer.indexOf("\n\n");
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const lines = event.split("\n");
      return {
        event: lines[0].slice("event: ".length),
        data: JSON.parse(lines[1].slice("data: ".length)),
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { next, controller, reader };
}

test("config path uses absolute XDG_CONFIG_HOME, otherwise the home fallback", () => {
  assert.equal(
    resolveConfigPath({ XDG_CONFIG_HOME: "/settings" }, "/home/test"),
    "/settings/jj-stamp/config.json",
  );
  for (const value of [undefined, "", "relative"]) {
    assert.equal(
      resolveConfigPath({ XDG_CONFIG_HOME: value }, "/home/test"),
      "/home/test/.config/jj-stamp/config.json",
    );
  }
});

test("missing config defaults and reads never create directories or files", async (t) => {
  const { root, store } = await fixture(t);
  assert.deepEqual(await store.read(), defaultConfig);
  assert.deepEqual(await readdir(root), []);
  const copy = await store.read();
  copy["font-size"] = 20;
  assert.deepEqual(await store.read(), defaultConfig);
});

test("patches save full validated private JSON atomically and preserve unrelated keys", async (t) => {
  const { configPath, store } = await fixture(t);
  assert.deepEqual(await store.patch({}), defaultConfig);
  await assert.rejects(stat(path.dirname(configPath)), { code: "ENOENT" });
  const saved = await store.patch({ "font-size": 18, "vim-mode": true });
  assert.deepEqual(saved, {
    ...defaultConfig,
    "font-size": 18,
    "vim-mode": true,
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), saved);
  assert.equal((await stat(configPath)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(configPath))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
  // An open reader must keep seeing the complete old inode after a save:
  // overwriting/truncating the original file in place would fail this check.
  const reader = await open(configPath, "r");
  try {
    await store.patch({ "diff-style": "split" });
    assert.deepEqual(JSON.parse(await reader.readFile("utf8")), saved);
    assert.notEqual((await reader.stat()).ino, (await stat(configPath)).ino);
  } finally {
    await reader.close();
  }
  assert.deepEqual(await store.read(), { ...saved, "diff-style": "split" });
});

test("strict API validation rejects unknown keys, malformed JSON and unsupported values", async (t) => {
  const { local, configPath } = await serverFixture(t);
  for (const value of [
    { unknown: true },
    { "font-size": 9 },
    { "font-size": 25 },
    { "font-size": 12.5 },
    { "vim-mode": "true" },
    { "diff-style": "other" },
    { "log-revset": "  " },
    { "log-revset": "a\0b" },
    { "split-diff-ratio": 81 },
    null,
    [],
  ]) {
    const result = await post(local.url, value);
    assert.equal(result.status, 400, JSON.stringify(value));
    assert.equal((await result.json()).code, "INVALID_REQUEST");
  }
  const malformed = await fetch(new URL("api/config", local.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
    body: "{",
  });
  assert.equal(malformed.status, 400);
  await assert.rejects(stat(configPath), { code: "ENOENT" });
  const response = await fetch(new URL("api/config", local.url));
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), defaultConfig);
  const changed = await post(local.url, { "font-size": 17 });
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { ...defaultConfig, "font-size": 17 });
});

test("partial disk files use defaults, but invalid files are never silently replaced", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, '{"font-size":19}');
  assert.deepEqual(await store.read(), { ...defaultConfig, "font-size": 19 });
  for (const invalid of ["{broken", '{"font-size":null}', '{"unknown":1}']) {
    await writeFile(configPath, invalid);
    await assert.rejects(store.read(), { code: "CONFIG_INVALID" });
    await assert.rejects(store.patch({ "vim-mode": true }), {
      code: "CONFIG_INVALID",
    });
    assert.equal(await readFile(configPath, "utf8"), invalid);
    assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
  }
});

test("oversized and nonregular preferences fail safely without unbounded reads or FIFO waits", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  const oversized = `{"log-revset":"${"x".repeat(65536)}"}`;
  await writeFile(configPath, oversized);
  await assert.rejects(store.read(), { code: "CONFIG_INVALID" });
  await assert.rejects(store.patch({ "font-size": 18 }), {
    code: "CONFIG_INVALID",
  });
  assert.equal(await readFile(configPath, "utf8"), oversized);
  await rm(configPath);
  if (process.platform !== "win32") {
    const fifo = spawn("mkfifo", [configPath]);
    assert.equal((await once(fifo, "exit"))[0], 0);
    await assert.rejects(store.read(), {
      code: "CONFIG_IO",
      message: "Shared preferences must be a regular JSON file.",
    });
  }
});

test("separate stores and processes merge concurrent disjoint patches under the same lock", async (t) => {
  const { store, configPath } = await fixture(t);
  const other = new ConfigStore(configPath);
  t.after(async () => {
    other.close();
    await other.drain();
  });
  await Promise.all([
    store.patch({ "font-size": 16 }),
    other.patch({ "vim-mode": true }),
  ]);
  const moduleUrl = pathToFileURL(path.resolve("server/config.ts")).href;
  async function child(patch: unknown) {
    const script = `import {ConfigStore} from ${JSON.stringify(moduleUrl)}; const s = new ConfigStore(${JSON.stringify(configPath)}); await s.patch(${JSON.stringify(patch)}); s.close(); await s.drain();`;
    const proc = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", script],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = "";
    proc.stderr.on("data", (chunk) => (error += chunk));
    const [code] = await once(proc, "exit");
    assert.equal(code, 0, error);
  }
  await Promise.all([
    child({ "diff-style": "split" }),
    child({ "files-width": 321 }),
  ]);
  assert.deepEqual(await store.read(), {
    ...defaultConfig,
    "font-size": 16,
    "vim-mode": true,
    "diff-style": "split",
    "files-width": 321,
  });
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});

test("a stale lock times out without overwriting preferences or deleting another writer's lock", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(`${configPath}.lock`, "another writer");
  await assert.rejects(store.patch({ "font-size": 18 }), {
    code: "CONFIG_BUSY",
  });
  assert.equal(await readFile(`${configPath}.lock`, "utf8"), "another writer");
  await assert.rejects(stat(configPath), { code: "ENOENT" });
});

test("config streams snapshot and track external writes, rename, invalid/repair, deletion and directory recreation", async (t) => {
  const { local, configPath } = await serverFixture(t);
  const events = await stream(local.url, t);
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
  await assert.rejects(stat(path.dirname(configPath)), { code: "ENOENT" });
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, '{"font-size":18}');
  assert.deepEqual(await events.next(), {
    event: "config",
    data: { ...defaultConfig, "font-size": 18 },
  });
  await writeFile(`${configPath}.external`, '{"vim-mode":true}');
  await rename(`${configPath}.external`, configPath);
  assert.deepEqual(await events.next(), {
    event: "config",
    data: { ...defaultConfig, "vim-mode": true },
  });
  await writeFile(configPath, "{invalid");
  const failure = await events.next();
  assert.equal(failure.event, "config-error");
  assert.equal(typeof failure.data.error, "string");
  assert.ok(!failure.data.error.includes(path.dirname(configPath)));
  const invalidGet = await fetch(new URL("api/config", local.url));
  assert.equal(invalidGet.status, 409);
  assert.equal((await invalidGet.json()).code, "CONFIG_INVALID");
  await writeFile(configPath, '{"vim-mode":true}');
  assert.deepEqual(await events.next(), {
    event: "config",
    data: { ...defaultConfig, "vim-mode": true },
  });
  await rm(path.dirname(configPath), { recursive: true });
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, '{"font-size":21}');
  assert.deepEqual(await events.next(), {
    event: "config",
    data: { ...defaultConfig, "font-size": 21 },
  });
  await local.close();
  assert.equal((await events.reader.read()).done, true);
});

test("invalid initial config provides a snapshot then an error and recovers", async (t) => {
  const { local, configPath } = await serverFixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, "invalid");
  const events = await stream(local.url, t);
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
  assert.equal((await events.next()).event, "config-error");
  await writeFile(configPath, "{}");
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
});

test("read failures use safe errors and repair without replacing the unreadable entry", async (t) => {
  const { local, configPath } = await serverFixture(t);
  const events = await stream(local.url, t);
  await events.next();
  await mkdir(configPath, { recursive: true });
  const failure = await events.next();
  assert.equal(failure.event, "config-error");
  assert.ok(!failure.data.error.includes(configPath));
  const response = await post(local.url, { "font-size": 18 });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).code, "CONFIG_IO");
  assert.equal((await stat(configPath)).isDirectory(), true);
  await rm(configPath, { recursive: true });
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
});

test("HEAD allocates no config stream, clients are bounded and disconnect releases slots", async (t) => {
  const { root, configPath } = await fixture(t);
  const express = (await import("express")).default;
  const { createConfigApi } = await import("../server/config.ts");
  const api = createConfigApi({ configPath, maxEventClients: 1 });
  const app = express();
  app.use("/api/config", api);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  t.after(async () => {
    api.close();
    await api.drain();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const head = await fetch(new URL("api/config/events", url), {
    method: "HEAD",
  });
  assert.equal(head.status, 204);
  const first = await stream(url, t);
  await first.next();
  const rejected = await fetch(new URL("api/config/events", url));
  assert.equal(rejected.status, 503);
  first.controller.abort();
  // Process the response close before reusing the single subscriber slot.
  await delay(50);
  const next = await stream(url, t);
  assert.equal((await next.next()).event, "config");
  assert.deepEqual(await readdir(root), []);
});

test("shutdown drains writes already accepted, clears lock/temp resources and rejects new work", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(`${configPath}.lock`, "test");
  const accepted = store.patch({ "font-size": 18 });
  store.close();
  const drained = store.drain();
  await rm(`${configPath}.lock`);
  await drained;
  assert.equal((await accepted)["font-size"], 18);
  assert.equal(JSON.parse(await readFile(configPath, "utf8"))["font-size"], 18);
  await assert.rejects(store.patch({ "vim-mode": true }), {
    code: "SHUTTING_DOWN",
  });
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});

test("pending config tasks are bounded and overload does not lose accepted work", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(`${configPath}.lock`, "test");
  const pending: Array<Promise<unknown>> = [store.patch({ "font-size": 18 })];
  for (let index = 0; index < 63; index++) pending.push(store.read());
  await assert.rejects(store.read(), { code: "CONFIG_BUSY" });
  await assert.rejects(store.patch({ "vim-mode": true }), {
    code: "CONFIG_BUSY",
  });
  await rm(`${configPath}.lock`);
  await Promise.all(pending);
  assert.equal((await store.read())["font-size"], 18);
  assert.equal((await store.read())["vim-mode"], false);
});

test("slow stream clients have bounded frames and all event listeners are cleaned up", async (t) => {
  const { store } = await fixture(t);
  const request = new EventEmitter();
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: () => response,
    set: () => response,
    flushHeaders: () => {},
    write: () => false,
    end: () => {
      response.writableEnded = true;
    },
    destroy: () => {
      response.destroyed = true;
    },
  });
  store.connect(request as Request, response as unknown as Response);
  // Wait for the queued initial snapshot to block on response backpressure.
  await store.drain();
  assert.equal(response.listenerCount("drain"), 1);
  for (let index = 0; index < 18; index++)
    await store.patch({ "font-size": index % 2 ? 17 : 18 });
  assert.equal(response.destroyed, true);
  assert.equal(response.listenerCount("drain"), 0);
  assert.equal(response.listenerCount("close"), 0);
  assert.equal(request.listenerCount("aborted"), 0);
  assert.equal((await store.read())["font-size"], 17);
});

test("HTTP shutdown waits for a disconnected accepted config write", async (t) => {
  const { local, configPath } = await serverFixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(`${configPath}.lock`, "test");
  const req = request(new URL("api/config", local.url), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
  });
  req.on("error", () => {});
  req.end('{"font-size":18}');
  // The server must have accepted the JSON before initiating shutdown.
  await delay(80);
  req.destroy();
  const closed = local.close();
  await rm(`${configPath}.lock`);
  await closed;
  assert.equal(JSON.parse(await readFile(configPath, "utf8"))["font-size"], 18);
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});

test("config routes retain loopback host, origin, fetch-site and mutation protections", async (t) => {
  const { local } = await serverFixture(t);
  for (const endpoint of ["api/config", "api/config/events"]) {
    for (const headers of [
      { Origin: "https://evil.example" },
      { Host: "evil.example" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          new URL(endpoint, local.url),
          { headers },
          (response) => {
            resolve(response.statusCode!);
            response.destroy();
          },
        );
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 403, `${endpoint}: ${JSON.stringify(headers)}`);
    }
  }
  for (const headers of [
    { "Content-Type": "application/json" },
    { "Content-Type": "text/plain", "X-Fold-Request": "1" },
  ]) {
    const result = await fetch(new URL("api/config", local.url), {
      method: "POST",
      headers: headers as Record<string, string>,
      body: '{"font-size":18}',
    });
    assert.equal(result.status, 403);
  }
  assert.equal(
    (
      await post(
        local.url,
        { "font-size": 18 },
        { Origin: "https://evil.example" },
      )
    ).status,
    403,
  );
});
