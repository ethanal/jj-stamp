// Run with: npx tsx tests/code-diff.e2e.ts
import assert from "node:assert/strict";
import { createBrowserFixture } from "./browser-fixture.ts";
import { expect } from "@playwright/test";

const fixture = await createBrowserFixture({
  entry: "/tests/code-diff.fixture.tsx",
  viewport: { width: 1200, height: 700 },
});
const { page, url, errors } = fixture;
const line = (n: number) =>
  page
    .locator(`[data-line="${n}"]:not([data-line-type="change-deletion"])`)
    .last();
try {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  for (const layout of ["unified", "split"] as const) {
    await page.goto(url);
    await expect(line(10)).toBeVisible();
    await expect(
      page
        .locator("[data-fold-hunk-context]")
        .filter({ hasText: "function fixtureSection30() {" })
        .first(),
    ).toBeVisible();
    const labeledSeparator = page
      .locator("[data-separator-content][data-fold-has-hunk-context]")
      .first();
    await expect(labeledSeparator).toHaveCSS("display", "flex");
    await expect(
      labeledSeparator.locator("[data-unmodified-lines]"),
    ).toBeHidden();
    const separatorBox = await labeledSeparator
      .locator("[data-fold-hunk-context]")
      .boundingBox();
    const contentBox = await labeledSeparator.boundingBox();
    assert(separatorBox && contentBox);
    assert(separatorBox.y >= contentBox.y);
    assert(
      separatorBox.y + separatorBox.height <= contentBox.y + contentBox.height,
    );
    await expect(
      page.getByText("More unchanged context may be available").first(),
    ).toBeHidden();
    await expect(page.locator("#file-loads")).toHaveText("0");
    if (layout === "split")
      await page.getByText("Layout", { exact: true }).click();
    // A controlled anchor can be extended, replaced, cleared, and reset.
    await line(10).click();
    await line(30).click({ modifiers: ["Shift"] });
    await expect(page.locator("#range")).toHaveText(
      JSON.stringify({
        start: 10,
        side: "additions",
        end: 30,
        endSide: "additions",
      }),
    );
    await line(30).click(); // plain click moves the anchor, rather than extending it
    await line(10).click({ modifiers: ["Shift"] });
    await expect(page.locator("#range")).toHaveText(
      JSON.stringify({
        start: 30,
        side: "additions",
        end: 10,
        endSide: "additions",
      }),
    );
    await line(10).click();
    await line(10).click(); // click the lone selected line again to unselect
    await expect(page.locator("#range")).toHaveText("null");
    await expect(page.locator("#selection")).toHaveText("{}");
    await line(30).click({ modifiers: ["Shift"] }); // no stale line-10 anchor
    await expect(page.locator("#range")).toHaveText(
      JSON.stringify({
        start: 30,
        side: "additions",
        end: 30,
        endSide: "additions",
      }),
    );
    await page.keyboard.press("Escape");
    await expect(page.locator("#range")).toHaveText("null");
    await line(10).click({ modifiers: ["Shift"] });
    await page.getByText("Clear", { exact: true }).click(); // external reset
    await line(30).click({ modifiers: ["Shift"] });
    await expect(page.locator("#range")).toHaveText(
      JSON.stringify({
        start: 30,
        side: "additions",
        end: 30,
        endSide: "additions",
      }),
    );
    await page.keyboard.press("Escape");

    const requests: { path: string; version: string; line: number }[] = [];
    let editorFailure = false;
    await page.route("**/api/editor", async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: editorFailure ? 503 : 200,
        contentType: "application/json",
        body: JSON.stringify(
          editorFailure
            ? { error: "Neovim server is unavailable" }
            : { success: true },
        ),
      });
    });
    await line(10).hover();
    await page.keyboard.press("e");
    await expect.poll(() => requests.length).toBe(1);
    assert.deepEqual(requests[0], {
      path: "scroll-fixture.ts",
      version: "0",
      line: 10,
    });
    await page
      .locator('[data-line="10"][data-line-type="change-deletion"]')
      .first()
      .hover();
    await page.keyboard.press("e");
    await expect.poll(() => requests.length).toBe(2);
    assert.equal(requests[1].line, 10); // deletion opens its working-tree replacement
    await page.getByText("Layout", { exact: true }).hover();
    await page.keyboard.press("e"); // no hovered line
    await page
      .getByRole("textbox", { name: "Editable shortcut guard" })
      .focus();
    await line(10).hover();
    await page.keyboard.press("e");
    await page.getByLabel("Editable text").focus();
    await page.keyboard.press("e");
    await page.locator(".code-surface").focus();
    for (const key of ["Control+e", "Meta+e", "Alt+e", "Shift+e"])
      await page.keyboard.press(key);
    await page.waitForTimeout(100);
    assert.equal(requests.length, 2, `${layout}: editor shortcut guards`);
    await page.getByText("Refresh", { exact: true }).click();
    await line(10).hover();
    await page.locator(".code-surface").focus();
    await page.keyboard.press("e");
    await expect.poll(() => requests.length).toBe(3);
    assert.equal(
      requests[2].version,
      "1",
      "editor uses the refreshed diff version",
    );
    editorFailure = true;
    await line(10).hover();
    await page.keyboard.press("e");
    await expect(page.getByRole("alert")).toContainText(
      "Neovim server is unavailable",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.unroute("**/api/editor");

    const box = await line(10).boundingBox();
    assert(box);
    // Native selection does not call squash-selection handlers, even after a
    // normal selection already exists (Alt must not extend the squash range).
    await page.mouse.move(box.x + 25, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator("#selection")).not.toHaveText("{}");
    const selectionBefore = await page.locator("#selection").textContent();
    await page.keyboard.down("Alt");
    await expect(line(10)).toHaveCSS("cursor", "text");
    await page.mouse.move(box.x + 35, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 200, box.y + box.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
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
    await line(10).click();
    assert.equal(
      await page.evaluate(() => window.getSelection()?.toString() ?? ""),
      "",
      `${layout}: ordinary click clears the old native text highlight`,
    );
    await expect(page.locator("#selection")).toHaveText("{}");
    await line(10).click();
    await expect(page.locator("#selection")).toHaveText(selectionBefore!);

    // Context and the shadow host survive refresh, theme, and layout changes.
    await expect(page.locator("[data-expand-up]").first()).toHaveCSS(
      "cursor",
      "pointer",
    );
    await page.locator("[data-expand-up]").first().click();
    await expect(page.locator("#file-loads")).toHaveText("1");
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
    ).toHaveCSS("background-color", "rgb(234, 238, 242)");
    await page.getByText("Theme", { exact: true }).click();
    await expect(
      page.locator('[data-separator="line-info-basic"]').first(),
    ).toHaveCSS("background-color", "rgb(52, 60, 70)");
    for (const [mode, separator] of [
      ["dark", "rgb(7, 54, 66)"],
      ["light", "rgb(238, 232, 213)"],
    ]) {
      await page.getByText("Theme", { exact: true }).click();
      await expect(page.locator("diffs-container")).toHaveCSS(
        "color-scheme",
        mode,
      );
      await expect(
        page.locator('[data-separator="line-info-basic"]').first(),
      ).toHaveCSS("background-color", separator);
      await expect(line(20)).toBeVisible();
      await expect(page.locator("#selection")).toHaveText(selectionBefore!);
    }
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
  await fixture.close();
}
