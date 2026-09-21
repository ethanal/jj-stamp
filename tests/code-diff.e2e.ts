// Run with: npx tsx tests/code-diff.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { chromium, expect } from "@playwright/test";

const app = express();
const server = createServer(app);
const vite = await createVite({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
app.get("/", async (_req, res) =>
  res.send(
    await vite.transformIndexHtml(
      "/",
      '<html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/code-diff.fixture.tsx"></script></body></html>',
    ),
  ),
);
app.use(vite.middlewares);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const line = (n: number) =>
  page
    .locator(`[data-line="${n}"]:not([data-line-type="change-deletion"])`)
    .last();
try {
  for (const layout of ["unified", "split"] as const) {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(line(10)).toBeVisible();
    if (layout === "split")
      await page.getByText("Layout", { exact: true }).click();
    const box = await line(10).boundingBox();
    assert(box);
    // Native selection does not call squash-selection handlers, even after a
    // normal selection already exists (Shift must not extend the squash range).
    await page.mouse.move(box.x + 25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("#selection")).not.toHaveText("{}");
    const selectionBefore = await page.locator("#selection").textContent();
    await page.keyboard.down("Shift");
    await expect(line(10)).toHaveCSS("cursor", "text");
    await page.mouse.move(box.x + 35, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
    assert(
      (await page.evaluate(() => window.getSelection()?.toString() ?? ""))
        .length > 0,
      `${layout}: native text selection`,
    );
    await page.keyboard.press("Control+c");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    assert(copied.includes("fixture"), `${layout}: copy selected native text`);
    await expect(page.locator("#selection")).toHaveText(selectionBefore!);
    await expect(page.locator("#dragging")).toHaveText("false");

    // Context and the shadow host survive refresh, theme, and layout changes.
    await expect(page.locator("[data-expand-up]").first()).toHaveCSS(
      "cursor",
      "pointer",
    );
    await page.locator("[data-expand-up]").first().click();
    await expect(line(20)).toBeVisible();
    await page.evaluate(() => {
      (
        document.querySelector("diffs-container") as HTMLElement
      ).dataset.testIdentity = "preserved";
    });
    await page.getByText("Refresh", { exact: true }).click();
    await page.getByText("Theme", { exact: true }).click();
    await expect(line(20)).toBeVisible();
    await expect(
      page.locator('[data-separator="line-info-basic"]').first(),
    ).toHaveCSS("background-color", "rgb(238, 241, 245)");
    await page.getByText("Theme", { exact: true }).click();
    await expect(
      page.locator('[data-separator="line-info-basic"]').first(),
    ).toHaveCSS("background-color", "rgb(52, 60, 70)");
    await expect(line(20)).toBeVisible();
    await expect(page.locator("diffs-container")).toHaveAttribute(
      "data-test-identity",
      "preserved",
    );

    // Put a surviving hunk just below the top, then remove a preceding hunk.
    await line(110).evaluate((row) => {
      const viewport = document.querySelector(".viewer-scroll")!;
      viewport.scrollTop +=
        row.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        75;
    });
    const before = await line(110).boundingBox();
    assert(before);
    const scrollBefore = await page
      .locator(".viewer-scroll")
      .evaluate((node) => node.scrollTop);
    assert(scrollBefore > 0);
    // DOM click avoids Playwright moving focus or scrolling the target first.
    await page
      .getByText("Squash", { exact: true })
      .evaluate((button: HTMLElement) => button.click());
    await expect(
      page.locator('[data-line="90"][data-line-type="change-addition"]'),
    ).toHaveCount(0);
    const after = await line(110).boundingBox();
    assert(after);
    assert(
      Math.abs(after.y - before.y) <= 1,
      `${layout}: scroll anchor moved ${after.y - before.y}px`,
    );
    assert(
      (await page
        .locator(".viewer-scroll")
        .evaluate((node) => node.scrollTop)) > 0,
    );
    await expect(page.locator('[data-line="20"]')).toHaveCount(0); // Squash contracts expanded context.
    await expect(page.locator("#error")).toHaveText("");
  }
  assert.deepEqual(errors, []);
  console.log("CodeDiff browser regressions passed (unified and split).");
} finally {
  await browser.close();
  await vite.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
