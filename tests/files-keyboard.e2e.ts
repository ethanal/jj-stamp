// Run with: npx tsx tests/files-keyboard.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { DiffFile, RepoState } from "../src/types";

function file(path: string): DiffFile {
  return {
    path,
    additions: 1,
    deletions: 0,
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+new line\n`,
    hunks: [
      {
        id: path,
        header: "@@ -0,0 +1 @@",
        rows: [{ index: 1, raw: "+new line", newLine: 1 }],
      },
    ],
  };
}
let state: RepoState = {
  repo: { name: "files-keyboard", path: "/tmp/files-keyboard" },
  version: "v1",
  source: {
    changeId: "source",
    commitId: "a".repeat(40),
    description: "Review",
  },
  parent: null,
  targets: [],
  files: [
    file("src/alpha.txt"),
    file("src/beta.txt"),
    ...Array.from({ length: 80 }, (_, i) =>
      file(`zz/${String(i).padStart(3, "0")}.txt`),
    ),
  ],
  operation: "op1",
  canUndo: false,
};
const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => response.json(state));
app.get("/api/events", (_request, response) => response.sendStatus(204));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: state.version,
    rows: [{ graph: "@ ", revision: state.source, mutable: true }],
  }),
);
app.post("/api/commit", (_request, response) =>
  response.status(404).json({ error: "No cached preview" }),
);
const fixture = await createBrowserFixture({
  app,
  captureConsoleErrors: false,
});
const { page, url, errors } = fixture;
const sidebar = page.getByRole("complementary", { name: "Files sidebar" });
const body = page.locator("#files-sidebar-content");
const row = (path: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${path}"]`);
const collapse = sidebar.getByRole("button", {
  name: "Collapse files sidebar",
});
const expand = sidebar.getByRole("button", { name: "Expand files sidebar" });
const surface = page.locator(".code-surface");
try {
  await page.goto(url);
  await expect(surface.locator("[data-line]").first()).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).focus();
  await page.keyboard.press("f");
  await expect(body).toBeHidden();
  await page.keyboard.press("f");
  await expect(row("src/alpha.txt")).toBeFocused();
  await expect(surface).not.toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(row("src/beta.txt")).toBeFocused();
  await expect(page.locator(".file-bar-filename")).toHaveText("src/alpha.txt");
  await page.keyboard.press("Enter");
  await expect(page.locator(".file-bar-filename")).toHaveText("src/beta.txt");
  await page.keyboard.press("f");
  await expect(body).toBeHidden();
  await expect(expand).toBeFocused();
  await page.keyboard.press("f");
  await expect(row("src/beta.txt")).toBeFocused();

  // The Files shortcut must remain isolated from text fields and dialogs.
  await page.keyboard.press("Control+f");
  const search = page.getByRole("searchbox", { name: "Search diff" });
  await expect(search).toBeFocused();
  await page.keyboard.press("f");
  await expect(search).toHaveValue("f");
  await expect(body).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("f");
  await expect(body).toBeVisible();
  await page.getByRole("checkbox", { name: "Vim mode", exact: true }).check();
  await page
    .getByRole("checkbox", { name: "Reveal sidebars on hover" })
    .check();
  await page.keyboard.press("Escape");

  // Vim j/k belong to the tree while it has focus, not the diff's global handler.
  await surface
    .locator('[data-line][data-line-type="change-addition"]')
    .click();
  const selected = page.locator("[data-line][data-fold-selected]");
  await expect(selected).toHaveCount(1);
  await page.keyboard.press("f");
  await page.keyboard.press("f");
  await expect(row("src/beta.txt")).toBeFocused();
  await page.keyboard.press("k");
  await expect(row("src/alpha.txt")).toBeFocused();
  await page.keyboard.press("j");
  await expect(row("src/beta.txt")).toBeFocused();
  await row("src/beta.txt").dispatchEvent("keydown", {
    key: "k",
    repeat: true,
    composed: true,
  });
  await expect(row("src/alpha.txt")).toBeFocused();
  await expect(selected).toHaveCount(1);
  await expect(page.locator(".file-bar-filename")).toHaveText("src/beta.txt");

  // Held/modified f must not toggle the sidebar.
  for (const init of [
    { repeat: true },
    { altKey: true },
    { isComposing: true },
  ]) {
    await row("src/alpha.txt").dispatchEvent("keydown", {
      key: "f",
      bubbles: true,
      composed: true,
      ...init,
    });
    await expect(collapse).toBeVisible();
    await expect(row("src/alpha.txt")).toBeFocused();
  }

  // Focus requests reveal virtualized rows and reopen collapsed parent folders.
  await page.keyboard.press("End");
  await expect(row("zz/079.txt")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".file-bar-filename")).toHaveText("zz/079.txt");
  await page.keyboard.press("f");
  await page.keyboard.press("f");
  await expect(row("zz/079.txt")).toBeFocused();
  await expect(row("zz/079.txt")).toBeInViewport();
  await page.keyboard.press("ArrowLeft");
  const folder = page.getByRole("treeitem", { name: "zz", exact: true });
  await expect(folder).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("f");
  await page.keyboard.press("f");
  await expect(row("zz/079.txt")).toBeFocused();
  await expect(row("zz/079.txt")).toBeInViewport();

  // A hover preview must not replay an earlier f request and steal input focus.
  await page.locator(".viewer").hover();
  await page.keyboard.press("f");
  await page.keyboard.press("Control+f");
  await expect(search).toBeFocused();
  await sidebar.hover();
  await expect(sidebar).toHaveClass(/is-peeking/);
  await expect(search).toBeFocused();
  await page.locator(".viewer").hover();
  await page.keyboard.press("Escape");
  await expect(expand).toBeFocused();
  await page.keyboard.press("f");
  await expect(row("zz/079.txt")).toBeFocused();

  // With Files 0, focus the toggle rather than an enormous empty panel.
  state = { ...state, version: "v2", files: [] };
  await page.reload();
  await expect(page.locator(".empty")).toContainText(
    "No changes in this revision",
  );
  await page.keyboard.press("f");
  await expect(body).toBeHidden();
  await page.keyboard.press("f");
  await expect(collapse).toBeFocused();
  await expect(body).not.toHaveAttribute("tabindex");
  await body.evaluate((element) => (element as HTMLElement).focus());
  await expect(collapse).toBeFocused();
  await expect(body).not.toBeFocused();
  await expect(body).toHaveCSS("outline-style", "none");
  await expect(page.locator(".file-bar")).toHaveCSS("box-shadow", "none");
  await page.keyboard.press("f");
  await expect(expand).toBeFocused();
  await expect(body).toBeHidden();
  // Keyboard focus uses neutral theme colors, not the blue accent. Keep the
  // existing outline geometry; mouse clicks do not acquire a keyboard ring.
  for (const [scheme, color] of [
    ["dark", "rgb(139, 148, 158)"],
    ["dim", "rgb(160, 173, 186)"],
    ["light", "rgb(87, 101, 116)"],
    ["solarized-dark", "rgb(131, 148, 150)"],
    ["solarized-light", "rgb(101, 123, 131)"],
  ]) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByLabel("Color scheme").selectOption(scheme);
    await page.keyboard.press("Escape");
    for (const toggle of await page.locator(".sidebar-toggle").all()) {
      await toggle.focus();
      await expect(toggle).toHaveCSS("outline-style", "solid");
      await expect(toggle).toHaveCSS("outline-width", "2px");
      await expect(toggle).toHaveCSS("outline-color", color);
    }
    await page.keyboard.press("f");
    await expect(collapse).toBeFocused();
    await expect(collapse).toHaveCSS("outline-color", color);
    await expect(body).toHaveCSS("outline-style", "none");
    await page.keyboard.press("f");
  }
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expand.click();
  await expect(collapse).toBeFocused();
  await expect(collapse).toHaveCSS("outline-style", "none");
  await collapse.click();

  // Let the user's high-contrast palette supply the keyboard outline color.
  await page.emulateMedia({ forcedColors: "active" });
  await page.keyboard.press("Tab");
  await expand.focus();
  const systemHighlight = await page.evaluate(() => {
    const probe = document.createElement("span");
    probe.style.outline = "2px solid Highlight";
    document.body.append(probe);
    const color = getComputedStyle(probe).outlineColor;
    probe.remove();
    return color;
  });
  await expect(expand).toHaveCSS("outline-style", "solid");
  await expect(expand).toHaveCSS("outline-width", "2px");
  await expect(expand).toHaveCSS("outline-color", systemHighlight);
  await page.emulateMedia({ forcedColors: "none" });
  assert.deepEqual(errors, []);
  console.log(
    "Files keyboard checks passed: toggle/focus, tree navigation, Vim isolation, guards, virtualized/collapsed rows, and empty revisions.",
  );
} finally {
  await fixture.close();
}
