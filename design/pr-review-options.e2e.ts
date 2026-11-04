// Design-only checks; no API server, GitHub, or repository mutations.
// Run from the repository root: npx tsx design/pr-review-options.e2e.ts
import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";

const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1500, height: 1100 },
  });
  const errors: string[] = [];
  const requests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.goto(new URL("./pr-review-options.html", import.meta.url).href);
  await page.evaluate(() =>
    Promise.all([...document.images].map((image) => image.decode())),
  );
  const captures = await page.evaluate(() =>
    JSON.parse(document.querySelector("#captures")!.textContent!),
  );
  for (const mode of ["base", "menu", "ribbon", "dock"]) {
    await page.locator(`[data-mode="${mode}"]`).click();
    await expect(page.locator("#header-image")).toHaveAttribute(
      "src",
      captures.topbar,
    );
    await expect(page.locator("#footer-image")).toHaveAttribute(
      "src",
      captures.statusbar,
    );
    await expect(page.locator("#workspace-image")).toHaveAttribute(
      "src",
      captures[mode === "ribbon" ? "workspace-ribbon" : "workspace"],
    );
    assert.equal(
      await page
        .locator("#additions")
        .textContent()
        .then((text) => !text),
      mode === "base",
      "baseline has no proposed controls",
    );
    if (mode !== "base") {
      await page.locator('[data-action="menu"]').click();
      await expect(page.locator(".popup")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".popup")).toHaveCount(0);
    }
  }
  const tray = await page.locator(".comment-tray").evaluate((element) => ({
    left: (element as HTMLElement).offsetLeft,
    width: (element as HTMLElement).offsetWidth,
  }));
  assert.deepEqual(tray, { left: 245, width: 845 });
  await page.getByRole("button", { name: "Comment on added line 21" }).click();
  await page.locator("#body").fill("<strong>A local draft</strong>");
  await page
    .getByRole("button", { name: "Stage comment", exact: true })
    .click();
  await page.getByRole("button", { name: "View all", exact: true }).click();
  await expect(page.locator("#draft-list")).toContainText(
    "<strong>A local draft</strong>",
  );
  await expect(page.locator("#draft-list strong")).toHaveCount(0);
  await page.locator('#drafts [data-action="submit"]').click();
  await expect(page.locator("#submit-summary")).toContainText(
    "2 mapped comment(s)",
  );
  await page
    .locator("#submit-form")
    .getByText("Approve", { exact: true })
    .click();
  await page.getByRole("button", { name: "Confirm submission (demo)" }).click();
  await page.locator('[data-mode="ribbon"]').click();
  await page.getByRole("button", { name: "Refresh PR", exact: true }).click();
  await expect(page.locator(".pr-strip")).toContainText("Up to date");
  await page.locator('[data-action="menu"]').click();
  await page.getByRole("button", { name: "Dismiss local review…" }).click();
  await page.getByRole("button", { name: "Archive locally (demo)" }).click();
  await expect(page.locator('[data-mode="base"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "1 · Open a PR" }).click();
  await page.locator("#pr-input").fill("284");
  await page.getByRole("button", { name: "Open review (demo)" }).click();
  await expect(page.locator('[data-mode="ribbon"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("#highlight").uncheck();
  await expect(page.locator("#stage")).not.toHaveClass(/highlight/);
  await page.getByRole("button", { name: "View at 100%" }).click();
  await page.getByRole("button", { name: "Fit to width" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests, [], "self-contained; no external requests");
  console.log(
    "PASS: actual-app baseline, all additive layouts, composer, staging, submission, refresh, dismissal, picker, zoom, narrow viewport; no JS errors or external requests",
  );
} finally {
  await browser.close();
}
