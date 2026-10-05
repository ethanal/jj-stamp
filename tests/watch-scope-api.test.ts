import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer, request } from "node:http";
import express from "express";
import { createApi } from "../server/api.ts";
import type { ReviewService } from "../server/service.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    assert(Date.now() < deadline, "scope event did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("SSE watches the latest published scope through setup races and unsubscribes on disconnect", async (t) => {
  let scope = ["old/a.txt"];
  const listeners = new Set<(paths: string[]) => void>();
  const service = {
    getWatchRoot: async () => "/workspace",
    getWatchPaths: () => [...scope],
    subscribeWatchPaths: (listener: (paths: string[]) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  } as ReviewService;
  function publish(paths: string[]) {
    scope = paths;
    for (const listener of listeners) listener([...paths]);
  }
  let finishSetup!: () => void;
  const gate = new Promise<void>((resolve) => {
    finishSetup = resolve;
  });
  const starts: string[][] = [];
  const updates: string[][] = [];
  let closes = 0;
  const api = createApi(service, {
    eventBackend: async (root, _handlers, signal, paths) => {
      assert.equal(root, "/workspace");
      assert.equal(signal.aborted, false);
      starts.push([...paths]);
      await gate;
      return {
        setPaths(next) {
          updates.push([...next]);
        },
        close() {
          closes++;
        },
      };
    },
  });
  const app = express();
  app.use("/api", api);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    api.closeEvents();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert(address && typeof address !== "string");
  let output = "";
  const stream = request(
    `http://127.0.0.1:${address.port}/api/events`,
    (response) => {
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        output += chunk;
      });
      response.on("error", () => {});
    },
  );
  stream.on("error", () => {});
  stream.end();
  t.after(() => stream.destroy());
  await eventually(() => starts.length === 1);
  assert.deepEqual(starts, [["old/a.txt"]]);
  assert.equal(listeners.size, 1);
  publish(["new/b.txt"]);
  assert.deepEqual(updates, [], "setup has no live watcher yet");
  finishSetup();
  await eventually(() => output.includes("event: ready"));
  assert.deepEqual(updates, [["new/b.txt"]]);
  publish(["last/c.txt"]);
  assert.deepEqual(updates.at(-1), ["last/c.txt"]);
  stream.destroy();
  await eventually(() => listeners.size === 0);
  assert.equal(closes, 1);
  publish(["detached/d.txt"]);
  await tick();
  assert.equal(updates.length, 2);
  assert.equal(listeners.size, 0);
});
