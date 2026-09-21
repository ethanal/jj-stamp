// Run with: npx tsx tests/preferences.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { chromium, expect } from "@playwright/test";

const source = {
  changeId: "abcdefghijklmno",
  changeIdPrefix: "abc",
  commitId: "0123456789abcdef",
  description: "Review toolbar preferences",
  author: "A. Reviewer",
};
const app = express();
app.get("/api/state", (_request, response) =>
  response.json({
    repo: { name: "example", path: "/home/reviewer/full/path/example" },
    version: "fixture-v1",
    source,
    parent: null,
    targets: [],
    files: [],
    operation: "fixture-op",
    canUndo: false,
  }),
);
app.get("/api/graph", (_request, response) =>
  response.json({
    version: "fixture-v1",
    rows: [{ graph: "@  ", revision: source, mutable: true }],
  }),
);
const server = createServer(app);
const vite = await createVite({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
app.get("/", async (_request, response) =>
  response.send(
    await vite.transformIndexHtml(
      "/",
      '<html><head></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    ),
  ),
);
app.use(vite.middlewares);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const url = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(url);
  await expect(page).toHaveTitle(
    `${source.changeId}: ${source.description} (/home/reviewer/full/path/example)`,
  );
  await expect(
    page.getByLabel("Current change ID").locator("strong"),
  ).toHaveText("abc");
  await expect(page.getByLabel("Revision author")).toHaveText("A. Reviewer");
  await expect(page.locator(".log-row.is-current")).toBeVisible();
  const files = page.getByRole("separator", { name: "Resize files sidebar" });
  const log = page.getByRole("separator", { name: "Resize log sidebar" });
  await files.focus();
  await page.keyboard.press("ArrowRight");
  await expect(files).toHaveAttribute("aria-valuenow", "255");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(files).toHaveAttribute("aria-valuenow", "295");
  const leftBox = await files.boundingBox();
  assert(leftBox);
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(leftBox.x + leftBox.width / 2 + 45, leftBox.y + 80, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await expect(page.getByLabel("Files sidebar", { exact: true })).toHaveCSS(
    "width",
    "340px",
  );
  const rightBox = await log.boundingBox();
  assert(rightBox);
  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(rightBox.x + rightBox.width / 2 - 40, rightBox.y + 80, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(log).toHaveAttribute("aria-valuenow", "390");
  await log.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(log).toHaveAttribute("aria-valuenow", "400");
  await page.getByLabel("Color scheme").selectOption("light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".log-row.is-current")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".log-row.is-current")).toHaveCSS(
    "background-color",
    "rgb(7, 87, 154)",
  );
  await page.reload();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await expect(log).toHaveAttribute("aria-valuenow", "400");
  await expect(page.getByLabel("Color scheme")).toHaveValue("light");
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await expect(files).toHaveCount(0);
  await page.getByRole("button", { name: "Expand files sidebar" }).click();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await page.getByLabel("Color scheme").selectOption("dim");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(34, 39, 46)",
  );
  await page.screenshot({ path: "/tmp/jj-stamp-preferences-desktop.png" });
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(files).toBeVisible();
  await expect(log).not.toBeVisible();
  await expect(page.getByLabel("Reviewed revision")).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await page.screenshot({ path: "/tmp/jj-stamp-preferences-mobile.png" });
  const noStorage = await browser.newPage();
  await noStorage.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Storage unavailable");
      },
    });
  });
  await noStorage.goto(url);
  await expect(noStorage.getByLabel("Color scheme")).toHaveValue("dark");
  await noStorage.getByLabel("Color scheme").selectOption("light");
  await expect(noStorage.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await noStorage.close();
  assert.deepEqual(errors, []);
  console.log(
    "Preference browser checks passed: drag/keyboard resize, persistence, themes, title, prefix, mobile, unavailable storage.",
  );
} finally {
  await browser.close();
  await vite.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
