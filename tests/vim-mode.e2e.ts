// Run with: npx tsx tests/vim-mode.e2e.ts (mock API; no jj executable needed)
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { DiffFile, RepoState } from "../src/types";

const source = {
  changeId: "shortcuts-change",
  commitId: "a".repeat(40),
  description: "Keyboard shortcut fixture",
};
const parent = {
  changeId: "shortcuts-parent",
  commitId: "b".repeat(40),
  description: "Mutable parent",
};
const firstLine = "first line " + "long context ".repeat(30);
const oldText = `${firstLine}\nold value\nlast line\n`;
const newText = `${firstLine}\nnew value\nlast line\n`;
const file: DiffFile = {
  path: "review.txt",
  additions: 1,
  deletions: 1,
  patch: [
    "diff --git a/review.txt b/review.txt",
    "--- a/review.txt",
    "+++ b/review.txt",
    "@@ -1,3 +1,3 @@",
    ` ${firstLine}`,
    "-old value",
    "+new value",
    " last line",
    "",
  ].join("\n"),
  hunks: [
    {
      id: "review-hunk",
      header: "@@ -1,3 +1,3 @@",
      rows: [
        { index: 1, raw: ` ${firstLine}`, oldLine: 1, newLine: 1 },
        { index: 2, raw: "-old value", oldLine: 2 },
        { index: 3, raw: "+new value", newLine: 2 },
        { index: 4, raw: " last line", oldLine: 3, newLine: 3 },
      ],
    },
  ],
};
const largeRows = Array.from({ length: 500 }, (_, i) => ({
  index: i + 1,
  raw: `+added line ${i + 1}`,
  newLine: i + 1,
}));
const large: DiffFile = {
  path: "large.txt",
  additions: 500,
  deletions: 0,
  patch: `diff --git a/large.txt b/large.txt\nnew file mode 100644\n--- /dev/null\n+++ b/large.txt\n@@ -0,0 +1,500 @@\n${largeRows.map((row) => row.raw).join("\n")}\n`,
  hunks: [{ id: "large-hunk", header: "@@ -0,0 +1,500 @@", rows: largeRows }],
};
const state: RepoState = {
  repo: { name: "shortcuts", path: "/tmp/shortcuts-fixture" },
  version: "shortcuts-v1",
  source,
  parent,
  targets: [parent],
  files: [file, large],
  operation: "shortcuts-op1",
  canUndo: true,
};
const squashRequests: { selections: { id: string; lines: number[] }[] }[] = [];
const mutations: string[] = [];
const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => {
  response.json(state);
});
app.get("/api/graph", (_request, response) =>
  response.json({
    version: state.version,
    rows: [source, parent].map((revision, index) => ({
      graph: index ? "○ " : "@ ",
      revision,
      mutable: true,
    })),
  }),
);
app.get("/api/events", (_request, response) => response.sendStatus(204));
app.post("/api/commit", (_request, response) =>
  response.status(404).json({ error: "No optional cached preview" }),
);
app.post("/api/commit-file", (_request, response) =>
  response.json({
    oldFile: { name: file.path, contents: oldText },
    newFile: { name: file.path, contents: newText },
  }),
);
for (const route of ["squash-lines", "undo", "revision", "editor"])
  app.post(`/api/${route}`, (_request, response) => {
    mutations.push(route);
    if (route === "squash-lines") squashRequests.push(_request.body);
    response.json({ state });
  });

const fixture = await createBrowserFixture({
  app,
  viewport: { width: 1280, height: 720 },
});
const { page, url, errors } = fixture;
const surface = page.locator(".code-surface").first();
const cursor = () => page.locator("[data-line][data-fold-vim-cursor]");
const selected = () => page.locator("[data-line][data-fold-selected]");
const added = () =>
  surface.locator('[data-line-type="change-addition"][data-line="2"]');
const settings = page.getByRole("button", { name: "settings", exact: true });
const vim = page.getByRole("checkbox", { name: "Vim mode", exact: true });
async function at(line: number, side?: "addition" | "deletion") {
  await expect(cursor()).toHaveCount(1);
  await expect(cursor()).toHaveAttribute("data-line", String(line));
  if (side)
    await expect(cursor()).toHaveAttribute("data-line-type", `change-${side}`);
}
try {
  await page.goto(url);
  await expect(added()).toBeVisible();
  await surface.focus();
  await page.keyboard.press("j");
  await page.keyboard.press("Shift+V");
  await expect(cursor()).toHaveCount(0);
  await expect(selected()).toHaveCount(0);
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Expand log sidebar" }),
  ).toBeVisible();
  await page.keyboard.press("l");
  await settings.click();
  await expect(vim).not.toBeChecked();
  await vim.check();
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(added()).toBeVisible();
  await settings.click();
  await expect(vim).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(cursor()).toHaveCount(0);

  // Works immediately after settings, without requiring a mouse selection.
  await page.keyboard.press("j");
  await at(1);
  await expect(surface).toBeFocused();
  await page.keyboard.press("j");
  await at(2, "deletion");
  await expect(selected()).toHaveCount(0);
  await page.keyboard.press("Shift+V");
  await expect(surface).toHaveAttribute("data-vim-mode", "visual");
  await expect(selected()).toHaveCount(1);
  await page.keyboard.press("j");
  await at(2, "addition");
  await expect(selected()).toHaveCount(2);
  await page.keyboard.press("k");
  await expect(selected()).toHaveCount(1);
  await page.keyboard.press("k");
  await at(1);
  await expect(selected()).toHaveCount(1);
  await expect(
    surface.locator("[data-line][data-fold-context-selected]"),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(selected()).toHaveCount(0);
  await expect(surface).toHaveAttribute("data-vim-mode", "normal");
  await page.keyboard.press("j");
  await expect(selected()).toHaveCount(0); // no stale visual anchor
  await page.keyboard.press("Shift+V");
  await expect(selected()).toHaveCount(1);
  await page.keyboard.press("Shift+V");
  await expect(selected()).toHaveCount(0);

  // h/l scroll stacked code instead of toggling the graph.
  await page.keyboard.press("l");
  await expect
    .poll(() =>
      surface
        .locator("[data-code]")
        .evaluateAll((nodes) => Math.max(...nodes.map((n) => n.scrollLeft))),
    )
    .toBeGreaterThan(0);
  await expect(
    page.getByRole("button", { name: "Collapse log sidebar" }),
  ).toBeVisible();
  await page.keyboard.press("h");
  await expect
    .poll(() =>
      surface
        .locator("[data-code]")
        .evaluateAll((nodes) => Math.max(...nodes.map((n) => n.scrollLeft))),
    )
    .toBe(0);

  // Repeated motions work; browser/editor combinations and dialog keys don't.
  await surface.dispatchEvent("keydown", { key: "j", repeat: true });
  await at(2, "addition");
  for (const init of [
    { ctrlKey: true },
    { altKey: true },
    { metaKey: true },
    { shiftKey: true },
    { isComposing: true },
    { prevented: true },
  ]) {
    await surface.evaluate((element, init) => {
      const event = new KeyboardEvent("keydown", {
        key: "j",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if ("prevented" in init) event.preventDefault();
      element.dispatchEvent(event);
    }, init);
    await at(2, "addition");
  }
  await page.keyboard.press("Shift+V");
  await settings.click();
  await page.getByRole("button", { name: "Close settings" }).focus();
  for (const key of ["j", "k", "h", "l", "Shift+V", "s"])
    await page.keyboard.press(key);
  await page.keyboard.press("Escape");
  await expect(selected()).toHaveCount(1);
  await expect(surface).toHaveAttribute("data-vim-mode", "visual");
  assert.deepEqual(mutations, []);
  await page.keyboard.press("?");
  await page.keyboard.press("j");
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("Escape");
  await expect(selected()).toHaveCount(1);
  await page.keyboard.press("Control+f");
  const search = page.getByRole("searchbox", { name: "Search diff" });
  await search.fill("");
  await page.keyboard.type("hjklV");
  await expect(search).toHaveValue("hjklV");
  await page.keyboard.press("Escape");
  await at(2, "addition");
  await expect(selected()).toHaveCount(1);
  await page.keyboard.press("Escape");

  // Split motion follows visual rows, and h/l switches sides on a paired row.
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await added().click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("h");
  await at(2, "deletion");
  await page.keyboard.press("l");
  await at(2, "addition");
  await page.keyboard.press("Shift+V");
  await expect(selected()).toHaveCount(2); // split visual line includes both changes
  await page.keyboard.press("j");
  await at(3);
  await page.keyboard.press("j");
  await at(3); // clamped at EOF
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await at(1);
  await page.keyboard.press("k");
  await at(1);
  await page.keyboard.press("Escape");

  // Mouse gestures move the cursor and terminate the keyboard visual anchor.
  await added().click();
  await page.keyboard.press("Shift+V");
  await surface.locator('[data-additions] [data-line="3"]').click();
  await expect(surface).toHaveAttribute("data-vim-mode", "normal");
  await page.keyboard.press("k");
  await at(2, "addition");
  await expect(selected()).toHaveCount(0);
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("s");
  await expect.poll(() => squashRequests.length).toBe(1);
  assert.deepEqual(squashRequests[0].selections, [
    { id: "review-hunk", lines: [2, 3] },
  ]);
  await expect(selected()).toHaveCount(0);

  // All-files mode: one focused diff handles the key, including virtual rows.
  await page.reload();
  await expect(added()).toBeVisible();
  await page.getByRole("button", { name: "All files", exact: true }).click();
  await added().click();
  await page.keyboard.press("Escape");
  await at(2, "addition");
  const largeSurface = page.locator(".code-surface").nth(1);
  await largeSurface.scrollIntoViewIfNeeded();
  await largeSurface.locator('[data-line="1"]').click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+V");
  for (let i = 0; i < 160; i++) await page.keyboard.press("j");
  await at(161, "addition");
  await expect(cursor()).toBeInViewport();
  await expect
    .poll(() => page.locator(".viewer-scroll").evaluate((e) => e.scrollTop))
    .toBeGreaterThan(1000);
  await page.keyboard.press("Escape");
  await page.keyboard.press("j");
  await at(162, "addition");
  await expect(selected()).toHaveCount(0);
  // Log j/k must consume the event before any mounted diff can steal focus.
  const sourceRow = page.getByRole("button", {
    name: `Review change ${source.changeId}`,
    exact: true,
  });
  const parentRow = page.getByRole("button", {
    name: `Review change ${parent.changeId}`,
    exact: true,
  });
  const revisionsBefore = mutations.filter(
    (route) => route === "revision",
  ).length;
  await sourceRow.focus();
  await page.keyboard.press("j");
  await expect(parentRow).toBeFocused();
  await expect
    .poll(() => mutations.filter((route) => route === "revision").length)
    .toBe(revisionsBefore + 1);
  await page.keyboard.press("j"); // At the boundary, don't fall through to the diff.
  await expect(parentRow).toBeFocused();
  await expect(largeSurface).not.toBeFocused();
  await page.keyboard.press("k");
  await expect(sourceRow).toBeFocused();
  await expect
    .poll(() => mutations.filter((route) => route === "revision").length)
    .toBe(revisionsBefore + 2);
  await largeSurface.focus();
  await page.keyboard.press("k");
  await at(161, "addition"); // Diff j/k still operates outside the log.

  // Disabling removes Vim behavior and restores the log shortcut.
  await settings.click();
  await vim.uncheck();
  await page.keyboard.press("Escape");
  await expect(cursor()).toHaveCount(0);
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Expand log sidebar" }),
  ).toBeVisible();
  assert.deepEqual(errors, []);
  console.log(
    "Vim mode checks passed: opt-in, persistence, cursor motions, visual ranges, squash, guards, split/stacked, all-files virtualization.",
  );
} finally {
  await fixture.close();
}
