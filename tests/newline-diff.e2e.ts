// Run with: npm run test:browser:newlines
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import { newlineCases } from "./newline-cases.ts";

const fixture = await createBrowserFixture({
  entry: "/tests/newline-diff.fixture.tsx",
  captureConsoleErrors: true,
});
const { page, url, errors } = fixture;
const sourceLines = (source: string) =>
  (source.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((text, i) => ({
    line: String(i + 1),
    // HTML parsing normalizes literal CR to LF; clipboard must NOT do so.
    text: text.replace(/\r?\n$/, "").replace(/\r/g, "\n"),
  }));
const copy = async () => {
  await page.keyboard.press("Control+c");
  return page.evaluate(() => navigator.clipboard.readText());
};
const newRows = (style: "unified" | "split") =>
  page.locator(
    style === "split"
      ? "[data-additions] [data-line]"
      : '[data-line]:not([data-line-type="change-deletion"])',
  );

async function checkRendering(
  scenario: (typeof newlineCases)[number],
  style: "unified" | "split",
  label: string,
) {
  const rendered = await page.locator("diffs-container").evaluate((host) => {
    const shadow = host.shadowRoot!;
    const rows = [...shadow.querySelectorAll<HTMLElement>("[data-line]")];
    const split = !!shadow.querySelector("[data-additions]");
    const [old, additions] = [true, false].map((old) =>
      rows
        .filter((row) =>
          split
            ? !!row.closest("[data-deletions]") === old
            : row.dataset.lineType !==
              (old ? "change-addition" : "change-deletion"),
        )
        .map((row) => ({
          line:
            old && !split
              ? (row.dataset.altLine ?? row.dataset.line)
              : row.dataset.line,
          text: row.textContent,
        })),
    );
    const markers = [
      ...shadow.querySelectorAll<HTMLElement>("[data-no-newline]"),
    ].filter((node) => getComputedStyle(node).display !== "none");
    const content = [...shadow.querySelectorAll<HTMLElement>("[data-content]")];
    return {
      old,
      new: additions,
      markers: markers.length,
      numberedMarkers: markers.some((marker) =>
        marker.matches("[data-line], [data-column-number]"),
      ),
      // Metadata rows must not offset the final separator relative to its gutter.
      bottomGaps: content.map((column) => {
        const gutter = column.parentElement!.querySelector("[data-gutter]")!;
        return Math.abs(
          column.lastElementChild!.getBoundingClientRect().bottom -
            gutter.lastElementChild!.getBoundingClientRect().bottom,
        );
      }),
      heights: rows.map((row) => row.getBoundingClientRect().height),
    };
  });
  assert.deepEqual(
    rendered.old,
    sourceLines(scenario.before),
    `${label}: old source rows`,
  );
  assert.deepEqual(
    rendered.new,
    sourceLines(scenario.after),
    `${label}: new source rows`,
  );
  assert.equal(
    rendered.markers,
    scenario.markers[style],
    `${label}: visible EOF notices`,
  );
  assert.equal(
    rendered.numberedMarkers,
    false,
    `${label}: notices are not selectable source rows`,
  );
  assert(
    rendered.bottomGaps.every((gap) => gap < 1),
    `${label}: code and gutter stay aligned`,
  );
  assert(
    rendered.heights.every((height) => height > 0),
    `${label}: blank rows retain height`,
  );
  await expect(page.locator("#error")).toHaveText("");
}

try {
  // Only the test reads the clipboard. Application writes use real copy events.
  await page.context().grantPermissions(["clipboard-read"]);
  for (const initialStyle of ["unified", "split"] as const) {
    for (const transport of ["lf", "none"]) {
      for (const scenario of newlineCases) {
        const label = `${initialStyle}/${transport}/${scenario.name}`;
        await page.goto(
          `${url}/?${new URLSearchParams({ style: initialStyle, transport, case: scenario.name })}`,
        );
        await expect(page.locator("[data-line]").first()).toBeVisible();
        await checkRendering(scenario, initialStyle, label);
        if (scenario.after) {
          const rows = newRows(initialStyle);
          await rows.first().click();
          if ((await rows.count()) > 1)
            await rows.last().click({ modifiers: ["Shift"] });
          assert.equal(
            await copy(),
            scenario.after,
            `${label}: exact source copy before hydration`,
          );
          const range = await page.locator("#range").textContent();
          for (const marker of await page
            .locator("[data-no-newline]:visible")
            .all()) {
            await marker.click();
            await expect(page.locator("#range")).toHaveText(range!);
          }
          // Hydrating full source must not change notices, rows, or copied EOF.
          await page.locator("[data-expand-button]:visible").last().click();
          await expect(page.locator("#loads")).toHaveText("1");
          await expect(page.locator("[data-expand-button]")).toHaveCount(0);
          await checkRendering(scenario, initialStyle, `${label}/hydrated`);
          await page.locator(".code-surface").focus();
          assert.equal(
            await copy(),
            scenario.after,
            `${label}: exact source copy after hydration`,
          );
        }
        // Switch the existing renderer, not a fresh document, in both directions.
        const other = initialStyle === "split" ? "unified" : "split";
        await page.getByRole("button", { name: "Layout", exact: true }).click();
        await checkRendering(scenario, other, `${label}/switched`);
        await page.getByRole("button", { name: "Layout", exact: true }).click();
        await checkRendering(scenario, initialStyle, `${label}/restored`);
      }
    }
  }
  // Exercise off-screen metadata and row estimates, not just small diffs.
  await page.goto(`${url}/?large=1&style=unified&transport=none`);
  await expect(page.locator('[data-line="1"]').first()).toBeVisible();
  const heights: number[] = [];
  for (const style of ["unified", "split", "unified"] as const) {
    await page.locator(".viewer-scroll").evaluate((viewport) => {
      viewport.scrollTop = 0;
    });
    await expect(page.locator('[data-line="1"]').first()).toBeVisible();
    await page.locator(".viewer-scroll").evaluate((viewport) => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    await expect(
      newRows(style).filter({ hasText: "last" }).last(),
    ).toBeVisible();
    await expect(page.locator("[data-no-newline]:visible")).toHaveCount(
      style === "unified" ? 1 : 2,
    );
    const geometry = await page.locator("diffs-container").evaluate((host) => ({
      height: host.getBoundingClientRect().height,
      lineHeight: host
        .shadowRoot!.querySelector("[data-line]")!
        .getBoundingClientRect().height,
      gaps: [...host.shadowRoot!.querySelectorAll("[data-content]")].map(
        (content) => {
          const gutter = content.parentElement!.querySelector("[data-gutter]")!;
          return Math.abs(
            content.lastElementChild!.getBoundingClientRect().bottom -
              gutter.lastElementChild!.getBoundingClientRect().bottom,
          );
        },
      ),
    }));
    assert(
      geometry.gaps.every((gap) => gap < 1),
      `${style}: virtualized EOF alignment`,
    );
    heights.push(geometry.height);
    if (heights.length === 2)
      assert(
        Math.abs(heights[0] - heights[1] - geometry.lineHeight) < 1,
        "unified adds exactly one source row, not a duplicate metadata row",
      );
    if (heights.length < 3)
      await page.getByRole("button", { name: "Layout", exact: true }).click();
  }
  assert.equal(
    heights[0],
    heights[2],
    "layout round-trip retains virtual height",
  );
  assert.deepEqual(errors, []);
  console.log(
    `newline diff: ${newlineCases.length * 4} browser cases passed (copy, hydration, layout switches)`,
  );
} finally {
  await fixture.close();
}
