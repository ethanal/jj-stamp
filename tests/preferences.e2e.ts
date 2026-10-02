// Run with: npx tsx tests/preferences.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { createBrowserFixture } from "./browser-fixture.ts";
import { expect } from "@playwright/test";

const source = {
  changeId: "abcdefghijklmno",
  changeIdPrefix: "abc",
  commitId: "0123456789abcdef",
  description: "Review toolbar preferences",
  author: "A. Reviewer",
};
const maliciousBookmark = '<script>alert("bookmark")</script>';
const bookmarks = [
  "main",
  "feature*",
  "name@origin",
  "conflicted??",
  maliciousBookmark,
];
const labeledRevision = {
  changeId: "ponmlkjihgfedcb",
  commitId: "1234567890abcdef",
  description: "Labeled revision",
};
const noBookmarkRevision = {
  changeId: "zyxwvutsrqponml",
  commitId: "fedcba0987654321",
  description: "No bookmark revision",
};
const graphRows = [
  { graph: "│ @  ", revision: source, bookmarks, mutable: true },
  {
    graph: "│ ○  ",
    revision: labeledRevision,
    bookmarks: ["topic@origin"],
    mutable: true,
  },
  {
    graph: "│ ○  ",
    revision: noBookmarkRevision,
    bookmarks: [],
    mutable: true,
    isEmpty: true,
  },
  ...["│ ├─╮", "│ │ │", "│ │ │", "├─╯ │", "│   │", "│   ~", "│", "~"].map(
    (graph) => ({ graph }),
  ),
];
const app = express();
app.get("/api/state", (_request, response) =>
  response.json({
    repo: { name: "example", path: "/home/reviewer/full/path/example" },
    version: "fixture-v1",
    source,
    parent: null,
    targets: [],
    files: [
      {
        path: "review.txt",
        additions: 422,
        deletions: 15,
        patch: "",
        hunks: [],
        unsupported: "Fixture preview",
      },
    ],
    operation: "fixture-op",
    canUndo: false,
  }),
);
app.get("/api/graph", (_request, response) =>
  response.json({
    version: "fixture-v1",
    rows: graphRows,
  }),
);
const fixture = await createBrowserFixture({
  app,
});
const { page, url, errors, browser } = fixture;
async function assertConnectedGraph() {
  await expect(page.locator(".log-row")).toHaveCount(graphRows.length);
  await expect(page.locator(".jj-log")).toHaveCSS("font-size", "12px");
  await expect(page.locator(".jj-log")).toHaveCSS(
    "font-family",
    '"Source Code Pro", monospace',
  );
  const metrics = await page.locator(".jj-log").evaluate(async (graph) => {
    await document.fonts.ready;
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = getComputedStyle(graph).font;
    const stroke = context.measureText("│");
    return {
      fontLoaded: [...document.fonts].some(
        (font) => font.family === "Source Code Pro" && font.status === "loaded",
      ),
      strokeHeight:
        stroke.actualBoundingBoxAscent + stroke.actualBoundingBoxDescent,
      widths: [..." │─╭╯@◆○×~"].map((char) => context.measureText(char).width),
      rows: [...graph.querySelectorAll(".log-row")].map((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, height: rect.height };
      }),
    };
  });
  assert.equal(
    metrics.fontLoaded,
    true,
    "the bundled Source Code Pro font loads",
  );
  for (const width of metrics.widths)
    assert.ok(
      Math.abs(width - metrics.widths[0]) < 0.01,
      "spaces, node symbols, and box-drawing strokes must share a column width",
    );
  for (const [index, row] of metrics.rows.entries()) {
    assert.ok(
      row.height <= metrics.strokeHeight,
      "vertical strokes must reach consecutive rows, without extra leading",
    );
    assert.equal(
      row.height,
      metrics.rows[0].height,
      "revision buttons must not make their rows taller than connector rows",
    );
    if (index) assert.equal(row.top, metrics.rows[index - 1].bottom);
  }
}
try {
  await page.goto(url);
  await expect(page.locator("html")).toHaveCSS(
    "font-family",
    '"Source Code Pro", monospace',
  );
  await expect(page).toHaveTitle(
    `${source.description} (abcdefgh /home/reviewer/full/path/example)`,
  );
  await expect(
    page.getByLabel("Current change ID").locator("strong"),
  ).toHaveCount(0);
  await expect(page.getByLabel("Current change ID")).toHaveText("abcdefgh");
  await expect(page.locator(".log-change strong")).toHaveCount(0);
  const firstLogChange = page.locator(".log-change").first();
  await expect(firstLogChange).toHaveCSS("text-decoration-line", "none");
  await firstLogChange.hover();
  await expect(firstLogChange).toHaveCSS("text-decoration-line", "none");
  await expect(page.getByLabel("Revision author")).toHaveCount(0);
  await expect(page.locator(".topbar")).not.toContainText(source.author);
  const heading = page.getByLabel("Reviewed revision");
  await expect(heading.getByLabel("Current commit ID")).toHaveText(
    "0123456789ab",
  );
  await expect(heading.getByLabel("Change line counts")).toHaveText("+422−15");
  const descriptionBox = await heading
    .locator(".source-description")
    .boundingBox();
  const commitBox = await heading.getByLabel("Current commit ID").boundingBox();
  assert(descriptionBox && commitBox);
  assert(commitBox.x - (descriptionBox.x + descriptionBox.width) <= 15);
  const currentRow = page.locator(".log-row.is-current");
  const currentBookmarks = currentRow.locator(".log-bookmarks");
  const labeledRow = page.locator(".log-row").nth(1);
  const labeledBookmarks = labeledRow.locator(".log-bookmarks");
  const noBookmarkRow = page.locator(".log-row").nth(2);
  await expect(currentRow).toBeVisible();
  await expect(page.locator(".log-bookmarks")).toHaveCount(2);
  await expect(currentRow.locator(".log-change")).toHaveText("abcdefgh");
  await expect(currentRow.locator(".log-change .log-bookmarks")).toHaveCount(0);
  await expect(currentBookmarks).toHaveText(bookmarks.join(" "));
  await expect(labeledBookmarks).toHaveText("topic@origin");
  await expect(page.locator(".log-bookmarks script")).toHaveCount(0);
  assert.equal(
    await currentRow.textContent(),
    `│ @  abcdefgh ${bookmarks.join(" ")} | ${source.description}`,
    "multiple bookmark labels render literally before the description",
  );
  assert.equal(
    await labeledRow.textContent(),
    "│ ○  ponmlkji topic@origin | Labeled revision",
  );
  await expect(noBookmarkRow.locator(".log-bookmarks")).toHaveCount(0);
  assert.equal(
    await noBookmarkRow.textContent(),
    "│ ○  zyxwvuts (empty) No bookmark revision",
    "rows without bookmarks keep their original spacing and have no separator",
  );
  await expect(currentBookmarks).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(labeledBookmarks).toHaveCSS("color", "rgb(247, 120, 186)");
  await assertConnectedGraph();
  await expect(currentRow).toHaveCSS("box-shadow", "none");
  const settings = page.getByRole("button", { name: "settings", exact: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const picker = page.getByLabel("Color scheme");
  const hoverSetting = page.getByRole("checkbox", {
    name: "Show collapsed sidebars on hover",
  });
  await expect(dialog).not.toBeVisible();
  await expect(picker).not.toBeVisible();
  await settings.click();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close settings" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(picker).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(hoverSetting).toBeFocused();
  await expect(hoverSetting).not.toBeChecked();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close settings" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(hoverSetting).toBeFocused();
  await page.getByRole("button", { name: "Close settings" }).focus();
  // App shortcuts must not operate on the inert background while settings is open.
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Collapse log sidebar" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
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
  await settings.click();
  await picker.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(currentRow).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(currentRow).toHaveCSS("background-color", "rgb(7, 87, 154)");
  await expect(currentBookmarks).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(labeledBookmarks).toHaveCSS("color", "rgb(163, 21, 91)");
  await page.reload();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await expect(log).toHaveAttribute("aria-valuenow", "400");
  await expect(dialog).not.toBeVisible();
  await settings.click();
  await expect(picker).toHaveValue("light");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await expect(files).toHaveCount(0);
  await page.getByRole("button", { name: "Expand files sidebar" }).click();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  // Hover previews are opt-in overlays, not persisted expansions.
  const filesPanel = page.getByLabel("Files sidebar", { exact: true });
  const logPanel = page.getByLabel("Revision graph", { exact: true });
  const filesBody = page.locator("#files-sidebar-content");
  const logBody = page.locator("#log-sidebar-content");
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();
  await filesPanel.hover();
  await expect(filesBody).toBeHidden();
  await logPanel.hover();
  await expect(logBody).toBeHidden();
  await settings.click();
  await hoverSetting.check();
  await page.keyboard.press("Escape");
  await page.locator(".viewer").hover();
  const viewerBox = await page.locator(".viewer").boundingBox();
  for (const [side, panel, body, width] of [
    ["files", filesPanel, filesBody, "340px"],
    ["log", logPanel, logBody, "400px"],
  ] as const) {
    // Touch contact and dragging across a rail must not trigger a peek.
    await panel.dispatchEvent("pointerover", {
      pointerType: "touch",
      buttons: 0,
    });
    await expect(body).toBeHidden();
    await panel.dispatchEvent("pointerout", { pointerType: "touch" });
    await panel.dispatchEvent("pointerover", {
      pointerType: "mouse",
      buttons: 1,
    });
    await expect(body).toBeHidden();
    await panel.dispatchEvent("pointerout", { pointerType: "mouse" });
    await panel.hover();
    await expect(body).toBeVisible();
    await expect(panel).toHaveCSS("width", width);
    await expect(
      page.getByRole("button", { name: `Pin ${side} sidebar` }),
    ).toHaveAttribute("aria-expanded", "true");
    assert.deepEqual(await page.locator(".viewer").boundingBox(), viewerBox);
    assert.equal(
      await page.evaluate(
        (side) => localStorage.getItem(`jj-stamp.${side}-expanded`),
        side,
      ),
      "false",
    );
    // Stay open when moving from the rail into its interactive contents.
    const box = await panel.boundingBox();
    assert(box);
    await page.mouse.move(box.x + box.width / 2, box.y + 80);
    await expect(body).toBeVisible();
    await page.locator(".viewer").hover();
    await expect(body).toBeHidden();
  }
  await filesPanel.hover();
  await page.getByRole("button", { name: "Pin files sidebar" }).focus();
  await page.keyboard.press("Escape");
  await expect(filesBody).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Expand files sidebar" }),
  ).toBeFocused();
  await page.locator(".viewer").hover();
  await filesPanel.hover();
  await page.getByRole("button", { name: "Pin files sidebar" }).click();
  await page.locator(".viewer").hover();
  await expect(filesBody).toBeVisible();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await expect(filesBody).toBeHidden();
  await page.locator(".viewer").hover();
  await page.reload();
  await expect(filesBody).toBeHidden();
  await expect(logBody).toBeHidden();
  // The graph must load on its first hover after a collapsed startup.
  await logPanel.hover();
  await expect(logBody).toBeVisible();
  await expect(page.locator(".log-row")).toHaveCount(graphRows.length);
  await page.locator(".viewer").hover();
  await expect(logBody).toBeHidden();
  await settings.click();
  await expect(hoverSetting).toBeChecked();
  await hoverSetting.uncheck();
  await page.keyboard.press("Escape");
  await filesPanel.hover();
  await expect(filesBody).toBeHidden();
  await logPanel.hover();
  await expect(logBody).toBeHidden();
  await page.getByRole("button", { name: "Expand files sidebar" }).click();
  await page.getByRole("button", { name: "Expand log sidebar" }).click();
  await settings.click();
  await picker.selectOption("dim");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(34, 39, 46)",
  );
  await expect(currentBookmarks).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(labeledBookmarks).toHaveCSS("color", "rgb(240, 166, 202)");
  for (const [scheme, background, mode, bookmark, current] of [
    [
      "solarized-dark",
      "rgb(0, 43, 54)",
      "dark",
      "rgb(232, 117, 178)",
      "rgb(253, 246, 227)",
    ],
    [
      "solarized-light",
      "rgb(253, 246, 227)",
      "light",
      "rgb(163, 21, 91)",
      "rgb(253, 246, 227)",
    ],
  ] as const) {
    await page.getByLabel("Color scheme").selectOption(scheme);
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      background,
    );
    await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
    await page.reload();
    await settings.click();
    await expect(picker).toHaveValue(scheme);
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      background,
    );
    await expect(currentBookmarks).toHaveCSS("color", current);
    await expect(labeledBookmarks).toHaveCSS("color", bookmark);
  }
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.screenshot({ path: "/tmp/jj-stamp-preferences-desktop.png" });
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(files).toBeVisible();
  await expect(log).not.toBeVisible();
  await assertConnectedGraph();
  await expect(page.getByLabel("Reviewed revision")).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await settings.click();
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  assert(dialogBox && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 600);
  await hoverSetting.check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();
  await page.locator(".viewer").hover();
  const mobileViewer = await page.locator(".viewer").boundingBox();
  for (const [panel, body] of [
    [filesPanel, filesBody],
    [logPanel, logBody],
  ]) {
    await panel.hover();
    await expect(body).toBeVisible();
    assert.deepEqual(await page.locator(".viewer").boundingBox(), mobileViewer);
    const box = await panel.boundingBox();
    assert(
      box &&
        box.x >= 0 &&
        box.x + box.width <= 600 &&
        box.y >= 0 &&
        box.y + box.height <= 800,
    );
    await page.locator(".viewer").hover();
    await expect(body).toBeHidden();
  }
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
  await noStorage
    .getByRole("button", { name: "settings", exact: true })
    .click();
  await expect(noStorage.getByLabel("Color scheme")).toHaveValue("dark");
  const noStorageHover = noStorage.getByRole("checkbox", {
    name: "Show collapsed sidebars on hover",
  });
  await expect(noStorageHover).not.toBeChecked();
  await noStorageHover.check();
  await expect(noStorageHover).toBeChecked();
  await noStorage.getByLabel("Color scheme").selectOption("light");
  await expect(noStorage.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await noStorage.close();
  assert.deepEqual(errors, []);
  console.log(
    "Preference browser checks passed: drag/keyboard resize, persistence, themes, title/header, graph highlight/connected strokes, accessible settings, mobile, unavailable storage.",
  );
} finally {
  await fixture.close();
}
