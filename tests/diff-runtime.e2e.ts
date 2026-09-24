// Production worker + virtualized DOM regression: npx tsx tests/diff-runtime.e2e.ts
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import express from "express";
import { build } from "vite";

await using resources = new AsyncDisposableStack();
const output = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-diff-runtime-"));
resources.defer(() => rm(output, { recursive: true, force: true }));
await build({
  logLevel: "error",
  plugins: [
    {
      name: "diff-runtime-fixture",
      transformIndexHtml: {
        order: "pre",
        handler(html) {
          return html.replace(
            "/src/main.tsx",
            "/tests/diff-runtime.fixture.tsx",
          );
        },
      },
    },
  ],
  build: { outDir: output, emptyOutDir: true },
});
const server = createServer(express().use(express.static(output)));
resources.defer(
  () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }),
);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
resources.defer(() => browser.close());
const page = await browser.newPage({ viewport: { width: 1200, height: 750 } });
const errors: string[] = [];
const workers: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("worker", (worker) => workers.push(worker.url()));
await page.addInitScript({
  content: `Object.defineProperty(navigator, "hardwareConcurrency", { value: 64 });`,
});
await page.goto(url);
const rowCount = () => page.locator("[data-line]").count();
await expect(page.locator("[data-line]").first()).toBeVisible();
await expect
  .poll(
    async () => {
      const stats = await page.locator("#pool-stats").textContent();
      return stats && stats !== "fallback"
        ? JSON.parse(stats).diffCacheSize
        : 0;
    },
    { timeout: 20_000 },
  )
  .toBeGreaterThan(0);
assert.equal(
  workers.length,
  2,
  "even high-core clients cap the pool at two workers",
);
assert(
  workers.every((worker) => /\/assets\/worker-[\w-]+\.js$/.test(worker)),
  "workers must be production assets",
);
assert(
  (await rowCount()) < 300,
  "large diff must not eagerly materialize every hunk",
);
const initialWorkers = workers.length;
await page.getByRole("button", { name: "Bottom", exact: true }).click();
await expect
  .poll(async () =>
    page
      .locator("[data-line]")
      .evaluateAll((rows) =>
        Math.max(...rows.map((row) => Number(row.getAttribute("data-line")))),
      ),
  )
  .toBeGreaterThan(5700);
assert((await rowCount()) < 300);
await page.getByRole("button", { name: "Top", exact: true }).click();
await expect(page.locator('[data-line="17"]').last()).toBeVisible();
await page.getByRole("button", { name: "Theme", exact: true }).click();
await page.getByRole("button", { name: "Layout", exact: true }).click();
await expect(page.locator("[data-additions]")).toBeVisible();
await expect
  .poll(async () => {
    const stats = await page.locator("#pool-stats").textContent();
    return stats && stats !== "fallback" ? JSON.parse(stats).diffCacheSize : 0;
  })
  .toBeGreaterThan(0);
assert.equal(
  workers.length,
  initialWorkers,
  "theme/layout changes must reuse the pool",
);
assert((await rowCount()) < 500, "split layout also bounds rendered DOM");
const firstLine = () =>
  page
    .locator("[data-line]")
    .evaluateAll((rows) =>
      Math.min(...rows.map((row) => Number(row.getAttribute("data-line")))),
    );
const beforeExpand = await firstLine();
await page.locator("[data-expand-button]").first().click();
await expect.poll(firstLine).toBeLessThan(beforeExpand);
assert((await rowCount()) < 500, "expansion must remain virtualized");
assert.deepEqual(errors, []);

// Unsupported Worker and CSP/constructor failures must leave a usable viewer.
for (const failure of ["unsupported", "constructor", "runtime"] as const) {
  const fallback = await browser.newPage({
    viewport: { width: 1200, height: 750 },
  });
  const fallbackErrors: string[] = [];
  fallback.on("pageerror", (error) => fallbackErrors.push(error.message));
  // A string avoids tsx's keepNames helper being captured in serialized code.
  await fallback.addInitScript({
    content: `
    const mode = ${JSON.stringify(failure)};
    const NativeWorker = window.Worker;
    if (mode === "unsupported") Object.defineProperty(window, "Worker", { value: undefined });
    else if (mode === "constructor") Object.defineProperty(window, "Worker", {
      value: function () { throw new Error("Workers blocked by policy"); }
    });
    else Object.defineProperty(window, "Worker", {
      value: class extends NativeWorker {
        constructor(url, options) {
          super(url, options);
          this.addEventListener("message", () => {
            setTimeout(() => this.dispatchEvent(new Event("messageerror")), 20);
          }, { once: true });
        }
      }
    });
  `,
  });
  await fallback.goto(url);
  await expect(fallback.locator("#pool-stats")).toHaveText("fallback", {
    timeout: 15_000,
  });
  await expect(fallback.locator("[data-line]").first()).toBeVisible();
  assert(
    (await fallback.locator("[data-line]").count()) < 300,
    "fallback retains virtualization",
  );
  await fallback.getByRole("button", { name: "Bottom", exact: true }).click();
  await expect
    .poll(async () =>
      fallback
        .locator("[data-line]")
        .evaluateAll((rows) =>
          Math.max(...rows.map((row) => Number(row.getAttribute("data-line")))),
        ),
    )
    .toBeGreaterThan(5700);
  assert.deepEqual(fallbackErrors, [], `${failure} has no unhandled errors`);
  await fallback.close();
}
console.log(
  "Production diff worker, virtualization, scrolling, theme/layout, expansion and fallback passed.",
);
