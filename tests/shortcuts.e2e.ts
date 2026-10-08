// Run with: npx tsx tests/shortcuts.e2e.ts (mock API; no jj executable needed)
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
const oldText = "first line\nold value\nlast line\n";
const newText = "first line\nnew value\nlast line\n";
const file: DiffFile = {
  path: "review.txt",
  additions: 1,
  deletions: 1,
  patch: [
    "diff --git a/review.txt b/review.txt",
    "--- a/review.txt",
    "+++ b/review.txt",
    "@@ -1,3 +1,3 @@",
    " first line",
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
        { index: 1, raw: " first line", oldLine: 1, newLine: 1 },
        { index: 2, raw: "-old value", oldLine: 2 },
        { index: 3, raw: "+new value", newLine: 2 },
        { index: 4, raw: " last line", oldLine: 3, newLine: 3 },
      ],
    },
  ],
};
const state: RepoState = {
  repo: { name: "shortcuts", path: "/tmp/shortcuts-fixture" },
  version: "shortcuts-v1",
  source,
  parent,
  targets: [parent],
  files: [file],
  operation: "shortcuts-op1",
  canUndo: true,
};
let stateReads = 0;
const mutations: string[] = [];
const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => {
  stateReads++;
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
    response.json({ state });
  });

const fixture = await createBrowserFixture({
  app,
  viewport: { width: 1280, height: 720 },
});
const { page, url, errors } = fixture;
const trigger = page.getByRole("button", { name: "shortcuts", exact: true });
const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
const close = dialog.getByRole("button", { name: "Close keyboard shortcuts" });
const content = dialog.getByRole("region", { name: "Shortcut reference" });
const settings = page.getByRole("button", { name: "settings", exact: true });
const settingsDialog = page.getByRole("dialog", {
  name: "Settings",
  exact: true,
});
const surface = page.locator(".code-surface").first();
const added = page.locator('[data-line-type="change-addition"]').first();
const selected = page.locator("[data-line][data-fold-selected]");
const refresh = page.getByRole("button", { name: "refresh r", exact: true });

try {
  await page.goto(url);
  await expect(added).toBeVisible();
  await expect(refresh).toBeEnabled();
  await expect(trigger).toBeVisible();
  await expect(dialog).not.toBeVisible();

  await trigger.click();
  await expect(dialog).toBeVisible();
  assert.equal(
    await dialog.evaluate((element) => element.matches(":modal")),
    true,
  );
  await expect(close).toBeFocused();
  assert.equal(
    await content.evaluate(
      (element) => element.scrollHeight <= element.clientHeight,
    ),
    true,
    "the complete shortcut reference fits a 1280×720 desktop viewport",
  );
  await page.screenshot({ path: "/tmp/jj-stamp-shortcuts-desktop.png" });
  for (const title of [
    "Review & navigation",
    "Find in diff",
    "Selection & code",
    "Resize panels",
  ])
    await expect(dialog.getByRole("heading", { name: title })).toBeVisible();
  for (const key of ["s", "u", "r", "f", "l", "@", "?", "e"])
    await expect(
      dialog.locator("kbd").getByText(key, { exact: true }),
    ).toHaveCount(1);
  await page.keyboard.press("Tab");
  await expect(content).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(content).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  await close.click();
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();

  // Keyboard opening restores the actual previous control, not always the
  // toolbar trigger. Escape must not clear CodeDiff's existing selection.
  await added.click();
  await expect(selected.first()).toBeVisible();
  await expect(surface).toBeFocused();
  const selectionBefore = await selected.count();
  await page.keyboard.press("Shift+Slash");
  await expect(dialog).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(surface).toBeFocused();
  await expect(selected).toHaveCount(selectionBefore);
  await page.keyboard.press("?");
  await expect(dialog).toBeVisible();
  await close.click();
  await expect(surface).toBeFocused();

  // Every dialog key is isolated from document-level listeners, not only
  // main.tsx's guarded shortcuts (CodeDiff and diff search also listen there).
  await page.keyboard.press("?");
  await expect(dialog).toBeVisible();
  await content.focus();
  await page.evaluate(() => {
    const events: string[] = [];
    Object.assign(window, { shortcutsBackgroundEvents: events });
    for (const type of ["keydown", "keyup"])
      document.addEventListener(type, (event) =>
        events.push(`${type}:${(event as KeyboardEvent).key}`),
      );
  });
  const readsBefore = stateReads;
  for (const key of [
    "s",
    "u",
    "r",
    "f",
    "l",
    "Shift+Digit2",
    "ArrowDown",
    "?",
    "Control+f",
    "Meta+f",
    "F3",
    "Shift+F3",
    "Enter",
    "Shift+Enter",
    "e",
    "Alt",
    "Control+c",
  ]) {
    await page.keyboard.press(key);
    await expect(dialog).toBeVisible();
  }
  assert.deepEqual(
    await page.evaluate(() => Reflect.get(window, "shortcutsBackgroundEvents")),
    [],
    "dialog keydown and keyup never reach background listeners",
  );
  assert.deepEqual(mutations, []);
  assert.equal(stateReads, readsBefore, "r must not refresh behind the dialog");
  await expect(
    page.getByRole("searchbox", { name: "Search diff" }),
  ).toHaveCount(0);
  await expect(page.locator("#log-sidebar-content")).not.toHaveAttribute(
    "hidden",
  );
  await expect(selected).toHaveCount(selectionBefore);
  await page.keyboard.press("Escape");
  await expect(surface).toBeFocused();
  await expect(selected).toHaveCount(selectionBefore);

  // Opening over an existing search does not close it or advance its cursor.
  await page.keyboard.press("Control+f");
  const search = page.getByRole("searchbox", { name: "Search diff" });
  await expect(search).toBeFocused();
  await search.fill("line");
  await expect(page.locator(".diff-search-count")).toHaveText("1 / 2");
  await trigger.click();
  await content.focus();
  await page.keyboard.press("F3");
  await page.keyboard.press("Shift+F3");
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(search).toBeVisible();
  await expect(page.locator(".diff-search-count")).toHaveText("1 / 2");
  await search.focus();
  await search.fill("");
  await page.keyboard.press("?");
  await expect(search).toHaveValue("?");
  await expect(dialog).not.toBeVisible();
  await page.keyboard.press("Escape");

  // Guards include canceled, repeated, composing, and modified shortcuts.
  await surface.focus();
  for (const init of [
    { repeat: true },
    { isComposing: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { prevented: true },
  ]) {
    await surface.evaluate((element, init) => {
      const event = new KeyboardEvent("keydown", {
        key: "?",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if ("prevented" in init) event.preventDefault();
      element.dispatchEvent(event);
    }, init);
    await expect(dialog).not.toBeVisible();
  }
  // Exercise native and inherited editable controls without needing a form in
  // the application. The nested span also catches empty contenteditable="".
  for (const html of [
    '<input aria-label="Typing guard">',
    '<textarea aria-label="Typing guard"></textarea>',
    '<select aria-label="Typing guard"><option>One</option></select>',
    '<div contenteditable="true"><span tabindex="0" aria-label="Typing guard">text</span></div>',
    '<div contenteditable=""><span tabindex="0" aria-label="Typing guard">text</span></div>',
    '<div contenteditable="plaintext-only" tabindex="0" aria-label="Typing guard">text</div>',
  ]) {
    await page.evaluate((html) => {
      const host = document.createElement("div");
      host.id = "typing-guard-fixture";
      host.innerHTML = html;
      document.body.append(host);
      host.querySelector<HTMLElement>('[aria-label="Typing guard"]')!.focus();
    }, html);
    await page.keyboard.press("?");
    await expect(dialog).not.toBeVisible();
    await page.evaluate(() =>
      document.querySelector("#typing-guard-fixture")!.remove(),
    );
  }

  await settings.click();
  await expect(settingsDialog).toBeVisible();
  await page.keyboard.press("?");
  await expect(dialog).not.toBeVisible();
  await expect(settingsDialog).toBeVisible();
  await page.getByLabel("Color scheme").focus();
  await page.keyboard.press("?");
  await expect(dialog).not.toBeVisible();
  await page.keyboard.press("Escape");
  await expect(settings).toBeFocused();

  // While a code-selection drag is active both ways of opening are disabled.
  const lineBox = await added.boundingBox();
  assert(lineBox);
  await page.mouse.move(lineBox.x + 30, lineBox.y + lineBox.height / 2);
  await page.mouse.down();
  await expect(trigger).toBeDisabled();
  await page.keyboard.press("?");
  await expect(dialog).not.toBeVisible();
  await page.mouse.up();
  await expect(trigger).toBeEnabled();
  await page.keyboard.press("?");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(surface).toBeFocused();

  // Inherit each actual theme and constrain the dialog at narrow/short sizes.
  for (const scheme of [
    "dark",
    "light",
    "dim",
    "solarized-dark",
    "solarized-light",
  ]) {
    await settings.click();
    await page.getByLabel("Color scheme").selectOption(scheme);
    const expectedColors = await settingsDialog.evaluate((element) => {
      const style = getComputedStyle(element);
      return { background: style.backgroundColor, foreground: style.color };
    });
    await page.keyboard.press("Escape");
    await trigger.click();
    await expect(dialog).toHaveCSS(
      "background-color",
      expectedColors.background,
    );
    await expect(dialog).toHaveCSS("color", expectedColors.foreground);
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 360, height: 480 });
  await trigger.click();
  await expect(close).toBeFocused();
  const box = await dialog.boundingBox();
  assert(
    box &&
      box.x >= 0 &&
      box.y >= 0 &&
      box.x + box.width <= 360 &&
      box.y + box.height <= 480,
  );
  assert.equal(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
    true,
  );
  assert.equal(
    await content.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
    true,
  );
  await content.focus();
  await page.keyboard.press("End");
  await expect
    .poll(() => content.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(close).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(content).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(trigger).toBeFocused();
  assert.deepEqual(errors, []);
  console.log(
    "Shortcut dialog checks passed: native modal, focus, keyboard guards, isolated background, drag guard, themes, responsive scrolling.",
  );
} finally {
  await fixture.close();
}
