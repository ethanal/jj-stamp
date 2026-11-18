import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture";

const fixture = await createBrowserFixture({
  entry: "/tests/drag-selection.fixture.tsx",
  viewport: { width: 1100, height: 750 },
});
const { page, url, errors } = fixture;
const input = await page.context().newCDPSession(page);
const allRows = Array.from({ length: 12 }, (_, i) => i + 1);
try {
  for (const layout of ["unified", "split"] as const) {
    await page.goto(url);
    const surface = page.locator(".code-surface").first();
    await expect(surface.locator("[data-line]").first()).toBeVisible();
    if (layout === "split")
      await page.getByText("Layout", { exact: true }).click();
    await expect(surface.locator("[data-line]").first()).toBeVisible();
    for (const gutter of [false, true]) {
      for (const side of layout === "split"
        ? ["deletions", "additions"]
        : ["deletions"]) {
        const rows = surface.locator(
          gutter ? "[data-column-number]" : "[data-line]",
        );
        const endpoints =
          layout === "split"
            ? surface
                .locator(`[data-${side}]`)
                .locator(gutter ? "[data-column-number]" : "[data-line]")
            : rows;
        const first = await endpoints.first().boundingBox();
        const last = await endpoints.last().boundingBox();
        const viewport = await page.locator(".viewer-scroll").boundingBox();
        assert(first && last && viewport);
        assert(
          last.y + last.height < viewport.y + viewport.height / 2,
          "the entire diff must fit in the upper half of the viewport",
        );
        const x = first.x + Math.min(first.width / 2, 100);
        for (const reverse of [false, true]) {
          await page.keyboard.press("Escape");
          const start = await (
            reverse ? endpoints.last() : endpoints.first()
          ).boundingBox();
          assert(start);
          await page.mouse.move(x, start.y + start.height / 2);
          await page.mouse.down();
          await expect(page.locator("#dragging")).toHaveText("true");
          // A single pointer event skips every intervening line, landing in
          // empty space beyond the diff. No timing/polling assumptions.
          await page.mouse.move(
            x,
            reverse ? viewport.y - 10 : viewport.y + viewport.height - 10,
          );
          await page.mouse.up();
          if (
            !gutter &&
            !reverse &&
            side === "deletions" &&
            process.env.DRAG_SCREENSHOT
          ) {
            await mkdir(".planka-artifacts", { recursive: true });
            await page.screenshot({
              path: `.planka-artifacts/${process.env.DRAG_SCREENSHOT}-${layout}.png`,
            });
          }
          await expect(
            page.locator("#selection"),
            `${layout}, gutter=${gutter}, side=${side}, reverse=${reverse}`,
          ).toHaveText(JSON.stringify({ "first.ts": allRows }));
          await expect(page.locator("#dragging")).toHaveText("false");
        }
      }
    }

    // A release can be the first event beyond the row. In particular, do not
    // mistake a drag from an already-selected single line for a toggle click.
    const startRow = surface.locator("[data-line]").first();
    await page.keyboard.press("Escape");
    await startRow.click();
    const start = await startRow.boundingBox();
    const viewport = await page.locator(".viewer-scroll").boundingBox();
    assert(start && viewport);
    await page.mouse.move(start.x + 100, start.y + start.height / 2);
    await page.mouse.down();
    await input.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x: start.x + 100,
      y: viewport.y + viewport.height - 10,
    });
    await page.mouse.up();
    await expect(page.locator("#selection")).toHaveText(
      JSON.stringify({ "first.ts": allRows }),
    );
    await expect(page.locator("#dragging")).toHaveText("false");

    // Shift keeps the existing anchor even when the new drag starts midway.
    await page.keyboard.press("Escape");
    await startRow.click();
    const middle = await surface
      .locator('[data-line="3"]')
      .last()
      .boundingBox();
    assert(middle);
    await page.keyboard.down("Shift");
    await page.mouse.move(middle.x + 100, middle.y + middle.height / 2);
    await page.mouse.down();
    await page.mouse.move(middle.x + 100, viewport.y + viewport.height - 10);
    await expect(page.locator("#selection")).toHaveText(
      JSON.stringify({ "first.ts": allRows }),
    );
    // Reentering the diff must shrink the range normally.
    // Leave the autoscroll zone before measuring the row's current position.
    await page.mouse.move(middle.x + 100, viewport.y + viewport.height - 100);
    const reentry = await surface
      .locator('[data-line="3"]')
      .last()
      .boundingBox();
    assert(reentry);
    await page.mouse.move(reentry.x + 100, reentry.y + reentry.height / 2);
    await page.mouse.up();
    await page.keyboard.up("Shift");
    await expect(page.locator("#selection")).toHaveText(
      JSON.stringify({
        "first.ts":
          layout === "split" ? [1, 2, 3, 7, 8, 9] : allRows.slice(0, 9),
      }),
    );

    // Crossing into another file still clamps to the originating file.
    await page.getByText("All files", { exact: true }).click();
    const first = await surface.locator("[data-line]").first().boundingBox();
    const other = await page
      .locator(".code-surface")
      .nth(1)
      .locator("[data-line]")
      .last()
      .boundingBox();
    assert(first && other);
    await page.keyboard.press("Escape");
    await page.mouse.move(first.x + 100, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(other.x + 100, other.y + other.height / 2);
    await page.mouse.up();
    await expect(page.locator("#selection")).toHaveText(
      JSON.stringify({ "first.ts": allRows }),
    );
    await expect(page.locator("#dragging")).toHaveText("false");
  }
  assert.deepEqual(errors, []);
  console.log(
    "Fast drag selection passed (stacked/split, code/gutters, both directions, release-only, Shift, reentry and file boundaries).",
  );
} finally {
  await fixture.close();
}

// Boundary clamping must still follow newly rendered rows while autoscrolling
// a long diff, rather than jumping immediately to the file's final line.
const scrolling = await createBrowserFixture({
  entry: "/tests/code-diff.fixture.tsx",
  viewport: { width: 1200, height: 700 },
});
try {
  const { page, url } = scrolling;
  for (const layout of ["unified", "split"] as const) {
    await page.goto(url);
    const first = page.locator('[data-line="10"]').last();
    await expect(first).toBeVisible();
    if (layout === "split")
      await page.getByText("Layout", { exact: true }).click();
    await expect(first).toBeVisible();
    const start = await first.boundingBox();
    const viewport = await page.locator(".viewer-scroll").boundingBox();
    assert(start && viewport);
    await page.mouse.move(start.x + 100, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(start.x + 100, viewport.y + viewport.height + 50);
    await expect
      .poll(() =>
        page.locator(".viewer-scroll").evaluate((node) => node.scrollTop),
      )
      .toBeGreaterThan(200);
    await expect
      .poll(
        async () =>
          JSON.parse((await page.locator("#range").textContent())!).end,
      )
      .toBeGreaterThan(30);
    await page.mouse.up();
    const range = JSON.parse((await page.locator("#range").textContent())!);
    assert(
      range.end < 290,
      "autoscroll selects visible rows, not the entire file",
    );
    await expect(page.locator("#dragging")).toHaveText("false");
  }
  assert.deepEqual(scrolling.errors, []);
  console.log("Drag autoscroll passed (stacked and split).");
} finally {
  await scrolling.close();
}
