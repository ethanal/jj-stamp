import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect, type Route } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-focus-"));
await using resources = new AsyncDisposableStack();
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const service = new ReviewService({ repoPath });
resources.defer(() => service.drain());
const initial = await service.getState();
const app = express();
app.use("/api", createApi(service));
const fixture = await createBrowserFixture({ app });
resources.defer(() => fixture.close());
const { page, url, errors } = fixture;
let reads = 0;
let squashes = 0;
page.on("request", (request) => {
  if (request.url().endsWith("/api/state")) reads++;
  if (request.url().endsWith("/api/squash-lines")) squashes++;
});
const refreshButton = page.getByRole("button", {
  name: "refresh r",
  exact: true,
});
const added = () => page.locator('[data-line-type="change-addition"]').first();
const selected = () => page.locator("[data-line][data-fold-selected]");
async function focus() {
  // Deterministic window/tab events; no reliance on headless OS focus behavior.
  await page.evaluate(() => {
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
  });
}
async function settled() {
  await expect(refreshButton).toBeEnabled();
  await expect(page.locator(".statusbar")).not.toContainText("refreshing");
}
async function noReadSince(count: number) {
  await page.waitForTimeout(300); // Beyond the focus-event debounce.
  assert.equal(reads, count);
}

await page.goto(url);
await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
await expect(added()).toBeVisible();
await settled();
await page.waitForTimeout(200);

// Hidden tabs do not refresh; becoming visible requests a single refresh.
let before = reads;
await page.evaluate(() => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
});
await focus();
await noReadSince(before);
await page.evaluate(() => Reflect.deleteProperty(document, "visibilityState"));
const visible = page.waitForResponse("**/api/state");
await focus();
assert.equal((await visible).status(), 200);
await settled();
await noReadSince(before + 1);

// Unchanged focus checks coalesce and do not replace the diff DOM or scroll.
await page.locator('.file-tree [data-item-path="src/preferences.ts"]').click();
await expect(page.locator(".file-bar")).toContainText("src/preferences.ts");
const surface = await page.locator(".code-surface").elementHandle();
assert(surface);
const scrollTop = await page.locator(".viewer-scroll").evaluate((element) => {
  element.scrollTop = 40;
  return element.scrollTop;
});
before = reads;
const unchanged = page.waitForResponse("**/api/state");
await focus();
assert.equal((await unchanged).status(), 200);
await settled();
await noReadSince(before + 1);
assert(await surface.evaluate((element) => element.isConnected));
assert.equal(
  await page.locator(".viewer-scroll").evaluate((element) => element.scrollTop),
  scrollTop,
);
await expect(page.locator(".file-bar")).toContainText("src/preferences.ts");

// Editor saves are snapshotted by the focus read, without an external jj command.
const preferencePath = path.join(repoPath, "src/preferences.ts");
await writeFile(
  preferencePath,
  (await readFile(preferencePath, "utf8")).replace(
    "push: false,",
    "push: false, // focus refresh",
  ),
);
const changed = page.waitForResponse("**/api/state");
await focus();
const changedState = await (await changed).json();
assert.notEqual(changedState.version, initial.version);
assert.equal(changedState.source.changeId, initial.source.changeId);
await expect(page.locator(".code-surface")).toContainText("// focus refresh");
await expect(page.locator(".file-bar")).toContainText("src/preferences.ts");
await settled();

// A focus during a drag/selection waits until the range is explicitly cleared.
await added().scrollIntoViewIfNeeded();
const box = await added().boundingBox();
assert(box);
await page.mouse.move(box.x + 100, box.y + box.height / 2);
await page.mouse.down();
await expect(selected().first()).toBeVisible();
before = reads;
await focus();
await noReadSince(before);
await page.mouse.up();
await noReadSince(before);
await expect(selected().first()).toBeVisible();
const deferred = page.waitForResponse("**/api/state");
await page.keyboard.press("Escape");
assert.equal((await deferred).status(), 200);
await settled();
await noReadSince(before + 1);

// Focus during an in-flight read coalesces into one follow-up, so edits made
// after the first snapshot aren't lost. Mutations cannot overlap the read.
let releaseRead!: () => void;
let capturedRead!: () => void;
const readCaptured = new Promise<void>((resolve) => {
  capturedRead = resolve;
});
const readGate = new Promise<void>((resolve) => {
  releaseRead = resolve;
});
const holdRead = async (route: Route) => {
  const response = await route.fetch();
  capturedRead();
  await readGate;
  await route.fulfill({ response });
};
await page.route("**/api/state", holdRead);
const hint = page.locator(".text-selection-hint");
const hintBeforeRefresh = await hint.boundingBox();
assert(hintBeforeRefresh);
async function expectCenteredHint() {
  const footerBox = await page.locator(".statusbar").boundingBox();
  const hintBox = await hint.boundingBox();
  assert(footerBox && hintBox);
  assert(
    Math.abs(
      hintBox.x + hintBox.width / 2 - (footerBox.x + footerBox.width / 2),
    ) < 1,
    "Copy hint stays centered in the footer",
  );
  assert(
    Math.abs(hintBox.x - hintBeforeRefresh!.x) < 1,
    "Status text changes do not move the copy hint",
  );
}
before = reads;
const heldRead = page.waitForResponse("**/api/state");
await focus();
await expect.poll(() => reads).toBe(before + 1);
await expect(refreshButton).toBeDisabled();
await readCaptured;
await expect(page.locator(".statusbar")).toContainText("refreshing");
await expectCenteredHint();
// Refresh only locks mutations: sidebar appearance and navigation stay intact.
const fileNavigation = page.getByRole("navigation", { name: "Changed files" });
await expect(fileNavigation).toHaveCSS("opacity", "1");
await expect(fileNavigation).toHaveAttribute("aria-disabled", "false");
assert.equal(
  await fileNavigation.evaluate((element) => element.hasAttribute("inert")),
  false,
);
const notificationRow = page.locator(
  '.file-tree [data-item-path="src/notifications.ts"]',
);
await notificationRow.click();
await expect(notificationRow).toHaveAttribute("aria-selected", "true");
await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
await expect(page.locator(".squash-file")).toBeDisabled();
await notificationRow.hover();
await expect(page.locator(".file-tree-squash")).toBeDisabled();
await expect(
  page.getByRole("button", { name: "s squash", exact: true }),
).toBeDisabled();
const squashesBeforeRefresh = squashes;
await page.keyboard.press("s");
assert.equal(squashes, squashesBeforeRefresh);
await page.locator('.file-tree [data-item-path="src/preferences.ts"]').click();
await expect(page.locator(".file-bar")).toContainText("src/preferences.ts");
await writeFile(
  preferencePath,
  (await readFile(preferencePath, "utf8")).replace(
    "// focus refresh",
    "// second focus",
  ),
);
await focus();
await focus();
await page.keyboard.press("r");
await page.keyboard.press("u");
await noReadSince(before + 1);
releaseRead();
assert.equal((await heldRead).status(), 200);
await page.unroute("**/api/state", holdRead);
await expect(page.locator(".code-surface")).toContainText("// second focus");
await settled();
await noReadSince(before + 2);
await expectCenteredHint();

// A recorded workspace move does not switch away from the selected change.
await jj(repoPath, ["new", "-m", "Another working copy"]);
const pinned = page.waitForResponse("**/api/state");
await focus();
assert.equal(
  (await (await pinned).json()).source.changeId,
  initial.source.changeId,
);
await expect(
  page.getByRole("complementary", { name: "Revision graph" }),
).toContainText("Another working copy");
await settled();

// Focus waits for a real squash to drain, without replacing its projection.
let releaseSquash!: () => void;
const squashGate = new Promise<void>((resolve) => {
  releaseSquash = resolve;
});
const holdSquash = async (route: Route) => {
  await squashGate;
  await route.continue();
};
await page.route("**/api/squash-lines", holdSquash);
await added().click();
const squashed = page.waitForResponse("**/api/squash-lines");
await page.keyboard.press("s");
await expect.poll(() => squashes).toBe(1);
before = reads;
await focus();
await noReadSince(before);
const afterSquash = page.waitForResponse("**/api/state");
releaseSquash();
assert.equal((await squashed).status(), 200);
assert.equal((await afterSquash).status(), 200);
await page.unroute("**/api/squash-lines", holdSquash);
await settled();
await noReadSince(before + 1);

// A failed squash remains halted, even if focus arrives during recovery or after
// diagnostics are dismissed. Only an explicit refresh may resume the queue.
await page.route("**/api/squash-lines", (route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({
      error: "Focus test failure",
      code: "TOOL_FAILED",
      output: "original diagnostics",
    }),
  }),
);
await added().click();
const recovery = page.waitForResponse("**/api/state");
await page.keyboard.press("s");
await focus();
assert.equal((await recovery).status(), 200);
await expect(page.getByRole("alert")).toContainText("Focus test failure");
await expect(page.getByRole("alert")).toContainText("original diagnostics");
before = reads;
await focus();
await noReadSince(before);
await expect(page.getByRole("alert")).toContainText("original diagnostics");
await page.keyboard.press("Escape");
await focus();
await noReadSince(before);
await added().click();
await page.keyboard.press("s");
assert.equal(squashes, 2);
const explicit = page.waitForResponse("**/api/state");
await page.keyboard.press("r");
assert.equal((await explicit).status(), 200);
await settled();
await expect(page.getByRole("alert")).toHaveCount(0);

// Read failures keep the last view and refresh the graph for explicit recovery;
// they never start a retry loop. Manual refresh still clears the error.
const failRead = (route: Route) =>
  route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({
      error: "Selected change unavailable",
      code: "SOURCE_UNAVAILABLE",
    }),
  });
await page.route("**/api/state", failRead);
before = reads;
const failureGraph = page.waitForResponse("**/api/graph");
await focus();
await expect(page.getByRole("alert")).toContainText(
  "Selected change unavailable",
);
assert.equal((await failureGraph).status(), 200);
await expect(page.locator(".code-surface")).toBeVisible();
await noReadSince(before + 1);
await page.unroute("**/api/state", failRead);
const recovered = page.waitForResponse("**/api/state");
await page.keyboard.press("r");
assert.equal((await recovered).status(), 200);
await expect(page.getByRole("alert")).toHaveCount(0);

assert.deepEqual(errors, []);
console.log(
  "Focus refresh: coalescing, external edits, pinned identity, interaction/queue deferral and halted recovery passed.",
);
