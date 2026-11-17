import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import type { Request, Response } from "express";
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
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
  assert.deepEqual(
    await store.patch({ "font-size": undefined }),
    defaultConfig,
  );
  assert.deepEqual(await readdir(root), []);
  const copy = await store.read();
  copy["font-size"] = 20;
  assert.deepEqual(await store.read(), defaultConfig);
});

test("default shell is read-only backend metadata, separate from config writes and events", async (t) => {
  const { root, local, configPath } = await serverFixture(t);
  const previous = process.env.SHELL;
  process.env.SHELL = "/backend/default-shell";
  t.after(() => {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  });
  const endpoint = new URL("api/config/default-shell", local.url);
  // Query values cannot override server metadata or start a shell.
  endpoint.search = "?shell=/request/shell&defaultShell=/another";
  const metadata = await fetch(endpoint);
  assert.equal(metadata.status, 200);
  assert.equal(metadata.headers.get("cache-control"), "no-store");
  assert.deepEqual(await metadata.json(), { shell: "/backend/default-shell" });
  assert.deepEqual(await readdir(root), []);
  const events = await stream(local.url, t);
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
  const response = await post(local.url, { shell: "/configured/shell" });
  const saved = { ...defaultConfig, shell: "/configured/shell" };
  assert.deepEqual(await response.json(), saved);
  assert.deepEqual(await events.next(), { event: "config", data: saved });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), saved);
  assert.deepEqual(
    await (await fetch(new URL("api/config", local.url))).json(),
    saved,
  );
  assert.deepEqual(await (await fetch(endpoint)).json(), {
    shell: "/backend/default-shell",
  });
  for (const key of ["defaultShell", "default-shell"]) {
    assert.equal(
      (await post(local.url, { [key]: "/injected/shell" })).status,
      400,
    );
  }
  const mutation = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
    body: JSON.stringify({ shell: "/injected/shell" }),
  });
  assert.equal(mutation.status, 404);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), saved);
});

test("default shell metadata uses account fallback and exposes invalid SHELL without breaking config", async (t) => {
  const { root, local } = await serverFixture(t);
  const previous = process.env.SHELL;
  delete process.env.SHELL;
  t.after(() => {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  });
  t.mock.method(os, "userInfo", () => ({ shell: "/backend/account-shell" }));
  const endpoint = new URL("api/config/default-shell", local.url);
  assert.deepEqual(await (await fetch(endpoint)).json(), {
    shell: "/backend/account-shell",
  });
  process.env.SHELL = "invalid\nshell";
  const invalid = await fetch(endpoint);
  assert.equal(invalid.status, 500);
  assert.equal((await invalid.json()).code, "INVALID_DEFAULT_SHELL");
  assert.deepEqual(
    await (await fetch(new URL("api/config", local.url))).json(),
    defaultConfig,
  );
  assert.deepEqual(await readdir(root), []);
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

test("partial disk files use defaults, but malformed and non-object files are never silently replaced", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, '{"font-size":19}');
  assert.deepEqual(await store.read(), { ...defaultConfig, "font-size": 19 });
  for (const invalid of ["{broken", "null", "[]", "true", '"settings"', "42"]) {
    await writeFile(configPath, invalid);
    await assert.rejects(store.read(), { code: "CONFIG_INVALID" });
    await assert.rejects(store.patch({ "vim-mode": true }), {
      code: "CONFIG_INVALID",
    });
    assert.equal(await readFile(configPath, "utf8"), invalid);
    assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
  }
});

test("invalid diagnostics distinguish syntax, UTF-8 and non-object files without leaking input", async (t) => {
  const { local, configPath } = await serverFixture(t);
  await mkdir(path.dirname(configPath));
  for (const [bytes, reason] of [
    [Buffer.from('{"secret-path-/private":'), /JSON syntax/],
    [Buffer.from([0x7b, 0xff, 0x7d]), /UTF-8/],
    [Buffer.from("[]"), /JSON object/],
  ] as const) {
    await writeFile(configPath, bytes);
    const result = await fetch(new URL("api/config", local.url));
    assert.equal(result.status, 409);
    const error = await result.json();
    assert.equal(error.code, "CONFIG_INVALID");
    assert.match(error.error, reason);
    assert.match(error.error, /Manually repair or remove config\.json/);
    assert.doesNotMatch(error.error, /backup|reset/i);
    assert.doesNotMatch(error.error, /secret|\/private/);
    assert.ok(!error.error.includes(configPath));
    assert.equal((await post(local.url, { "vim-mode": true })).status, 409);
    assert.deepEqual(await readFile(configPath), bytes);
    assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
  }
});

test("unknown disk keys and unsupported values use per-field defaults without blocking reads, saves or streams", async (t) => {
  const { local, configPath } = await serverFixture(t);
  const events = await stream(local.url, t);
  assert.deepEqual((await events.next()).data, defaultConfig);
  const document = {
    "color-scheme": "future-theme",
    "font-size": 99,
    "vim-mode": "enabled",
    "hover-sidebars": null,
    "files-width": { future: 245 },
    "log-width": [350],
    "files-peek-width": -1,
    "log-peek-width": 0,
    "split-diff-ratio": 99,
    "file-view": "future-view",
    "files-expanded": null,
    "log-expanded": 1,
    "diff-style": "future-style",
    "log-revset": "",
    future: { enabled: true, values: [null, "new", 42, false] },
  };
  await mkdir(path.dirname(configPath));
  await writeFile(
    configPath,
    JSON.stringify({ ...document, "font-size": 18, "log-revset": " all() " }),
  );
  const expected = { ...defaultConfig, "font-size": 18, "log-revset": "all()" };
  const response = await fetch(new URL("api/config", local.url));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), expected);
  assert.deepEqual(await events.next(), { event: "config", data: expected });
  const saved = await post(local.url, { "vim-mode": true });
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { ...expected, "vim-mode": true });
  assert.deepEqual(await events.next(), {
    event: "config",
    data: { ...expected, "vim-mode": true },
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    ...document,
    "font-size": 18,
    "log-revset": " all() ",
    "vim-mode": true,
  });
  // Every unsupported known value falls back independently, including a bad
  // font size, rather than leaking into the typed wire response.
  await writeFile(configPath, JSON.stringify(document));
  assert.deepEqual(
    await (await fetch(new URL("api/config", local.url))).json(),
    defaultConfig,
  );
  assert.deepEqual(await events.next(), {
    event: "config",
    data: defaultConfig,
  });
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});

test("unrelated saves preserve future keys, unsupported values and numeric literals losslessly", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  const original =
    '{"font-size":99,"color-scheme":"future-theme","future":{"integer":9007199254740993,"huge":1e400,"decimal":2.3000,"negativeZero":-0},"__proto__":{"polluted":true},"constructor":{"custom":true}}';
  await writeFile(configPath, original);
  assert.deepEqual(await store.read(), defaultConfig);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(await store.patch({ "vim-mode": true }), {
    ...defaultConfig,
    "vim-mode": true,
  });
  const text = await readFile(configPath, "utf8");
  assert.match(text, /"integer":\s*9007199254740993/);
  assert.match(text, /"huge":\s*1e400/);
  assert.match(text, /"decimal":\s*2\.3000/);
  assert.match(text, /"negativeZero":\s*-0/);
  const disk = JSON.parse(text);
  assert.equal(disk["font-size"], 99);
  assert.equal(disk["color-scheme"], "future-theme");
  assert.deepEqual(disk["__proto__"], { polluted: true });
  assert.deepEqual(disk.constructor, { custom: true });
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.deepEqual(await store.read(), { ...defaultConfig, "vim-mode": true });
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});

test("no-op patches preserve a future config, but explicit edits replace unsupported stored values even at the default", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  const original = ' { "font-size": 99, "future": [true, {"new": "value"}] }\n';
  await writeFile(configPath, original);
  assert.deepEqual(await store.patch({}), defaultConfig);
  assert.deepEqual(await store.patch({ "vim-mode": false }), defaultConfig);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(
    await store.patch({ "font-size": defaultConfig["font-size"] }),
    defaultConfig,
  );
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(saved["font-size"], defaultConfig["font-size"]);
  assert.deepEqual(saved.future, [true, { new: "value" }]);
});

test("future data stays bounded on save: compact JSON when needed, otherwise reject without replacement", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  const future = "x".repeat(
    64 * 1024 - JSON.stringify({ future: "", "vim-mode": true }).length - 1,
  );
  await writeFile(configPath, JSON.stringify({ future }));
  await store.patch({ "vim-mode": true });
  const compact = await readFile(configPath, "utf8");
  assert.equal(Buffer.byteLength(compact), 64 * 1024);
  assert.equal(compact, `${JSON.stringify({ future, "vim-mode": true })}\n`);
  assert.deepEqual(JSON.parse(compact), { future, "vim-mode": true });
  assert.deepEqual(await store.read(), { ...defaultConfig, "vim-mode": true });
  const original = JSON.stringify({
    future: "x".repeat(64 * 1024 - JSON.stringify({ future: "" }).length),
  });
  assert.equal(Buffer.byteLength(original), 64 * 1024);
  await writeFile(configPath, original);
  await assert.rejects(store.patch({ "vim-mode": true }), {
    code: "CONFIG_TOO_LARGE",
  });
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.deepEqual(await store.read(), defaultConfig);
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});

test("deeply nested unknown values survive unrelated saves without recursive serialization", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  const future = `${"[".repeat(10_000)}9007199254740993${"]".repeat(10_000)}`;
  await writeFile(
    configPath,
    `{"future":${future},"color-scheme":"future-theme"}`,
  );
  assert.deepEqual(await store.read(), defaultConfig);
  assert.deepEqual(await store.patch({ "font-size": 18 }), {
    ...defaultConfig,
    "font-size": 18,
  });
  const saved = await readFile(configPath, "utf8");
  assert.ok(saved.includes(future));
  assert.equal(JSON.parse(saved)["color-scheme"], "future-theme");
  assert.ok(Buffer.byteLength(saved) < 64 * 1024);
  assert.deepEqual(await store.read(), { ...defaultConfig, "font-size": 18 });
});

test("raw preservation handles escaped keys, delimiters in strings, duplicate keys and nested containers", async (t) => {
  const { store, configPath } = await fixture(t);
  await mkdir(path.dirname(configPath));
  const original = String.raw` {
    "future": 1,
    "future": {"text":"},\"\\[,:", "list":[{},[],["}", ",", "\""]]},
    "f\u0075ture": {"last":"keep this duplicate's value"},
    "quoted\"key": {"braces": "} ] , : { [", "slash": "\\"},
    "font-size": 16,
    "font\u002dsize": 99,
    "vim-mode": false
  } `;
  await writeFile(configPath, original);
  assert.deepEqual(await store.patch({ "font-size": 18 }), {
    ...defaultConfig,
    "font-size": 18,
  });
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
    ...JSON.parse(original),
    "font-size": 18,
  });
  // The equivalent escaped key was replaced, not left to override the patch.
  assert.deepEqual(await store.read(), { ...defaultConfig, "font-size": 18 });
});

test("removed invalid-config reset endpoint returns 404 without touching disk or writer resources", async (t) => {
  const { local, configPath } = await serverFixture(t);
  await mkdir(path.dirname(configPath));
  const original = Buffer.from(' \r\n{"font-size":\r\n');
  await writeFile(configPath, original, { mode: 0o644 });
  const lockPath = `${configPath}.lock`;
  for (const locked of [false, true]) {
    if (locked) await writeFile(lockPath, "another writer");
    const files = locked
      ? [configPath, lockPath, path.dirname(configPath)]
      : [configPath, path.dirname(configPath)];
    const before = await Promise.all(files.map((file) => stat(file)));
    const response = await fetch(
      new URL("api/config/reset-invalid", local.url),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
        body: JSON.stringify({ confirm: true }),
      },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "NOT_FOUND");
    assert.deepEqual(await readFile(configPath), original);
    if (locked)
      assert.equal(await readFile(lockPath, "utf8"), "another writer");
    for (const [index, file] of files.entries()) {
      const current = await stat(file);
      for (const key of ["ino", "mode", "size", "mtimeMs", "ctimeMs"] as const)
        assert.equal(current[key], before[index][key], `${file}: ${key}`);
    }
    assert.deepEqual(
      (await readdir(path.dirname(configPath))).sort(),
      locked ? ["config.json", "config.json.lock"] : ["config.json"],
    );
  }
});

test("oversized, unreadable and nonregular preferences reject reads and ordinary saves safely", async (t) => {
  const { local, configPath, root } = await serverFixture(t);
  await mkdir(path.dirname(configPath));
  async function rejectsAccess(status: number, code: string) {
    for (const response of [
      await fetch(new URL("api/config", local.url)),
      await post(local.url, { "font-size": 18 }),
    ]) {
      assert.equal(response.status, status);
      const error = await response.json();
      assert.equal(error.code, code);
      assert.ok(!error.error.includes(configPath));
      assert.doesNotMatch(error.error, /backup|reset/i);
    }
    assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
  }
  const oversized = Buffer.alloc(64 * 1024 + 1, 0x78);
  await writeFile(configPath, oversized);
  await rejectsAccess(409, "CONFIG_INVALID");
  assert.deepEqual(await readFile(configPath), oversized);
  await rm(configPath);
  await mkdir(configPath);
  await rejectsAccess(500, "CONFIG_IO");
  assert.equal((await stat(configPath)).isDirectory(), true);
  await rm(configPath, { recursive: true });
  if (process.platform !== "win32") {
    const fifo = spawn("mkfifo", [configPath]);
    assert.equal((await once(fifo, "exit"))[0], 0);
    await rejectsAccess(500, "CONFIG_IO");
    assert.equal((await stat(configPath)).isFIFO(), true);
    await rm(configPath);
    const target = path.join(root, "original");
    await writeFile(target, "{broken");
    await symlink(target, configPath);
    await rejectsAccess(500, "CONFIG_IO");
    assert.equal(await readFile(target, "utf8"), "{broken");
    await rm(configPath);
    if (process.getuid?.() !== 0) {
      await writeFile(configPath, "{unreadable", { mode: 0o000 });
      try {
        await rejectsAccess(500, "CONFIG_IO");
        assert.equal((await stat(configPath)).mode & 0o777, 0);
      } finally {
        await chmod(configPath, 0o600);
      }
      assert.equal(await readFile(configPath, "utf8"), "{unreadable");
    }
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
  assert.equal(failure.data.code, "CONFIG_INVALID");
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
  assert.equal(failure.data.code, "CONFIG_IO");
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
  const { local, configPath } = await serverFixture(t);
  await mkdir(path.dirname(configPath));
  await writeFile(configPath, "{broken");
  for (const endpoint of [
    "api/config",
    "api/config/events",
    "api/config/default-shell",
  ]) {
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
  const unsafeHeaders: Record<string, string>[] = [
    { "Content-Type": "application/json" },
    { "Content-Type": "text/plain", "X-Fold-Request": "1" },
    {
      "Content-Type": "application/json",
      "X-Fold-Request": "1",
      Origin: "https://evil.example",
    },
    {
      "Content-Type": "application/json",
      "X-Fold-Request": "1",
      "Sec-Fetch-Site": "cross-site",
    },
  ];
  for (const headers of unsafeHeaders) {
    const result = await fetch(new URL("api/config", local.url), {
      method: "POST",
      headers,
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
  assert.equal(await readFile(configPath, "utf8"), "{broken");
  assert.deepEqual(await readdir(path.dirname(configPath)), ["config.json"]);
});
