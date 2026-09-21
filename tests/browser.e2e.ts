import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { chromium, expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";

// Real browser + real jj, deliberately isolated from the user-facing demo.
const dataDir = await mkdtemp(path.join(tmpdir(), "fold-browser-"));
const service = new ReviewService({ dataDir });
const initial = await service.getState();
const app = express();
const server = createServer(app);
app.use("/api", createApi(service));
const vite = await createVite({
  server: { middlewareMode: true, hmr: false },
  appType: "spa",
});
app.use(vite.middlewares);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("No browser test port");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${address.port}`);
  await expect(
    page.getByText("Polish notification delivery", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".hunk")).toHaveCount(6);
  const hunk = page.getByRole("checkbox", {
    name: "Select hunk 1 in src/notifications.ts",
    exact: true,
  });
  await hunk.check();
  await expect(page.locator(".selection-box")).toContainText("2 changed lines");
  await page
    .getByRole("button", { name: "Preview squash", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("2 changed lines");
  await page
    .getByRole("button", { name: "Squash 2 lines", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".hunk")).toHaveCount(5);
  await page.getByRole("button", { name: "Undo squash", exact: true }).click();
  await expect(page.locator(".hunk")).toHaveCount(6);
  console.log("✓ Full hunk preview → squash → exact undo");

  const testHunk = initial.files.find(
    (f) => f.path === "tests/notifications.test.ts",
  )!.hunks[0];
  const adds = testHunk.rows.filter((r) => r.raw[0] === "+");
  const removed = testHunk.rows.find((r) => r.raw[0] === "-")!;
  const block = page.locator(`[data-hunk-id="${testHunk.id}"]`);
  const addGutter = (line: number) =>
    block.locator(
      `[data-column-number="${line}"][data-line-type="change-addition"]`,
    );
  await addGutter(adds[1].newLine!).click();
  await expect(page.locator(".selection-box")).toContainText("1 changed line");
  // Layout switches must not silently broaden the real selection.
  await page.getByRole("button", { name: "Split diff", exact: true }).click();
  await expect(page.locator(".selection-box")).toContainText("1 changed line");
  await page.getByRole("button", { name: "Unified diff", exact: true }).click();
  await addGutter(adds[0].newLine!).click({ modifiers: ["Shift"] });
  await expect(page.locator(".selection-box")).toContainText("2 changed lines");
  const start = block.locator(
    `[data-column-number="${removed.oldLine}"][data-line-type="change-deletion"]`,
  );
  await start.scrollIntoViewIfNeeded();
  const a = await start.boundingBox(),
    b = await addGutter(adds[1].newLine!).boundingBox();
  assert(a && b);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".selection-box")).toContainText("3 changed lines");
  await addGutter(adds[1].newLine!).click();
  await expect(page.locator(".selection-box")).toContainText("1 changed line");
  const beforeContents = await readFile(
    path.join(initial.repo.path, "tests/notifications.test.ts"),
    "utf8",
  );
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/preview") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Preview squash", exact: true })
    .click();
  const preview = await (await responsePromise).json();
  assert.deepEqual(preview.specs, [`${testHunk.id}:${adds[1].index}`]);
  assert.equal(preview.selectedLines, 1);
  await page
    .getByRole("button", { name: "Squash 1 line", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo squash", exact: true }),
  ).toBeVisible();
  assert.equal(
    await readFile(
      path.join(initial.repo.path, "tests/notifications.test.ts"),
      "utf8",
    ),
    beforeContents,
  );
  const after = await service.getState();
  assert(
    !after.files
      .find((f) => f.path === "tests/notifications.test.ts")!
      .patch.includes("+    assert.equal(formatSubject({ ...notification"),
  );
  await page.getByRole("button", { name: "Undo squash", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Undo squash", exact: true }),
  ).toHaveCount(0);
  console.log(
    "✓ Click, Shift-click, cross-side drag, single-line squash; working files unchanged",
  );

  await page.getByRole("button", { name: "Split diff", exact: true }).click();
  const paired = page.locator(
    '[data-hunk-id="' + initial.files[0].hunks[0].id + '"]',
  );
  await paired
    .locator('[data-column-number="21"][data-line-type="change-addition"]')
    .click();
  await expect(page.locator(".selection-box")).toContainText("2 changed lines");
  console.log("✓ Split range selects both aligned changed rows");

  await page.getByRole("button", { name: "How Fold works" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Tab");
  const focusInDialog = await page.evaluate(
    () => !!document.activeElement?.closest('[role="dialog"]'),
  );
  assert(focusInDialog);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("textbox", { name: "Filter files" }).fill("preferences");
  await expect(page.locator(".diff-card")).toHaveCount(1);
  await page.getByRole("button", { name: "Clear file filter" }).click();
  await expect(page.locator(".diff-card")).toHaveCount(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => scrollTo(0, 0));
  await expect(
    page.getByRole("heading", { name: "Working copy @" }),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: path.join(dataDir, "mobile.png"),
    fullPage: true,
  });
  console.log(
    "✓ Filtering, accessible modal, mobile layout; no horizontal overflow",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "Select all", exact: true }).click();
  await expect(page.locator(".selection-box")).toContainText(
    "13 changed lines",
  );
  await page
    .getByRole("button", { name: "Preview squash", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Squash 13 lines", exact: true })
    .click();
  await expect(page.getByText("A tidy working copy.")).toBeVisible();
  assert.equal((await service.getState()).files.length, 0);
  await page
    .getByRole("button", { name: "Undo last squash", exact: true })
    .click();
  await expect(page.locator(".hunk")).toHaveCount(6);
  await page.getByRole("button", { name: "Start a fresh demo" }).click();
  await expect(page.getByRole("dialog")).toContainText("nothing is deleted");
  await page.getByRole("button", { name: "Create fresh demo" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".hunk")).toHaveCount(6);
  assert.notEqual((await service.getState()).repo.path, initial.repo.path);
  assert.equal(
    await readFile(
      path.join(initial.repo.path, "tests/notifications.test.ts"),
      "utf8",
    ),
    beforeContents,
  );
  console.log(
    "✓ Squash all, empty-state undo, and non-destructive fresh-demo reset",
  );
  assert.deepEqual(errors, []);
  console.log("Browser integration passed. Isolated fixture:", dataDir);
} finally {
  await browser.close();
  await vite.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
