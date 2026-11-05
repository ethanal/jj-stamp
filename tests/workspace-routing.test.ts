import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runInNewContext } from "node:vm";
import { startLocalServer } from "../server/http.ts";
import type { PrHandlers } from "../server/pr-review.ts";
import type { ReviewService } from "../server/service.ts";
import { apiUrl } from "../src/api.ts";

const ID_A = "a".repeat(64);
const ID_B = "b".repeat(64);
const HEAD = "c".repeat(128);
const HTML = '<!doctype html><script src="/assets/app.js"></script>';

function send(
  url: string,
  headers: IncomingHttpHeaders = {},
  method = "GET",
  body?: string,
) {
  return new Promise<{
    status: number;
    headers: IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = request(url, { headers, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("error", reject);
      res.on("end", () =>
        resolve({ status: res.statusCode!, headers: res.headers, body }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

const mutationHeaders = {
  "Content-Type": "application/json",
  "X-Fold-Request": "1",
};

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetsDir = path.join(root, "client");
  await mkdir(path.join(assetsDir, "assets"), { recursive: true });
  await writeFile(path.join(assetsDir, "index.html"), HTML);
  await writeFile(path.join(assetsDir, "assets/app.js"), "/* hashed bundle */");
  // Even real files under this prefix must not bypass workspace validation.
  await mkdir(path.join(assetsDir, "reviews/not-a-review"), {
    recursive: true,
  });
  await writeFile(
    path.join(assetsDir, "reviews/not-a-review/index.html"),
    HTML,
  );

  async function workspace(name: string) {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, ".jj/repo/op_heads/heads"), {
      recursive: true,
    });
    await writeFile(path.join(directory, ".jj/repo/op_heads/heads", HEAD), "");
    await writeFile(path.join(directory, "visible.txt"), "initial");
    const calls = { states: 0, subscriptions: 0, drains: 0 };
    let selection = "@";
    const service = {
      getState: async () => {
        calls.states++;
        return { workspace: name, selection };
      },
      selectRevision: async (input: { changeId: string }) => {
        selection = input.changeId;
        return { workspace: name, selection };
      },
      getWatchRoot: async () => directory,
      getWatchPaths: () => ["visible.txt"],
      subscribeWatchPaths: () => {
        calls.subscriptions++;
        return () => {};
      },
      drain: async () => {
        calls.drains++;
      },
    } as unknown as ReviewService;
    const pr: PrHandlers = {
      context: () => ({
        mode: name === "original" ? "workspace" : "pr",
        repository: null,
        pullRequest: null,
        originalWorkspaceUrl: null,
        capabilities: {
          list: true,
          open: true,
          refresh: false,
          submit: false,
          dismiss: false,
          threads: false,
        },
      }),
      list: async () => {
        throw new Error(`list ${name}`);
      },
      open: async () => ({ url: `${local.url}reviews/${ID_A}/` }),
    };
    return { service, pr, directory, calls };
  }
  const original = await workspace("original");
  const a = await workspace("a");
  const b = await workspace("b");
  const loaded = new Map([
    [ID_A, a],
    [ID_B, b],
  ]);
  original.pr.workspace = (id) => loaded.get(id);
  const local = await startLocalServer({
    service: original.service,
    assetsDir,
    port: 0,
    pr: original.pr,
  });
  t.after(() => local.close());
  return { local, original, a, b, loaded, assetsDir };
}

test("one server serves original and loaded review UI/API without changing tab identity", async (t) => {
  const { local, original, a, b } = await fixture(t);
  const scopes = ["", `reviews/${ID_A}/`, `reviews/${ID_B}/`];
  for (const [index, scope] of scopes.entries()) {
    for (const query of ["", "?reload=1"]) {
      for (const method of ["GET", "HEAD"]) {
        const page = await send(
          `${local.url}${scope}${query}`,
          {
            "If-None-Match": '"obsolete-index"',
            "If-Modified-Since": new Date().toUTCString(),
          },
          method,
        );
        assert.equal(page.status, 200);
        assert.equal(page.body, method === "HEAD" ? "" : HTML);
        assert.equal(page.headers["cache-control"], "no-store");
        assert.equal(page.headers.etag, undefined);
        assert.equal(page.headers["last-modified"], undefined);
      }
    }
    const state = await send(`${local.url}${scope}api/state?reload=1`);
    assert.equal(state.status, 200);
    assert.equal(
      JSON.parse(state.body).workspace,
      ["original", "a", "b"][index],
    );
    const context = await send(`${local.url}${scope}api/pr/context`);
    assert.equal(
      JSON.parse(context.body).mode,
      index === 0 ? "workspace" : "pr",
    );
    const opened = await send(
      `${local.url}${scope}api/pr/open`,
      mutationHeaders,
      "POST",
      '{"input":"1"}',
    );
    assert.equal(opened.status, 200);
    assert.equal(JSON.parse(opened.body).url, `${local.url}reviews/${ID_A}/`);
  }
  const changed = await send(
    `${local.url}reviews/${ID_A}/api/revision`,
    mutationHeaders,
    "POST",
    JSON.stringify({ version: "0".repeat(64), changeId: "k".repeat(32) }),
  );
  assert.equal(changed.status, 200);
  for (const [scope, expected] of [
    ["", "@"],
    [`reviews/${ID_A}/`, "k".repeat(32)],
    [`reviews/${ID_B}/`, "@"],
  ]) {
    const response = await send(`${local.url}${scope}api/state`);
    assert.equal(JSON.parse(response.body).selection, expected);
  }
  assert.equal(original.calls.states, 2);
  assert.equal(a.calls.states, 2);
  assert.equal(b.calls.states, 2);
  const asset = await send(`${local.url}assets/app.js`);
  assert.equal(asset.status, 200);
  assert.ok(asset.headers.etag);
  assert.equal(
    (
      await send(`${local.url}assets/app.js`, {
        "If-None-Match": asset.headers.etag,
      })
    ).status,
    304,
  );
});

test("unknown, unloaded, malformed reviews and missing static paths never fall through", async (t) => {
  const { local, original, a, loaded, assetsDir } = await fixture(t);
  for (const route of [
    "reviews",
    "reviews/",
    "reviews/not-a-review/",
    "reviews%2fnot-a-review/",
    "r%65views/not-a-review/",
    `Reviews/${ID_A}/`,
    `r%65views/${ID_A}/`,
    `reviews/${"d".repeat(64)}/`,
    `reviews/${"d".repeat(64)}/api/state`,
    `reviews/${ID_A.toUpperCase()}/api/state`,
    `reviews/${ID_A.slice(1)}/api/state`,
    `reviews/%61${ID_A.slice(1)}/api/state`,
    `reviews/${ID_A}`,
    `reviews/${ID_A}/api-not-api/state`,
    `reviews/${ID_A}/missing.js`,
    `reviews/${ID_A}/assets/app.js`,
  ]) {
    const response = await send(`${local.url}${route}`);
    assert.equal(response.status, 404, route);
    assert.match(response.headers["content-type"]!, /text\/plain/, route);
    assert.equal(response.headers["cache-control"], "no-store", route);
    assert.doesNotMatch(response.body, /doctype/);
  }
  for (const prefix of ["api", `reviews/${ID_A}/api`]) {
    const response = await send(`${local.url}${prefix}/missing`);
    assert.equal(response.status, 404);
    assert.equal(JSON.parse(response.body).code, "NOT_FOUND");
  }
  await send(`${local.url}reviews/${ID_A}/api/state`);
  loaded.delete(ID_A);
  assert.equal(
    (await send(`${local.url}reviews/${ID_A}/api/state`)).status,
    404,
  );
  assert.equal(original.calls.states, 0);
  assert.equal(a.calls.states, 1);
  await rm(path.join(assetsDir, "index.html"));
  const missingIndex = await send(`${local.url}reviews/${ID_B}/`);
  assert.equal(missingIndex.status, 404);
  assert.match(missingIndex.headers["content-type"]!, /text\/plain/);
});

test("root and scoped routes have identical Host/Origin and mutation protections", async (t) => {
  const { local, original, a } = await fixture(t);
  const origin = new URL(local.url).origin;
  for (const scope of ["", `reviews/${ID_A}/`]) {
    for (const route of ["", "api/state", "api/events"]) {
      for (const headers of [
        { Host: "attacker.invalid" },
        { Origin: "http://attacker.invalid" },
        { Origin: "http://127.0.0.1:1" },
        { "Sec-Fetch-Site": "cross-site" },
      ]) {
        const response = await send(`${local.url}${scope}${route}`, headers);
        assert.equal(response.status, 403);
        assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
      }
    }
    for (const headers of [
      {},
      { "Content-Type": "application/json" },
      { "X-Fold-Request": "1" },
      { "Content-Type": "text/plain", "X-Fold-Request": "1" },
      { "Content-Type": "application/json", "X-Fold-Request": "0" },
      { ...mutationHeaders, Origin: "http://attacker.invalid" },
    ]) {
      const response = await send(
        `${local.url}${scope}api/pr/open`,
        headers,
        "POST",
        '{"input":"1"}',
      );
      assert.equal(response.status, 403);
    }
    const valid = await send(
      `${local.url}${scope}api/pr/open`,
      { ...mutationHeaders, Origin: origin },
      "POST",
      '{"input":"1"}',
    );
    assert.equal(valid.status, 200);
    const state = await send(`${local.url}${scope}api/state`, {
      Origin: origin,
    });
    assert.equal(state.status, 200);
    assert.equal(state.headers["x-content-type-options"], "nosniff");
    assert.equal(state.headers["referrer-policy"], "no-referrer");
    assert.match(
      String(state.headers["content-security-policy"]),
      /frame-ancestors 'none'/,
    );
  }
  assert.equal(original.calls.states, 1);
  assert.equal(a.calls.states, 1);
});

async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "timed out waiting for SSE");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connectSse(url: string) {
  return new Promise<{
    text(): string;
    ended: Promise<void>;
    destroy(): void;
  }>((resolve, reject) => {
    const req = request(url, (res) => {
      let text = "";
      assert.equal(res.statusCode, 200);
      res.setEncoding("utf8");
      res.on("data", (chunk) => (text += chunk));
      res.on("error", reject);
      const ended = new Promise<void>((done) => res.once("end", done));
      resolve({
        text: () => text,
        ended,
        destroy: () => {
          req.destroy();
          res.destroy();
        },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test(
  "SSE hubs are cached per workspace, isolated across tabs, and all close before draining",
  { timeout: 10_000 },
  async (t) => {
    const { local, original, a, b } = await fixture(t);
    for (const scope of ["", `reviews/${ID_A}/`, `reviews/${ID_B}/`]) {
      assert.equal(
        (await send(`${local.url}${scope}api/events`, {}, "HEAD")).status,
        204,
      );
    }
    assert.equal(original.calls.subscriptions, 0);
    assert.equal(a.calls.subscriptions, 0);
    assert.equal(b.calls.subscriptions, 0);
    const streams = await Promise.all([
      connectSse(`${local.url}api/events`),
      connectSse(`${local.url}reviews/${ID_A}/api/events`),
      connectSse(`${local.url}reviews/${ID_A}/api/events`),
      connectSse(`${local.url}reviews/${ID_B}/api/events`),
    ]);
    t.after(() => streams.forEach((stream) => stream.destroy()));
    await eventually(() =>
      streams.every((stream) => stream.text().includes("event: ready")),
    );
    assert.equal(original.calls.subscriptions, 1);
    assert.equal(
      a.calls.subscriptions,
      1,
      "two tabs must share one cached scoped router",
    );
    assert.equal(b.calls.subscriptions, 1);
    await writeFile(
      path.join(a.directory, "visible.txt"),
      "only workspace a changed",
    );
    await eventually(
      () =>
        streams[1].text().includes("event: change") &&
        streams[2].text().includes("event: change"),
    );
    assert.doesNotMatch(streams[0].text(), /event: change/);
    assert.doesNotMatch(streams[3].text(), /event: change/);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    t.after(() => release());
    let drainStarted = false;
    a.service.drain = async () => {
      drainStarted = true;
      await blocked;
      a.calls.drains++;
    };
    let closed = false;
    const shutdown = local.close().then(() => {
      closed = true;
    });
    await Promise.all(streams.map((stream) => stream.ended));
    await eventually(() => drainStarted);
    assert.equal(closed, false, "shutdown must drain scoped services too");
    release();
    await shutdown;
    assert.equal(original.calls.drains, 1);
    assert.equal(a.calls.drains, 1);
    assert.equal(b.calls.drains, 1);
  },
);

test("client API and event URLs follow only a validated review scope", (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  assert.equal(
    apiUrl("state"),
    "/api/state",
    "headless callers retain root API",
  );
  const location = { pathname: "/" };
  Object.defineProperty(globalThis, "window", {
    value: { location },
    configurable: true,
  });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  for (const pathname of [
    "/",
    "/index.html",
    `/reviews/${ID_A.toUpperCase()}/`,
    `/reviews/${ID_A.slice(1)}/`,
    "/reviews/not-an-id/",
  ]) {
    location.pathname = pathname;
    assert.equal(apiUrl("state"), "/api/state");
    assert.equal(apiUrl("events"), "/api/events");
  }
  location.pathname = `/reviews/${ID_A}/`;
  assert.equal(apiUrl("state"), `/reviews/${ID_A}/api/state`);
  assert.equal(apiUrl("events"), `/reviews/${ID_A}/api/events`);
});

test("workspace navigation allows only canonical same-origin root or review addresses", async () => {
  // Bundle the actual component so its CSS import does not require a DOM loader.
  const result = await build({
    entryPoints: [new URL("../src/PrReview.tsx", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "cjs",
    platform: "browser",
    loader: { ".css": "empty" },
  });
  for (const origin of ["http://127.0.0.1:8000", "http://localhost:4173"]) {
    const assigned: string[] = [];
    const module = {
      exports: {} as { navigateToWorkspace(value: string): void },
    };
    runInNewContext(result.outputFiles[0].text, {
      module,
      URL,
      window: {
        location: { origin, assign: (url: string) => assigned.push(url) },
      },
    });
    const { navigateToWorkspace } = module.exports;
    for (const url of [`${origin}/`, `${origin}/reviews/${ID_A}/`]) {
      navigateToWorkspace(url);
      assert.equal(assigned.at(-1), url);
    }
    for (const url of [
      "http://127.0.0.1:9000/",
      "http://localhost:9000/",
      "https://attacker.invalid/",
      `${origin}/?`,
      `${origin}/#`,
      `${origin}/?q=1`,
      `${origin}/#fragment`,
      `${origin}/reviews/${ID_A}/?q=1`,
      `${origin}/reviews/${ID_A.toUpperCase()}/`,
      `${origin}/reviews/${ID_A.slice(1)}/`,
      `${origin}/reviews/${ID_A}`,
      `${origin}/reviews/${ID_A}/api/state`,
      `${origin}/api`,
      origin.replace("://", "://user:password@") + "/",
      origin.replace("://", "://@") + "/",
    ]) {
      const before = assigned.length;
      assert.throws(
        () => navigateToWorkspace(url),
        /invalid local workspace address/,
        url,
      );
      assert.equal(assigned.length, before);
    }
  }
});
