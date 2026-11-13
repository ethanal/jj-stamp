import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { request, type IncomingHttpHeaders } from "node:http";
import { connect, Server } from "node:net";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";

// Use raw HTTP so a fetch implementation cannot alter conditional requests.
function get(url: string, headers: IncomingHttpHeaders = {}, method = "GET") {
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
    req.end();
  });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetsDir = path.join(root, "client");
  await mkdir(path.join(assetsDir, "assets"), { recursive: true });
  const service = new ReviewService({ repoPath: root });
  return { root, assetsDir, service };
}

function html(build: string) {
  return `<!doctype html><html><head><link rel="stylesheet" href="/assets/index-${build}.css"></head><body><script type="module" src="/assets/index-${build}.js"></script></body></html>`;
}

async function writeBuild(assetsDir: string, build: string) {
  await writeFile(path.join(assetsDir, "index.html"), html(build));
  // Nix normalizes mtimes. Hashes change without changing the HTML's size.
  await utimes(path.join(assetsDir, "index.html"), 1, 1);
  await writeFile(
    path.join(assetsDir, `assets/index-${build}.js`),
    `document.body.append("Build ${build}");`,
  );
  await writeFile(
    path.join(assetsDir, `assets/index-${build}.css`),
    "body { color: green; }",
  );
}

test("implicit default port is reused and only falls back on a real bind conflict", async (t) => {
  const { assetsDir, service } = await fixture(t);
  const listen = Server.prototype.listen;
  const attempts: Array<[number, string]> = [];
  let isolatedDefault = 0;
  // Translate only the default to a private ephemeral port. Real sockets still
  // exercise binding, EADDRINUSE and reuse without relying on a free port 8000.
  t.mock.method(
    Server.prototype,
    "listen",
    function (this: Server, port: number, host: string) {
      attempts.push([port, host]);
      return Reflect.apply(listen, this, [
        port === DEFAULT_PORT ? isolatedDefault : port,
        host,
      ]);
    },
  );
  const options = { service, assetsDir };
  const first = await startLocalServer(options);
  t.after(() => first.close());
  isolatedDefault = Number(new URL(first.url).port);
  const fallback = await startLocalServer(options);
  t.after(() => fallback.close());
  assert.notEqual(fallback.url, first.url);
  await assert.rejects(startLocalServer({ ...options, port: DEFAULT_PORT }), {
    code: "EADDRINUSE",
  });
  await first.close();
  const restarted = await startLocalServer(options);
  t.after(() => restarted.close());
  assert.equal(restarted.url, first.url);
  assert.deepEqual(
    attempts,
    [DEFAULT_PORT, DEFAULT_PORT, 0, DEFAULT_PORT, DEFAULT_PORT].map((port) => [
      port,
      "127.0.0.1",
    ]),
  );
});

for (const partialHeaders of [false, true]) {
  test(`shutdown closes ${partialHeaders ? "incomplete HTTP headers" : "unused browser preconnections"} without waiting for a network timeout`, async (t) => {
    const { assetsDir, service } = await fixture(t);
    const local = await startLocalServer({ service, assetsDir, port: 0 });
    const accepted = once(local.server, "connection");
    const socket = connect(Number(new URL(local.url).port), "127.0.0.1");
    t.after(async () => {
      socket.destroy();
      await local.close();
    });
    const [serverSocket] = await accepted;
    await once(socket, "connect");
    if (partialHeaders) {
      const received = once(serverSocket, "data");
      socket.write("GET /api/state HTTP/1.1\r\nHost:");
      await received;
    }
    const closed = once(local.server, "close", {
      signal: AbortSignal.timeout(1000),
    });
    const shutdown = local.close();
    assert.equal(local.close(), shutdown, "shutdown remains idempotent");
    await closed;
    await shutdown;
  });
}

test("shutdown preserves an accepted request body and response alongside a preconnection", async (t) => {
  const { assetsDir, service } = await fixture(t);
  const local = await startLocalServer({ service, assetsDir, port: 0 });
  const accepted = once(local.server, "connection");
  const idle = connect(Number(new URL(local.url).port), "127.0.0.1");
  t.after(async () => {
    idle.destroy();
    req.destroy();
    await local.close();
  });
  await accepted;
  await once(idle, "connect");

  const admitted = once(local.server, "request");
  const req = request(new URL("api/not-a-route", local.url), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": "2",
      "X-Fold-Request": "1",
    },
  });
  const response = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      req.on("error", reject);
      req.on("response", (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("error", reject);
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      });
    },
  );
  req.write("{");
  await admitted;
  let closed = false;
  const transportClosed = once(local.server, "close", {
    signal: AbortSignal.timeout(1000),
  });
  const shutdown = local.close().then(() => {
    closed = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "accepted HTTP bodies must still drain");
  req.end("}");
  const result = await response;
  assert.equal(result.status, 404);
  assert.equal(JSON.parse(result.body).code, "NOT_FOUND");
  await transportClosed;
  await shutdown;
});

test("an upgrade never revalidates obsolete HTML with colliding file metadata", async (t) => {
  const { assetsDir, service } = await fixture(t);
  await writeBuild(assetsDir, "old");

  // Capture the validators shipped by the old server, not the fixed policy.
  const legacy = express();
  legacy.use(express.static(assetsDir));
  const oldServer = legacy.listen(0, "127.0.0.1");
  t.after(() => oldServer.close());
  await new Promise<void>((resolve) => oldServer.once("listening", resolve));
  const address = oldServer.address();
  assert.ok(address && typeof address !== "string");
  const cached = await get(`http://127.0.0.1:${address.port}/`);
  assert.equal(cached.status, 200);
  assert.ok(cached.headers.etag);
  assert.ok(cached.headers["last-modified"]);

  await writeBuild(assetsDir, "new");
  assert.equal(html("old").length, html("new").length);
  // This is the original bug: the old implementation returns a false 304.
  assert.equal(
    (
      await get(`http://127.0.0.1:${address.port}/`, {
        "If-None-Match": cached.headers.etag,
      })
    ).status,
    304,
  );
  await new Promise<void>((resolve, reject) =>
    oldServer.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(path.join(assetsDir, "assets/index-old.js"));
  await rm(path.join(assetsDir, "assets/index-old.css"));

  const server = await startLocalServer({
    service,
    assetsDir,
    port: address.port,
  });
  t.after(() => server.close());
  const conditions = [
    {},
    { "If-None-Match": cached.headers.etag },
    { "If-Modified-Since": cached.headers["last-modified"] },
    {
      "If-None-Match": cached.headers.etag,
      "If-Modified-Since": cached.headers["last-modified"],
    },
  ];
  for (const route of ["", "index.html", "?reload=1", "index.html?reload=1"]) {
    for (const headers of conditions) {
      for (const method of ["GET", "HEAD"]) {
        const response = await get(
          new URL(route, server.url).href,
          headers,
          method,
        );
        assert.equal(response.status, 200, `${method} ${route}`);
        assert.equal(response.headers["cache-control"], "no-store");
        assert.equal(response.headers.etag, undefined);
        assert.equal(response.headers["last-modified"], undefined);
        assert.match(response.headers["content-type"]!, /text\/html/);
        assert.equal(response.body, method === "HEAD" ? "" : html("new"));
      }
    }
  }

  for (const extension of ["js", "css"]) {
    const asset = await get(`${server.url}assets/index-new.${extension}`);
    assert.equal(asset.status, 200);
    assert.match(
      asset.headers["content-type"]!,
      extension === "js" ? /javascript/ : /text\/css/,
    );
    assert.ok(asset.headers.etag, "assets retain conditional caching");
    assert.equal(
      (
        await get(`${server.url}assets/index-new.${extension}`, {
          "If-None-Match": asset.headers.etag,
        })
      ).status,
      304,
    );
  }
});

test("missing assets are uncached plain-text 404s, never HTML", async (t) => {
  const { assetsDir, service } = await fixture(t);
  await writeBuild(assetsDir, "new");
  const server = await startLocalServer({ service, assetsDir, port: 0 });
  t.after(() => server.close());
  for (const route of [
    "assets/index-old.js",
    "assets/index-old.css",
    "missing",
  ]) {
    const response = await get(new URL(route, server.url).href);
    assert.equal(response.status, 404);
    assert.match(response.headers["content-type"]!, /text\/plain/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.body, "Not found");
  }
});
