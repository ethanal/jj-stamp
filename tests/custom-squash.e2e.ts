// Run with: npx tsx tests/custom-squash.e2e.ts (real browser, API, and disposable jj repository).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";

// The reviewed source is deliberately NOT @. Its real immediate parent is
// initially absent from the graph; the older destination remains mutable.
const dataDir = await mkdtemp(path.join(tmpdir(), "custom-squash-browser-"));
const repoPath = path.join(dataDir, "repo");
await jj(dataDir, ["git", "init", "--no-colocate", repoPath]);
for (const [key, value] of [
  ["user.name", "Destination Test"],
  ["user.email", "destination@example.test"],
  ['revset-aliases."immutable_heads()"', "root()"],
])
  await jj(repoPath, ["config", "set", "--repo", key, value]);
const id = async (rev: string) =>
  (
    await jj(repoPath, ["log", "--no-graph", "-r", rev, "-T", "change_id"])
  ).stdout.trim();
const baseLines = Array.from(
  { length: 22 },
  (_, i) => `unchanged line ${i + 1}`,
);
const baseText = baseLines.join("\n") + "\n";
await writeFile(path.join(repoPath, "review.txt"), baseText);
await jj(repoPath, ["commit", "-m", "Immutable base"]);
const immutable = await id("@-");
await jj(repoPath, ["bookmark", "create", "immutable-base", "-r", immutable]);
await jj(repoPath, [
  "config",
  "set",
  "--repo",
  'revset-aliases."immutable_heads()"',
  "immutable-base",
]);
await writeFile(path.join(repoPath, "older.txt"), "older destination\n");
await jj(repoPath, ["commit", "-m", "Older mutable destination"]);
const older = await id("@-");
await writeFile(path.join(repoPath, "parent.txt"), "actual immediate parent\n");
await jj(repoPath, ["commit", "-m", "Actual immediate parent"]);
const parent = await id("@-");
const sourceLines = [...baseLines];
sourceLines.splice(2, 0, "SELECTED moves to older destination");
sourceLines.splice(17, 0, "UNSELECTED remains in reviewed source");
const sourceText = sourceLines.join("\n") + "\n";
await writeFile(path.join(repoPath, "review.txt"), sourceText);
await jj(repoPath, ["commit", "-m", "Reviewed source away from working copy"]);
const source = await id("@-");
await writeFile(path.join(repoPath, "working.txt"), "unrelated working copy\n");
await jj(repoPath, ["describe", "-m", "Working copy elsewhere"]);
const workingCopy = await id("@");
const service = new ReviewService({ repoPath, revision: source });
const initial = await service.getState();
assert.equal(initial.source.changeId, source);
assert.equal(initial.parent?.changeId, parent);
assert(initial.targets.some((target) => target.changeId === older));
assert(!initial.targets.some((target) => target.changeId === immutable));
const api = createApi(service);
const app = express();
app.use("/api", api);
const fixture = await createBrowserFixture({
  app,
  config: {
    "log-revset": `${source} | ${older} | ${immutable} | @`,
    "diff-style": "unified",
    "hover-sidebars": false,
  },
  captureConsoleErrors: true,
});
const { page, url, errors } = fixture;
const revisions: unknown[] = [];
const squashes: { version: string; target?: string; selections: unknown[] }[] =
  [];
page.on("request", (request) => {
  if (request.method() !== "POST") return;
  if (request.url().endsWith("/api/revision"))
    revisions.push(request.postDataJSON());
  if (request.url().endsWith("/api/squash-lines"))
    squashes.push(request.postDataJSON());
});
await page.addInitScript(() => {
  document.hasFocus = () => false;
});
const destination = page.locator(".squash-destination");
const trigger = page.getByRole("button", {
  name: /^Squash into/,
});
const menu = page.getByRole("menu", { name: "Squash destination" });
const parentOption = () => menu.getByRole("menuitemradio", { name: /^Parent/ });
const customOption = () => menu.getByRole("menuitemradio", { name: /^Custom/ });
const chooseAction = () =>
  menu.getByRole("menuitem", { name: "Choose revision in log…", exact: true });
const graph = page.getByLabel("jj log output");
const row = (changeId: string) =>
  page.locator(`.log-change[data-change-id="${changeId}"]`);
const squash = page.getByRole("button", { name: "Squash", exact: true });
const addition = (line: number) =>
  page.locator(`[data-line="${line}"][data-line-type="change-addition"]`);
const selected = () => page.locator("[data-line][data-fold-selected]");
const reviewedId = () => page.getByLabel("Current change ID", { exact: true });
const fileText = async (rev: string) =>
  (await jj(repoPath, ["file", "show", "review.txt", "-r", rev])).stdout;
async function screenshot(name: string) {
  await mkdir(".planka-artifacts", { recursive: true });
  await page.screenshot({
    path: `.planka-artifacts/custom-squash-production-${name}.png`,
    fullPage: true,
  });
}
async function openMenu() {
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.locator('[role^="menuitem"]')).toHaveCount(2);
  await expect(customOption()).toHaveCount(0);
  await expect(parentOption()).toHaveAccessibleName(
    `Parent · ${parent.slice(0, 8)}`,
  );
  await expect(
    parentOption().locator(".squash-destination-icon svg"),
  ).toHaveAttribute("aria-hidden", "true");
  assert.equal(
    await parentOption().locator(".squash-destination-icon svg").innerHTML(),
    await page
      .getByRole("button", { name: "Squash file review.txt", exact: true })
      .locator("svg")
      .innerHTML(),
    "Parent uses the same down-arrow-into-circle icon as file squash",
  );
  await expect(
    parentOption().locator(".squash-destination-check svg"),
  ).toHaveCount(
    (await parentOption().getAttribute("aria-checked")) === "true" ? 1 : 0,
  );
  // All menu icons share the parent's stroke and canvas, not font glyph metrics.
  for (const icon of await menu.locator("svg").all()) {
    await expect(icon).toHaveAttribute("aria-hidden", "true");
    await expect(icon).toHaveAttribute("viewBox", "0 0 16 16");
    await expect(icon).toHaveAttribute("stroke-width", "1.5");
    await expect(icon).toHaveAttribute("stroke-linecap", "round");
    await expect(icon).toHaveAttribute("stroke-linejoin", "round");
    await expect(icon).toHaveAttribute("fill", "none");
    const bounds = await icon.boundingBox();
    assert(bounds && bounds.width === 16 && bounds.height === 16);
  }
  await expect(chooseAction().locator("svg")).toHaveCount(1);
  const alignment = await trigger.evaluate((button) => {
    const caret = button.querySelector("svg")!;
    const box = caret.getBoundingClientRect();
    const path = caret.querySelector("path")!.getBoundingClientRect();
    const trigger = button.getBoundingClientRect();
    return {
      vertical: box.y + box.height / 2 - (trigger.y + trigger.height / 2),
      inkX: path.x + path.width / 2 - (box.x + box.width / 2),
      inkY: path.y + path.height / 2 - (box.y + box.height / 2),
      width: box.width,
      height: box.height,
    };
  });
  assert(Math.abs(alignment.vertical) < 0.5, "Caret is vertically centered");
  assert(
    Math.abs(alignment.inkX) < 0.5,
    "Chevron ink is centered horizontally",
  );
  assert(Math.abs(alignment.inkY) < 0.5, "Chevron ink is centered vertically");
  assert.equal(alignment.width, 14, "Caret must not shrink on narrow screens");
  assert.equal(alignment.height, 14);
  await expect(chooseAction()).toHaveAccessibleName("Choose revision in log…");
  const copy = await menu.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    clone
      .querySelectorAll('[aria-hidden="true"]')
      .forEach((node) => node.remove());
    return clone.textContent?.replace(/\s+/g, " ").trim();
  });
  assert.equal(
    copy?.replace(/\s/g, ""),
    `Parent·${parent.slice(0, 8)}Chooserevisioninlog…`,
  );
  assert.equal(
    await menu.locator("input, textarea").count(),
    0,
    "Destination is never free-form text entry",
  );
}
async function assertPickerHelp() {
  const help = page.locator(".destination-pick-help");
  await expect(help.locator(":scope > span").first()).toHaveText(
    "Choose a revision",
  );
  const cancel = help.getByRole("button", { name: "Cancel", exact: true });
  const bounds = await cancel.boundingBox();
  assert(
    bounds && bounds.width >= 64 && bounds.height === 28,
    "Cancel keeps a wide target at a normal 28px height",
  );
}
async function chooseInLog() {
  await openMenu();
  await chooseAction().click();
  await expect(menu).toBeHidden();
  await expect(graph).toBeVisible();
  await expect(squash).toBeDisabled();
  await expect(page.getByRole("status")).toContainText("Preview destination:");
  await assertPickerHelp();
}
async function assertSourceAndSelection(selectionCount: number) {
  await expect(reviewedId()).toHaveAttribute("title", source);
  await expect(selected()).toHaveCount(selectionCount);
  assert.equal(
    revisions.length,
    0,
    "Destination previews must not POST /api/revision",
  );
  assert.equal(squashes.length, 0, "Choosing never squashes");
}
async function applyFilter(revset: string) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByLabel("jj log revset", { exact: true }).fill(revset);
  const save = settings
    .locator(".log-revset-settings")
    .getByRole("button", { name: "Save", exact: true });
  await save.click();
  await expect(save).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(settings).toBeHidden();
}
let releaseSquash: (() => void) | undefined;
try {
  // Allow cold Vite startup; readiness is asserted by the visible diff below.
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(addition(3)).toBeVisible({ timeout: 30_000 });
  await expect(reviewedId()).toHaveAttribute("title", source);
  await expect(row(workingCopy)).toBeVisible();
  await expect(row(parent)).toHaveCount(0);
  await expect(destination).toBeVisible();
  await expect(destination.locator(".squash-destination-label")).toHaveCount(0);
  await expect(destination).not.toContainText("Squash into →");
  await expect(trigger).toHaveText("Squash into parent");
  await expect(trigger).toHaveAccessibleName("Squash into parent");
  await expect(trigger).toHaveAttribute(
    "title",
    `Parent: ${parent}\nActual immediate parent`,
  );
  await addition(3).click();
  const selectionCount = await selected().count();
  assert(selectionCount > 0);
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();
  await expect(graph).toBeHidden();
  await expect(trigger).toBeVisible();
  await expect
    .poll(async () => (await fixture.readConfig())["log-expanded"])
    .toBe(false);
  const hiddenLogConfig = await fixture.readConfig();
  await screenshot("parent-hidden-log");

  // Keyboard menu behavior and Escape ownership: a menu dismisses first.
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(menu).toBeVisible();
  await expect(parentOption()).toHaveAttribute("aria-checked", "true");
  await expect(customOption()).toHaveCount(0);
  await screenshot("parent-menu");
  await page.keyboard.press("ArrowDown");
  await expect(chooseAction()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(parentOption()).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(graph).toBeHidden();
  await assertSourceAndSelection(selectionCount);

  // Starting a picker temporarily opens a hidden graph. Hover and arrow keys
  // are destination previews, never live revision navigation or squash.
  await chooseInLog();
  await expect(row(older)).toBeVisible();
  await row(older).hover();
  await expect(trigger).toHaveText(`Squash into ${older.slice(0, 8)}`);
  assert.deepEqual(
    await fixture.readConfig(),
    hiddenLogConfig,
    "Temporarily revealing the picker must not persist shared preferences",
  );
  await expect(page.locator(".destination-arrow.is-preview")).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    `Preview destination: ${older.slice(0, 8)}`,
  );
  // Neither the mutation shortcut nor clicking the underlying source diff may
  // change the review/selection while destination choosing owns interaction.
  await page.keyboard.press("s");
  await addition(18).click();
  await assertSourceAndSelection(selectionCount);
  await row(older).focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowUp");
  await assertSourceAndSelection(selectionCount);
  await screenshot("choosing-preview");
  await openMenu();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.locator(".destination-pick-help")).toBeVisible();
  await expect(squash).toBeDisabled();
  await expect(graph).toBeVisible();
  await assertSourceAndSelection(selectionCount);
  await page.keyboard.press("Escape");
  await expect(graph).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAccessibleName("Squash into parent");
  await assertSourceAndSelection(selectionCount);
  assert.deepEqual(await fixture.readConfig(), hiddenLogConfig);

  // Source, immutable ancestors, and @ descendants cannot become destinations.
  await chooseInLog();
  for (const invalid of [source, immutable, workingCopy]) {
    await expect(row(invalid)).toBeDisabled();
    await row(invalid).dispatchEvent("click");
    await expect(graph).toBeVisible();
    await expect(squash).toBeDisabled();
    await assertSourceAndSelection(selectionCount);
  }
  await row(older).click();
  await expect(graph).toBeHidden();
  await expect(trigger).toHaveAccessibleName(
    `Squash into ${older.slice(0, 8)}`,
  );
  await expect(trigger).toHaveText(`Squash into ${older.slice(0, 8)}`);
  await expect(trigger).toBeFocused();
  await expect(squash).toBeEnabled();
  await assertSourceAndSelection(selectionCount);
  await expect(
    page.getByRole("button", { name: "Squash file review.txt", exact: true }),
  ).toHaveAttribute(
    "title",
    "Squash all changes in this file into the selected destination",
  );
  assert.deepEqual(
    await fixture.readConfig(),
    hiddenLogConfig,
    "Choosing a destination must not persist the target or temporary layout",
  );
  await screenshot("custom-hidden-log");

  // There is no remembered Custom option: Parent discards the custom target.
  // A custom destination must be explicitly chosen from the graph again.
  await openMenu();
  await expect(parentOption()).toHaveAttribute("aria-checked", "false");
  await screenshot("custom-menu");
  await parentOption().click();
  await expect(trigger).toHaveAccessibleName("Squash into parent");
  await expect(trigger).toHaveAttribute(
    "title",
    `Parent: ${parent}\nActual immediate parent`,
  );
  await expect(destination).not.toContainText(older.slice(0, 8));
  await openMenu();
  await expect(parentOption()).toHaveAttribute("aria-checked", "true");
  await expect(customOption()).toHaveCount(0);
  await expect(menu).not.toContainText(older.slice(0, 8));
  await chooseAction().click();
  await assertPickerHelp();
  await row(older).click();
  await expect(graph).toBeHidden();
  await expect(trigger).toHaveAccessibleName(
    `Squash into ${older.slice(0, 8)}`,
  );
  await expect(trigger).toHaveText(`Squash into ${older.slice(0, 8)}`);
  await assertSourceAndSelection(selectionCount);

  // Canceling a replacement restores Custom, not Parent, and an explicitly
  // open graph remains open on both cancellation and Enter confirmation.
  await applyFilter(`${source} | ${parent} | ${older} | ${immutable} | @`);
  await assertSourceAndSelection(selectionCount);
  await page.getByRole("button", { name: "Expand log sidebar" }).click();
  // Open via the keyboard menu and preview two distinct eligible ancestors.
  await trigger.focus();
  await page.keyboard.press("ArrowUp");
  await expect(chooseAction()).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".destination-pick-help")).toBeVisible();
  await assertPickerHelp();
  await row(older).focus();
  await page.keyboard.press("ArrowUp");
  await expect(row(parent)).toBeFocused();
  await expect(trigger).toHaveAccessibleName(
    `Squash into ${parent.slice(0, 8)}`,
  );
  await expect(page.getByRole("status")).toContainText(
    `Preview destination: ${parent.slice(0, 8)}`,
  );
  await page.keyboard.press("ArrowDown");
  await expect(row(older)).toBeFocused();
  await expect(trigger).toHaveText(`Squash into ${older.slice(0, 8)}`);
  await assertSourceAndSelection(selectionCount);
  await page.keyboard.press("Escape");
  await expect(graph).toBeVisible();
  await expect(trigger).toHaveAccessibleName(
    `Squash into ${older.slice(0, 8)}`,
  );
  await expect(trigger).toBeFocused();
  await assertSourceAndSelection(selectionCount);
  await chooseInLog();
  await row(parent).hover();
  await page
    .locator(".destination-pick-help")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(graph).toBeVisible();
  await expect(trigger).toHaveAccessibleName(
    `Squash into ${older.slice(0, 8)}`,
  );
  await expect(trigger).toHaveText(`Squash into ${older.slice(0, 8)}`);
  await expect(trigger).toBeFocused();
  await assertSourceAndSelection(selectionCount);
  await chooseInLog();
  await row(older).focus();
  await page.keyboard.press("Enter");
  await expect(graph).toBeVisible();
  await expect(squash).toBeEnabled();
  await expect(
    page.locator(".destination-arrow:not(.is-preview)"),
  ).toBeVisible();
  await assertSourceAndSelection(selectionCount);

  // A filtered-out target stays authorized by state.targets, not graph rows.
  await applyFilter(`${source} | @`);
  await expect(row(older)).toHaveCount(0);
  await expect(trigger).toHaveText(`Squash into ${older.slice(0, 8)}`);
  await expect(squash).toBeEnabled();
  await expect(selected()).toHaveCount(selectionCount);
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();

  // Hold the actual API request to inspect queue locking and wire identity.
  // This is a browser-side transport gate, not a mocked response/backend.
  let held = false;
  await page.route("**/api/squash-lines", async (route) => {
    held = true;
    await new Promise<void>((resolve) => {
      releaseSquash = resolve;
    });
    await route.continue();
  });
  const responsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/squash-lines"),
  );
  await squash.click();
  await expect.poll(() => held).toBe(true);
  await expect(trigger).toBeDisabled();
  await expect(menu).toBeHidden();
  assert.equal(squashes.length, 1);
  assert.equal(
    squashes[0].target,
    older,
    "Queue sends the full selected change ID",
  );
  assert.equal(squashes[0].version, initial.version);
  await screenshot("queued-locked");
  releaseSquash!();
  releaseSquash = undefined;
  const response = await responsePromise;
  assert.equal(response.status(), 200, await response.text());
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(trigger).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(reviewedId()).toHaveAttribute("title", source);
  assert.equal(revisions.length, 0);
  const olderText = await fileText(older);
  assert(olderText.includes("SELECTED moves to older destination"));
  assert(!olderText.includes("UNSELECTED remains in reviewed source"));
  assert.equal(await fileText(source), sourceText);
  const sourceDiff = (await jj(repoPath, ["diff", "-r", source, "--git"]))
    .stdout;
  assert(sourceDiff.includes("+UNSELECTED remains in reviewed source"));
  assert(!sourceDiff.includes("+SELECTED moves to older destination"));
  assert.equal(await fileText(immutable), baseText);
  assert.equal(await id("@"), workingCopy);
  await screenshot("squashed");

  // Real operation undo restores both the source and destination trees.
  const undoResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/undo"),
  );
  await page.getByRole("button", { name: /^Undo/ }).click();
  const undone = await undoResponse;
  assert.equal(undone.status(), 200, await undone.text());
  await expect(addition(3)).toBeVisible();
  assert.equal(await fileText(older), baseText);
  assert.equal(await fileText(source), sourceText);
  const restoredDiff = (await jj(repoPath, ["diff", "-r", source, "--git"]))
    .stdout;
  assert(restoredDiff.includes("+SELECTED moves to older destination"));
  assert(restoredDiff.includes("+UNSELECTED remains in reviewed source"));
  assert.equal(revisions.length, 0);
  for (const width of [1200, 1000, 800, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(trigger).toBeVisible();
    if (width <= 850)
      await expect(page.getByLabel("Current commit ID")).toBeVisible();
    await openMenu();
    const bounds = await menu.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width);
    await screenshot(`menu-${width}px`);
    const geometry = await page.locator(".topbar").evaluate((bar) => ({
      viewport: window.innerWidth,
      width: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
    }));
    console.log("Custom destination topbar geometry", geometry);
    assert(
      geometry.scrollWidth <= geometry.width,
      `Topbar overflows at ${width}px`,
    );
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  async function setFontSize(size: number) {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const slider = settings.getByRole("slider", {
      name: "Font size",
      exact: true,
    });
    await slider.focus();
    await slider.press(size === 24 ? "End" : "Home");
    if (size !== 24)
      for (let i = 10; i < size; i++) await slider.press("ArrowRight");
    await expect(slider).toHaveValue(String(size));
    await expect
      .poll(async () => (await fixture.readConfig())["font-size"])
      .toBe(size);
    await settings
      .getByRole("button", { name: "Close settings", exact: true })
      .click();
  }
  await setFontSize(24);
  const responsiveFailures: string[] = [];
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(trigger).toBeVisible();
    await openMenu();
    await screenshot(`menu-${width}px-font24`);
    const geometry = await page.locator(".topbar").evaluate((bar) => ({
      viewport: window.innerWidth,
      width: bar.clientWidth,
      scrollWidth: bar.scrollWidth,
    }));
    console.log("Custom destination largest-font topbar geometry", geometry);
    if (geometry.scrollWidth > geometry.width)
      console.log(
        "Overflowing topbar children",
        await page.locator(".topbar").evaluate((bar) =>
          Array.from(bar.children).map((child) => ({
            className: child.className,
            x: child.getBoundingClientRect().x,
            width: child.getBoundingClientRect().width,
            scrollWidth: child.scrollWidth,
          })),
        ),
      );
    if (geometry.scrollWidth > geometry.width)
      responsiveFailures.push(
        `Topbar overflows at ${width}px/font24: ${geometry.scrollWidth}px`,
      );
    for (const element of [destination, trigger, menu]) {
      const bounds = await element.boundingBox();
      console.log(`Largest-font ${width}px element bounds`, bounds);
      if (!bounds || bounds.x < 0 || bounds.x + bounds.width > width)
        responsiveFailures.push(
          `Destination group, trigger, and menu must fit ${width}px at font24: ${JSON.stringify(bounds)}`,
        );
    }
    await page.keyboard.press("Escape");
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await setFontSize(10);
  await openMenu();
  await page.keyboard.press("Escape");
  await setFontSize(13);
  assert.deepEqual(responsiveFailures, []);
  assert.deepEqual(errors, []);
  console.log(
    "Custom squash destination browser E2E passed (real jj/API, picker, queue, undo).",
  );
} catch (error) {
  await screenshot("failure");
  console.error("Custom destination browser errors:", errors);
  throw error;
} finally {
  releaseSquash?.();
  await fixture.close();
  api.closeEvents();
  await service.drain();
}
