// Run with: npx tsx tests/revision-keyboard.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { RepoState } from "../src/types";

const revisions = ["top", "middle", "bottom", "working-copy"].map(
  (name, index) => ({
    changeId: name,
    commitId: String(index + 1).repeat(40),
    description: name,
  }),
);
let state: RepoState = {
  repo: { name: "keyboard", path: "/tmp/keyboard" },
  version: "v0",
  source: revisions[1],
  parent: null,
  targets: [],
  files: [],
  operation: "op0",
  canUndo: false,
};
const requests: { version: string; changeId: string }[] = [];
let release: (() => void) | undefined;
let holdNext = false;
let failNext = false;
const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => response.json(state));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: state.version,
    // Deliberately omit @, and include connector rows to skip.
    rows: revisions
      .slice(0, 3)
      .flatMap((revision) => [
        { graph: "○ ", revision, mutable: true },
        { graph: "│" },
      ]),
  }),
);
app.post("/api/revision", async (request, response) => {
  requests.push(request.body);
  if (holdNext) {
    holdNext = false;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  }
  if (failNext) {
    failNext = false;
    response
      .status(409)
      .json({ error: "Selection is stale", code: "STALE_STATE" });
    return;
  }
  assert.equal(request.body.version, state.version);
  const source =
    request.body.changeId === "@"
      ? revisions[3]
      : revisions.find(
          (revision) => revision.changeId === request.body.changeId,
        )!;
  assert(source);
  state = { ...state, source, version: `v${requests.length}` };
  response.json({ state });
});
// Cached previews are optional; this fixture exercises live selections.
app.post("/api/commit", (_request, response) =>
  response.status(404).json({ error: "No cached preview" }),
);

const fixture = await createBrowserFixture({ app });
const { page, url, errors } = fixture;
const row = (name: string) =>
  page.getByRole("button", { name: `Review change ${name}`, exact: true });
const reviewed = page.getByLabel("Reviewed revision");
async function selected(name: string) {
  await expect(reviewed).toContainText(name);
  await expect(page.locator(".statusbar")).not.toContainText(
    "switching change",
  );
}
try {
  await page.goto(url);
  await selected("middle");
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();
  await page.keyboard.press("l");
  await expect(row("middle")).toBeFocused();
  await expect(row("middle")).toHaveCSS("outline-style", "none");
  await expect(row("middle").locator("..")).not.toHaveCSS("box-shadow", "none");
  await page.keyboard.press("ArrowUp");
  await selected("top");
  await expect(row("top")).toBeFocused();
  const atTop = requests.length;
  await page.keyboard.press("ArrowUp");
  assert.equal(requests.length, atTop, "Do not reselect or wrap at the top");
  await page.keyboard.press("ArrowDown");
  await selected("middle");
  await page.keyboard.press("ArrowDown");
  await selected("bottom");
  await expect(row("bottom")).toBeFocused();
  const atBottom = requests.length;
  await page.keyboard.press("ArrowDown");
  assert.equal(
    requests.length,
    atBottom,
    "Do not reselect or wrap at the bottom",
  );

  // @ uses the real working-copy selector even when absent from the log.
  await page.keyboard.press("Shift+Digit2");
  await selected("working-copy");
  assert.equal(requests.at(-1)?.changeId, "@");
  await expect(page.getByLabel("jj log output")).toBeFocused();
  await expect(page.getByLabel("jj log output")).toHaveCSS(
    "outline-style",
    "none",
  );
  await page.keyboard.press("ArrowDown");
  await selected("top");
  await expect(row("top")).toBeFocused();

  // Held arrow keys repeat, unlike mutation shortcuts.
  await row("top").dispatchEvent("keydown", { key: "ArrowDown", repeat: true });
  await selected("middle");
  await row("middle").dispatchEvent("keydown", {
    key: "ArrowUp",
    repeat: true,
  });
  await selected("top");

  // Rapid key presses track the focused intent, not the last response.
  holdNext = true;
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => release !== undefined).toBe(true);
  await expect(page.locator(".log-status")).toHaveText("loading…");
  await expect(page.locator(".log-loading-spinner")).toBeVisible();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".log-loading-spinner")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.keyboard.press("ArrowDown");
  await expect(row("bottom")).toBeFocused();
  await expect(row("bottom")).toHaveCSS("outline-style", "none");
  await expect(row("bottom").locator("..")).not.toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(page.locator(".log-status")).toHaveText("loading…");
  release!();
  release = undefined;
  await selected("bottom");
  await expect(page.locator(".log-loading")).toHaveCount(0);
  assert.deepEqual(
    requests.slice(-2).map(({ changeId }) => changeId),
    ["middle", "bottom"],
  );

  // A pending navigation can be superseded by @ using the acknowledged version.
  holdNext = true;
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => release !== undefined).toBe(true);
  await page.keyboard.press("Shift+Digit2");
  release!();
  release = undefined;
  await selected("working-copy");
  assert.equal(requests.at(-1)?.changeId, "@");

  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Expand log sidebar" }),
  ).toBeFocused();
  const beforeIgnored = requests.length;
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Control+Shift+Digit2");
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page.keyboard.press("Shift+Digit2");
  await page.keyboard.press("l");
  await expect(page.getByRole("dialog")).toBeVisible();
  assert.equal(requests.length, beforeIgnored);
  await page.keyboard.press("Escape");
  // Text entry must not trigger either global shortcut.
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.id = "shortcut-input";
    document.body.append(input);
    input.focus();
  });
  await page.keyboard.type("@l");
  await expect(page.locator("#shortcut-input")).toHaveValue("@l");
  assert.equal(requests.length, beforeIgnored);
  await page.locator("#shortcut-input").evaluate((input) => input.remove());

  // Errors leave the confirmed selection intact and do not retry the shortcut.
  failNext = true;
  await page.keyboard.press("Shift+Digit2");
  await expect(page.locator(".error")).toContainText("Selection is stale");
  await expect(page.locator(".log-loading")).toHaveCount(0);
  await selected("working-copy");
  assert.equal(requests.length, beforeIgnored + 1);
  await page.keyboard.press("Escape");

  // Vim log motions share the arrow path, including repeats, bounds and intent
  // coalescing. They are opt-in and only operate while the log has focus.
  const settings = page.getByRole("button", { name: "settings", exact: true });
  const graph = page.getByLabel("jj log output");
  await settings.click();
  await page.getByRole("checkbox", { name: "Vim mode" }).check();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Expand log sidebar" }).click();
  await graph.focus();
  await page.keyboard.press("j");
  await selected("top");
  await expect(row("top")).toBeFocused();
  const vimAtTop = requests.length;
  await page.keyboard.press("k");
  assert.equal(requests.length, vimAtTop);
  await page.keyboard.press("j");
  await selected("middle");
  await page.keyboard.press("j");
  await selected("bottom");
  await expect(row("bottom")).toBeFocused();
  const vimAtBottom = requests.length;
  await page.keyboard.press("j");
  assert.equal(requests.length, vimAtBottom);
  await row("bottom").dispatchEvent("keydown", { key: "k", repeat: true });
  await selected("middle");
  await expect(row("middle")).toBeFocused();

  const beforeVimGuards = requests.length;
  for (const init of [
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
    { shiftKey: true },
    { isComposing: true },
    { prevented: true },
  ]) {
    await row("middle").evaluate((element, init) => {
      const event = new KeyboardEvent("keydown", {
        key: "j",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if ("prevented" in init) event.preventDefault();
      element.dispatchEvent(event);
    }, init);
  }
  await settings.click();
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  await page.keyboard.press("Escape");
  // Even an editable descendant of the graph keeps its normal typing behavior.
  await graph.evaluate((element) => {
    const input = document.createElement("input");
    input.id = "vim-log-input";
    element.append(input);
    input.focus();
  });
  await page.keyboard.type("jk");
  await expect(page.locator("#vim-log-input")).toHaveValue("jk");
  await page.locator("#vim-log-input").evaluate((input) => input.remove());
  assert.equal(requests.length, beforeVimGuards);

  await row("middle").focus();
  holdNext = true;
  await page.keyboard.press("j");
  await expect.poll(() => release !== undefined).toBe(true);
  await expect(row("bottom")).toBeFocused();
  await page.keyboard.press("k");
  await page.keyboard.press("k");
  await expect(row("top")).toBeFocused();
  release!();
  release = undefined;
  await selected("top");
  assert.deepEqual(
    requests.slice(-2).map(({ changeId }) => changeId),
    ["bottom", "top"],
  );

  await settings.click();
  await page.getByRole("checkbox", { name: "Vim mode" }).uncheck();
  await page.keyboard.press("Escape");
  await row("top").focus();
  const vimDisabled = requests.length;
  await page.keyboard.press("j");
  await page.keyboard.press("k");
  assert.equal(requests.length, vimDisabled);
  await expect(row("top")).toBeFocused();
  assert.deepEqual(errors, []);
  console.log(
    "Revision keyboard checks passed: @, log focus/arrows/Vim motions/bounds, rapid intents, hidden graph, input/modifier guards, and errors.",
  );
} finally {
  release?.();
  await fixture.close();
}
