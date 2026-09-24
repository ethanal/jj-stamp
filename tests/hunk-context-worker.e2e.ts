// Run with: npx tsx tests/hunk-context-worker.e2e.ts
// Actual production worker + WASM assets, served under a non-root Vite base.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import express from "express";
import { chromium } from "@playwright/test";
import { build } from "vite";

await using cleanup = new AsyncDisposableStack();
const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-scope-worker-"));
cleanup.defer(() => rm(directory, { recursive: true, force: true }));
await build({
  configFile: false,
  base: "/worker-test/",
  worker: { format: "es" },
  logLevel: "warn",
  build: {
    outDir: directory,
    emptyOutDir: false,
    rollupOptions: {
      input: path.resolve("tests/hunk-context-worker.fixture.ts"),
      preserveEntrySignatures: "strict",
      output: { entryFileNames: "fixture.js" },
    },
  },
});
const entry = await readFile(path.join(directory, "fixture.js"), "utf8");
assert.ok(
  !entry.includes("web-tree-sitter.wasm"),
  "main bundle must not include parser assets",
);
assert.ok(
  !entry.includes("class Parser"),
  "main bundle must not include the parser",
);
const assets = await readdir(path.join(directory, "assets"));
assert.ok(
  assets.some(
    (name) => name.startsWith("hunk-context.worker-") && name.endsWith(".js"),
  ),
);
assert.ok(
  assets.some(
    (name) => name.startsWith("web-tree-sitter-") && name.endsWith(".wasm"),
  ),
);
const app = express();
app.get("/", (_request, response) =>
  response.send("<!doctype html><title>Worker fixture</title>"),
);
app.use("/worker-test", express.static(directory));
const server = createServer(app);
cleanup.defer(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
cleanup.defer(() => browser.close());
const page = await browser.newPage();
const errors: string[] = [];
const failures: string[] = [];
const wasm: string[] = [];
const workers: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("worker", (worker) => workers.push(worker.url()));
page.on("response", (response) => {
  if (response.url().endsWith(".wasm")) wasm.push(response.url());
  if (response.status() >= 400) failures.push(response.url());
});
await page.goto(`http://127.0.0.1:${address.port}`);
const result = await page.evaluate(async () => {
  const entry = "/worker-test/fixture.js";
  const fixture = await import(entry);
  return fixture.run();
});
assert.equal(result.cold.hunk.scopes[0].label, "function scope() {");
assert.deepEqual(result.warm, result.cold);
assert.deepEqual(result.peek, result.cold);
assert.deepEqual(result.empty, {});
assert.deepEqual(result.absent, {});
assert.equal(result.stats.parses, 3);
assert.equal(result.stats.entries, 3);
assert.equal(result.stats.pending, 0);
assert.equal(workers.length, 1);
assert.ok(workers[0].includes("hunk-context.worker-"));
assert.ok(wasm.some((url) => url.includes("web-tree-sitter-")));
assert.ok(wasm.some((url) => url.includes("tree-sitter-typescript-")));
assert.deepEqual(errors, []);
assert.deepEqual(failures, []);
console.log(
  "Production scope worker: WASM loaded, scope inferred, cache reused, no main-thread parser.",
);
