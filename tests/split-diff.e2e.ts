import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";

const fixture = await createBrowserFixture({
  entry: "/tests/code-diff.fixture.tsx",
  viewport: { width: 1200, height: 700 },
});
const { page, url, errors } = fixture;
const divider = page.getByRole("separator", { name: "Resize split diff" });
async function checkRatio(ratio: number) {
  await expect(divider).toHaveAttribute("aria-valuenow", String(ratio));
  const columns = await page.locator("diffs-container").evaluate((host) => {
    const shadow = host.shadowRoot!;
    const left = shadow
      .querySelector("[data-code][data-deletions]")!
      .getBoundingClientRect();
    const right = shadow
      .querySelector("[data-code][data-additions]")!
      .getBoundingClientRect();
    return { left: left.width, right: right.width, seam: right.x };
  });
  assert(
    Math.abs((columns.left / (columns.left + columns.right)) * 100 - ratio) <
      0.2,
  );
  const box = await divider.boundingBox();
  assert(box && Math.abs(box.x + box.width / 2 - columns.seam) < 2);
}
try {
  await page.goto(url);
  await expect(page.locator('[data-line="10"]').last()).toBeVisible();
  await expect(divider).toHaveCount(0);
  await page.getByText("Layout", { exact: true }).click();
  await checkRatio(50);
  // Expanded context and selection must survive resizing without a rerender.
  await page.locator("[data-expand-button]").first().click();
  const line = page.locator('[data-additions] [data-line="10"]');
  await line.click();
  const selection = await page.locator("#selection").textContent();
  const loads = await page.locator("#file-loads").textContent();
  const box = await divider.boundingBox();
  assert(box);
  const y = box.y + 100;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 180, y, { steps: 8 });
  await page.mouse.up();
  await checkRatio(65);
  await expect(page.locator("#selection")).toHaveText(selection!);
  await expect(page.locator("#file-loads")).toHaveText(loads!);
  await expect(page.locator('[data-additions] [data-line="1"]')).toHaveCount(1);
  await expect(page.locator("#dragging")).toHaveText("false");
  await divider.press("ArrowLeft");
  await checkRatio(63);
  await divider.press("Shift+ArrowRight");
  await checkRatio(73);
  await divider.press("Home");
  await checkRatio(20);
  await divider.press("End");
  await checkRatio(80);
  await divider.dblclick({ position: { x: 4, y: 100 } });
  await checkRatio(50);
  await divider.press("Shift+ArrowLeft");
  await checkRatio(40);
  await page.getByText("Layout", { exact: true }).click();
  await expect(divider).toHaveCount(0);
  await page.getByText("Layout", { exact: true }).click();
  await checkRatio(40);
  await page.reload();
  await page.getByText("Layout", { exact: true }).click();
  await checkRatio(40);
  await page.setViewportSize({ width: 850, height: 700 });
  await checkRatio(40);
  // Clamp an overshooting drag and clean up cancellation/capture loss.
  const resized = await divider.boundingBox();
  assert(resized);
  await page.mouse.move(resized.x + resized.width / 2, resized.y + 100);
  await page.mouse.down();
  await page.mouse.move(849, resized.y + 100);
  await checkRatio(80);
  await divider.dispatchEvent("pointercancel");
  await expect(page.locator(".split-diff-layout")).not.toHaveClass(
    /is-resizing/,
  );
  await page.mouse.up();
  // The divider remains usable after scrolling far down the diff.
  await page.locator(".viewer-scroll").evaluate((el) => {
    el.scrollTop = 1000;
  });
  await divider.press("Home");
  await checkRatio(20);
  assert.deepEqual(errors, []);
  console.log(
    "Split diff: dragging, geometry, selection, keyboard, reset, persistence, scrolling and cancellation passed.",
  );
} finally {
  await fixture.close();
}
