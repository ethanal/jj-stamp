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
/** Rows, rather than sticky hunk headings, must define horizontal overflow. */
async function checkHorizontalGeometry(label: string) {
  const columns = await page.locator("diffs-container").evaluate((host) => {
    return [
      ...host.shadowRoot!.querySelectorAll<HTMLElement>("[data-code]"),
    ].map((code) => {
      code.scrollLeft = 0;
      const box = code.getBoundingClientRect();
      const content = code.querySelector<HTMLElement>("[data-content]")!;
      const contentBox = content.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(code).borderRightWidth);
      const contentEnd = contentBox.right - box.left - code.clientLeft;
      const headingsFit = [
        ...code.querySelectorAll<HTMLElement>(
          "[data-gutter] [data-separator-wrapper]",
        ),
      ].every(
        (heading) =>
          Math.abs(heading.getBoundingClientRect().width - code.clientWidth) <=
          1,
      );
      const expectedScrollWidth = Math.max(
        code.clientWidth,
        Math.round(contentEnd),
      );
      code.scrollLeft = 100000;
      const line = code.querySelector<HTMLElement>(
        '[data-line-type^="change-"][data-line]',
      )!;
      const endGap = box.right - border - line.getBoundingClientRect().right;
      const result = {
        side: code.hasAttribute("data-deletions") ? "left" : "right",
        headingsFit,
        expectedScrollWidth,
        scrollWidth: code.scrollWidth,
        clientWidth: code.clientWidth,
        scrollLeft: code.scrollLeft,
        endGap,
      };
      code.scrollLeft = 0;
      return result;
    });
  });
  for (const column of columns) {
    assert(
      column.headingsFit,
      `${label} ${column.side}: hunk headings must fit the pane`,
    );
    assert(
      Math.abs(column.scrollWidth - column.expectedScrollWidth) <= 1,
      `${label} ${column.side}: phantom overflow ${JSON.stringify(column)}`,
    );
    assert(
      Math.abs(column.endGap) <= 1,
      `${label} ${column.side}: changed background stops before pane edge ${JSON.stringify(column)}`,
    );
    if (column.expectedScrollWidth === column.clientWidth)
      assert.equal(
        column.scrollLeft,
        0,
        `${label} ${column.side}: fitting content must not scroll`,
      );
  }
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
  await expect(divider).not.toHaveClass(/is-resizing/);
  await page.mouse.up();
  // The divider remains usable after scrolling far down the diff.
  await page.locator(".viewer-scroll").evaluate((el) => {
    el.scrollTop = 1000;
  });
  await divider.press("Home");
  await checkRatio(20);
  // Sweep both viewport and split widths (including fractional CSS pixels).
  // Wide panes contain every line; narrow panes also exercise genuine overflow.
  for (const width of [850, 1200, 2400, 2401]) {
    await page.setViewportSize({ width, height: 700 });
    await divider.press("Home");
    for (let ratio = 20; ratio <= 80; ratio += 2) {
      if (ratio !== 20) await divider.press("ArrowRight");
      await checkRatio(ratio);
      await checkHorizontalGeometry(`${width}px/${ratio}%`);
    }
  }
  // Real long-line overflow still responds to a horizontal wheel gesture.
  await page.setViewportSize({ width: 850, height: 700 });
  await divider.press("Home");
  await page.locator(".viewer-scroll").evaluate((el) => {
    el.scrollTop = 0;
  });
  const leftCode = page.locator("[data-code][data-deletions]");
  const leftLine = page.locator('[data-deletions] [data-line="10"]');
  await leftLine.hover({ position: { x: 60, y: 8 } });
  await page.mouse.wheel(200, 0);
  await expect
    .poll(() => leftCode.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await checkHorizontalGeometry("after horizontal wheel");
  // Growing a scrolled pane back to fit its content clamps the old offset.
  await leftCode.evaluate((el) => {
    el.scrollLeft = 150;
  });
  await expect
    .poll(() => leftCode.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  await page.setViewportSize({ width: 2400, height: 700 });
  await expect.poll(() => leftCode.evaluate((el) => el.scrollLeft)).toBe(0);
  await checkHorizontalGeometry("after widening");
  // The same 100cqi hunk headings are used by stacked diffs.
  await page.getByText("Layout", { exact: true }).click();
  for (const width of [850, 1200, 2401]) {
    await page.setViewportSize({ width, height: 700 });
    await checkHorizontalGeometry(`${width}px stacked`);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Split diff: dragging, width-sweep backgrounds/overflow, selection, keyboard, reset, persistence, scrolling and cancellation passed.",
  );
} finally {
  await fixture.close();
}
