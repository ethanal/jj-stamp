import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createBrowserFixture } from "./browser-fixture.ts";
import { expect, type Locator } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

// A real browser and real jj; only isolated, disposable fixture repositories.
const dataDir = await mkdtemp(path.join(tmpdir(), "fold-browser-"));
const repoPath = await createDemo(dataDir);
let service = new ReviewService({ repoPath });
let apiRouter = createApi(service);
async function reviewWorkingCopy() {
  // Simulate restarting the CLI for a new change between fixture scenarios.
  await service.drain();
  service = new ReviewService({ repoPath });
  apiRouter = createApi(service);
}
const initial = await service.getState();
const app = express();
app.use("/api", (req, res, next) => apiRouter(req, res, next));
const fixture = await createBrowserFixture({
  app,
  captureConsoleErrors: true,
});
const { page, url, errors } = fixture;
// Reproduce the reported client-side /api/log filter. The UI must fetch its
// revision graph without requesting the logging-shaped compatibility URL.
let blockedLogRequests = 0;
const mutations: string[] = [];
const rejectedReads: Array<{ path: string; code: string }> = [];
page.on("response", async (response) => {
  if (response.status() === 409) {
    const body = await response.json().catch(() => ({}));
    rejectedReads.push({
      path: new URL(response.url()).pathname,
      code: body.code,
    });
  }
});
page.on("request", (request) => {
  if (
    request.method() === "POST" &&
    /\/api\/(squash|preview)/.test(request.url())
  )
    mutations.push(new URL(request.url()).pathname);
});
const treeRow = (path: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${path}"]`);
const codeLine = (line: number, type = "change-addition") =>
  page.locator(
    `[data-line="${line}"][data-line-type${type === "context" ? "^" : ""}="${type}"]`,
  );
async function drag(from: Locator, to: Locator) {
  await from.scrollIntoViewIfNeeded();
  const a = await from.boundingBox(),
    b = await to.boundingBox();
  assert(a && b);
  await page.mouse.move(a.x + Math.min(180, a.width / 2), a.y + a.height / 2);
  await page.mouse.down();
  const filePicker = page.getByRole("navigation", { name: "Changed files" });
  // Guard navigation during the drag without dimming the file picker.
  await expect(filePicker).toHaveAttribute("aria-disabled", "true");
  await expect(filePicker).toHaveCSS("opacity", "1");
  await expect(page.getByRole("button", { name: "settings" })).toBeDisabled();
  for (const button of await page.locator("button:disabled").all()) {
    await expect(button).toHaveCSS("opacity", "1");
  }
  await page.mouse.move(b.x + Math.min(220, b.width / 2), b.y + b.height / 2, {
    steps: 8,
  });
  await expect(
    page.locator("[data-line][data-fold-selected]").first(),
  ).toBeVisible();
  await expect(
    page.locator("[data-line][data-fold-selection-start]").first(),
  ).toBeVisible();
  await page.mouse.up();
  await expect(filePicker).toHaveAttribute("aria-disabled", "false");
  await expect(filePicker).toHaveCSS("opacity", "1");
}
async function pressMutation(key: "s" | "u") {
  const endpoint = key === "s" ? "/api/squash-lines" : "/api/undo";
  const response = page.waitForResponse((response) =>
    response.url().endsWith(endpoint),
  );
  await page.keyboard.press(key);
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  return result.json();
}
try {
  await page.route("**/api/log*", async (route) => {
    blockedLogRequests++;
    await route.abort("blockedbyclient");
  });
  await page.goto(url);
  await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "reset demo" })).toHaveCount(0);
  await expect(codeLine(21)).toBeVisible();
  await expect(page).toHaveTitle(
    `${initial.source.description} (${initial.source.changeId.slice(0, 8)} ${initial.repo.path})`,
  );
  await expect(page.getByLabel("Repository path")).toHaveText(
    initial.repo.path,
  );
  await expect(page.getByLabel("Repository path")).toHaveAttribute(
    "title",
    initial.repo.path,
  );
  await expect(page.getByLabel("Current change ID")).toHaveText(
    initial.source.changeId.slice(0, 8),
  );
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    initial.source.changeId,
  );
  await expect(page.getByLabel("Current commit ID")).toHaveText(
    initial.source.commitId.slice(0, 12),
  );
  await expect(page.getByLabel("Current commit ID")).toHaveAttribute(
    "title",
    initial.source.commitId,
  );
  await expect(page.getByLabel("Revision author")).toHaveCount(0);
  await expect(
    page.getByLabel("Current change ID").locator("strong"),
  ).toHaveCount(0);
  await expect(page.locator(".log-change strong")).toHaveCount(0);
  assert.deepEqual(
    await page
      .getByLabel("Reviewed revision")
      .evaluate((node) =>
        Array.from(node.children).map(
          (child) => child.getAttribute("aria-label") ?? child.className,
        ),
      ),
    [
      "Current change ID",
      "source-description",
      "Current commit ID",
      "commit-totals",
    ],
  );
  await expect(page.locator(".file-tree [role=tree]")).toBeVisible();
  await expect(treeRow("src/notifications.ts")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(treeRow("src/notifications.ts")).toContainText("+2−2");
  const reviewChange = (changeId: string) =>
    page.getByRole("button", {
      name: `Review change ${changeId}`,
      exact: true,
    });
  await expect(reviewChange(initial.source.changeId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Squash destination change ID")).toHaveAttribute(
    "title",
    initial.parent!.changeId,
  );
  await codeLine(21).click();
  const selectedParent = page.waitForResponse((response) =>
    response.url().endsWith("/api/revision"),
  );
  await reviewChange(initial.parent!.changeId).click();
  const parentResponse = await selectedParent;
  assert.equal(parentResponse.status(), 200, await parentResponse.text());
  const parentState = (await parentResponse.json()).state;
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    initial.parent!.changeId,
  );
  await expect(page.getByLabel("Squash destination change ID")).toHaveAttribute(
    "title",
    parentState.parent.changeId,
  );
  await expect(page.getByRole("status")).toContainText(
    "Drag code to select lines",
  );
  await expect(reviewChange(initial.parent!.changeId)).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await reviewChange(initial.source.changeId).click();
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    initial.source.changeId,
  );
  await expect(codeLine(21)).toBeVisible();
  console.log(
    "✓ Click a mutable graph change, display its unique parent, clear old selection, and switch back",
  );
  const fileCounts = treeRow("tests/notifications.test.ts").locator(
    '[data-item-section="decoration"]',
  );
  assert(
    await fileCounts.evaluate((node) => node.clientWidth >= node.scrollWidth),
    "counts must not be clipped by a long filename",
  );
  await treeRow("tests/").click();
  await expect(treeRow("tests/")).toHaveAttribute("aria-expanded", "false");
  await expect(treeRow("tests/notifications.test.ts")).toHaveCount(0);
  await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
  const treeRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/state"),
  );
  await page.keyboard.press("r");
  await treeRefresh;
  await expect(page.getByRole("button", { name: "refresh r" })).toBeEnabled();
  await expect(treeRow("tests/")).toHaveAttribute("aria-expanded", "false");
  await treeRow("tests/").focus();
  await page.keyboard.press("ArrowRight");
  await expect(treeRow("tests/")).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator(".file-bar")).toContainText(
    "tests/notifications.test.ts",
  );
  await expect(treeRow("tests/notifications.test.ts")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await treeRow("src/notifications.ts").click();
  await expect(codeLine(21)).toBeVisible();
  await expect(treeRow("src/notifications.ts")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  console.log(
    "✓ Pierre Trees folders, keyboard file navigation, active file, counts, and expansion survives refresh",
  );
  await codeLine(21).click();
  const beforeWidth = (await page.locator(".viewer").boundingBox())!.width;
  const surface = await page.locator(".code-surface").elementHandle();
  await page
    .getByRole("button", { name: "Collapse files sidebar", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand files sidebar", exact: true }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#files-sidebar-content")).toBeHidden();
  await page
    .getByRole("button", { name: "Collapse log sidebar", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Expand log sidebar", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("jj log output")).toBeHidden();
  assert(
    (await page.locator(".viewer").boundingBox())!.width > beforeWidth + 400,
  );
  assert(
    await surface!.evaluate(
      (node) => node === document.querySelector(".code-surface"),
    ),
  );
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Expand files sidebar", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand log sidebar", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand files sidebar", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Expand log sidebar", exact: true })
    .click();
  await expect(page.locator("#files-sidebar-content")).toBeVisible();
  await expect(page.getByLabel("jj log output")).toBeVisible();
  console.log(
    "✓ Full repository path, full revision IDs on hover, persistent sidebar rails, selection retained across collapse",
  );
  // Both rails are resizeable without changing picks, and all preferences persist.
  const fileResize = page.getByRole("separator", {
    name: "Resize files sidebar",
  });
  const logResize = page.getByRole("separator", { name: "Resize log sidebar" });
  await codeLine(21).click();
  const initialFileWidth = Number(
    await fileResize.getAttribute("aria-valuenow"),
  );
  await fileResize.focus();
  await page.keyboard.press("ArrowRight");
  await expect(fileResize).toHaveAttribute(
    "aria-valuenow",
    String(initialFileWidth + 10),
  );
  const initialLogWidth = Number(await logResize.getAttribute("aria-valuenow"));
  const resizeBox = await logResize.boundingBox();
  assert(resizeBox);
  await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + 60);
  await page.mouse.down();
  await page.mouse.move(
    resizeBox.x + resizeBox.width / 2 - 40,
    resizeBox.y + 60,
    { steps: 5 },
  );
  await page.mouse.up();
  await expect(logResize).toHaveAttribute(
    "aria-valuenow",
    String(initialLogWidth + 40),
  );
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Color scheme" })
    .selectOption("light");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expect(codeLine(21)).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await page.reload();
  await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
  await page.getByRole("button", { name: "settings", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Color scheme" }),
  ).toHaveValue("light");
  await expect(fileResize).toHaveAttribute(
    "aria-valuenow",
    String(initialFileWidth + 10),
  );
  await expect(logResize).toHaveAttribute(
    "aria-valuenow",
    String(initialLogWidth + 40),
  );
  await page
    .getByRole("combobox", { name: "Color scheme" })
    .selectOption("dim");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dim",
  );
  await expect(codeLine(21)).toBeVisible();
  await page
    .getByRole("combobox", { name: "Color scheme" })
    .selectOption("dark");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.getByRole("button", { name: "Close settings" }).click();
  console.log(
    "✓ Resizable sidebars, keyboard resizing, color schemes, persisted preferences, and heading metadata",
  );
  await drag(codeLine(21, "change-deletion"), codeLine(21));
  await expect(
    page.locator("[data-line][data-fold-selection-start]"),
  ).toHaveCount(1);
  await expect(
    page.locator("[data-line][data-fold-selection-end]"),
  ).toHaveCount(1);
  assert.equal(
    await codeLine(21).evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    ),
    "rgb(22, 70, 107)",
  );
  assert(
    (
      await page
        .locator("[data-column-number][data-fold-selected]")
        .first()
        .evaluate((node) => getComputedStyle(node).boxShadow)
    ).includes("rgb(121, 201, 255)"),
  );

  await expect(page.getByRole("status")).toContainText(
    "2 changed lines selected",
  );
  const before = await readFile(
    path.join(initial.repo.path, "src/notifications.ts"),
    "utf8",
  );
  const result = await pressMutation("s");
  assert.equal(result.state.parent.changeId, initial.parent!.changeId);
  await expect(page.getByLabel("Current commit ID")).toHaveAttribute(
    "title",
    result.state.source.commitId,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(codeLine(21)).toHaveCount(0);
  assert.equal(
    await readFile(
      path.join(initial.repo.path, "src/notifications.ts"),
      "utf8",
    ),
    before,
  );
  await pressMutation("u");
  await expect(codeLine(21)).toBeVisible();
  console.log(
    "✓ Drag actual code (not gutter) → s → immediate @ to @- squash → u undo",
  );

  await expect(page.getByLabel("Change line counts")).toHaveText("+8−5");
  await expect(treeRow("src/notifications.ts")).toContainText("+2−2");
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator('[data-diff-type="split"]')).toHaveCount(1);
  await drag(page.locator('[data-additions] [data-line="20"]'), codeLine(21));
  await expect(page.getByRole("status")).toContainText(
    "2 changed lines selected",
  );
  await expect(
    page.locator(
      '[data-line][data-line-type="change-addition"][data-fold-selected]',
    ),
  ).toHaveCount(1);
  await expect(
    page.locator(
      '[data-line][data-line-type="change-deletion"][data-fold-selected]',
    ),
  ).toHaveCount(1);
  await pressMutation("s");
  await pressMutation("u");
  await drag(
    page.locator('[data-deletions] [data-line="20"]'),
    codeLine(21, "change-deletion"),
  );
  await expect(page.getByRole("status")).toContainText(
    "2 changed lines selected",
  );
  await pressMutation("s");
  await pressMutation("u");
  await drag(codeLine(21, "change-deletion"), codeLine(21));
  await expect(page.getByRole("status")).toContainText(
    "2 changed lines selected",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await expect(page.locator('[data-diff-type="split"]')).toHaveCount(0);
  console.log(
    "✓ Split/Stacked toggle; drags select both columns from either side, and +/- counts",
  );

  await treeRow("tests/notifications.test.ts").click();
  const hunk = initial.files.find(
    (file) => file.path === "tests/notifications.test.ts",
  )!.hunks[0];
  const added = hunk.rows.filter((row) => row.raw[0] === "+");
  await codeLine(added[1].newLine!).click();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await codeLine(added[0].newLine!).click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status")).toContainText(
    "2 changed lines selected",
  );
  // Alt must leave squash picks unchanged and allow real browser text selection.
  const copyLine = codeLine(added[0].newLine!);
  const copyBounds = await copyLine.boundingBox();
  assert(copyBounds);
  await page.keyboard.down("Alt");
  await page.mouse.move(
    copyBounds.x + 10,
    copyBounds.y + copyBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    copyBounds.x + 170,
    copyBounds.y + copyBounds.height / 2,
    { steps: 8 },
  );
  await page.mouse.up();
  await page.keyboard.up("Alt");
  assert(
    (await page.evaluate(() => window.getSelection()?.toString() ?? ""))
      .length > 0,
    "Alt+drag selects native text for copying",
  );
  await expect(page.getByRole("status")).toContainText(
    "2 changed lines selected",
  );
  await codeLine(added[1].newLine!).click();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  const request = page.waitForRequest((request) =>
    request.url().endsWith("/api/squash-lines"),
  );
  await pressMutation("s");
  assert.deepEqual((await request).postDataJSON().selections, [
    { id: hunk.id, lines: [added[1].index] },
  ]);
  await pressMutation("u");
  console.log(
    "✓ Exact single-line squash and Alt+drag native text copying; no whole-hunk selection",
  );

  await expect(
    page.getByRole("complementary", { name: "Revision graph" }),
  ).toBeVisible();
  const actualLog = await service.getLog();
  const graphText = actualLog.rows.map(
    (row) =>
      row.graph +
      (row.revision
        ? `${row.revision.changeId.slice(0, 8)} ${row.isEmpty ? "(empty) " : ""}${row.revision.description || "(no description)"}`
        : ""),
  );
  await expect(page.getByLabel("jj log output").locator(".log-row")).toHaveText(
    graphText,
  );
  await expect(page.locator('.log-change[aria-pressed="true"]')).toHaveCount(1);
  const previousMutations = mutations.length;
  await page.keyboard.press("s");
  await page.waitForTimeout(150);
  assert.equal(mutations.length, previousMutations);
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();
  await expect(page.getByLabel("jj log output")).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Expand log sidebar" }),
  ).toBeVisible();
  await page.keyboard.press("l");
  await expect(page.getByLabel("jj log output")).toBeVisible();
  await expect(page.locator(".code-surface")).toBeVisible();
  console.log(
    "✓ Clickable real jj graph, active change, and guarded empty selection",
  );

  await treeRow("src/notifications.ts").click();
  await expect(codeLine(18, "context")).toBeVisible();
  await page
    .getByRole("button", { name: "Show 10 lines above", exact: true })
    .first()
    .click();
  await expect(codeLine(8, "context")).toBeVisible();
  await expect(codeLine(7, "context")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show 10 lines above", exact: true })
    .first()
    .click();
  await expect(codeLine(1, "context")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  console.log("✓ Context expands 10 lines upward, then stops at file boundary");

  // A large insertion surrounded by ample context tests true sub-hunk precision.
  const filename = path.join(initial.repo.path, "src/long.ts");
  const base = Array.from(
    { length: 160 },
    (_, i) => `export const value${i + 1} = ${i + 1};`,
  );
  await writeFile(filename, base.join("\n") + "\n");
  await jj(initial.repo.path, ["commit", "-m", "Context expansion fixture"]);
  const extra = Array.from(
    { length: 40 },
    (_, i) => `export const inserted${i + 1} = ${i + 1};`,
  );
  await writeFile(
    filename,
    [...base.slice(0, 70), ...extra, ...base.slice(70)].join("\n") + "\n",
  );
  await reviewWorkingCopy();
  await page.keyboard.press("r");
  await expect(treeRow("src/long.ts")).toBeVisible();
  await treeRow("src/long.ts").click();
  const longState = await service.getState();
  const longHunk = longState.files.find((file) => file.path === "src/long.ts")!
    .hunks[0];
  const longAdditions = longHunk.rows.filter((row) => row.raw[0] === "+");
  assert.equal(longAdditions.length, 40);
  await page
    .getByRole("button", { name: "Show 10 lines above", exact: true })
    .first()
    .click();
  await expect(codeLine(58, "context")).toBeVisible();
  await expect(codeLine(57, "context")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show 10 lines below", exact: true })
    .last()
    .click();
  await expect(codeLine(123, "context")).toHaveCount(1);
  await expect(codeLine(124, "context")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Show 10 lines below", exact: true })
    .last()
    .click();
  await expect(codeLine(133, "context")).toHaveCount(1);
  await expect(codeLine(134, "context")).toHaveCount(0);
  await drag(codeLine(58, "context"), codeLine(longAdditions[2].newLine!));
  await expect(page.getByRole("status")).toContainText(
    "3 changed lines selected",
  );
  await page.keyboard.press("Escape");
  const picked = longAdditions.slice(18, 21);
  await drag(codeLine(picked[0].newLine!), codeLine(picked[2].newLine!));
  await expect(page.getByRole("status")).toContainText(
    "3 changed lines selected",
  );
  const longRequest = page.waitForRequest((request) =>
    request.url().endsWith("/api/squash-lines"),
  );
  await pressMutation("s");
  assert.deepEqual((await longRequest).postDataJSON().selections, [
    { id: longHunk.id, lines: picked.map((row) => row.index) },
  ]);
  const remaining = await service.getState();
  assert.equal(
    remaining.files.find((file) => file.path === "src/long.ts")!.additions,
    37,
  );
  await pressMutation("u");
  assert.equal(
    (await service.getState()).files.find(
      (file) => file.path === "src/long.ts",
    )!.additions,
    40,
  );
  console.log(
    "✓ Exact 10-line expansion both directions; 3/40 lines squashed from one long hunk",
  );

  // Hold the first POST at the browser edge: UI must move before ANY jj mutation.
  let releaseFirst!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const queuedRequests: Array<{ version: string; selections: unknown }> = [];
  await page.route("**/api/squash-lines", async (route) => {
    queuedRequests.push(route.request().postDataJSON());
    if (queuedRequests.length === 1) await held;
    await route.continue();
  });
  const queueLines = longAdditions.slice(4, 8);
  await codeLine(queueLines[0].newLine!).click();
  await page.keyboard.press("s");
  await expect(page.getByRole("status")).toContainText("1 queued");
  for (const button of await page.locator(".log-change").all())
    await expect(button).toBeDisabled();
  await expect(codeLine(queueLines[0].newLine!)).toHaveCount(0);
  await expect(page.getByLabel("Change line counts")).toHaveText("+39−0");
  await expect(treeRow("src/long.ts")).toContainText("+39−0");
  assert.equal(
    (await service.getState()).files.find(
      (file) => file.path === "src/long.ts",
    )!.additions,
    40,
  );
  await codeLine(queueLines[1].newLine!).click();
  await page.keyboard.press("s");
  await expect(page.getByRole("status")).toContainText("2 queued");
  await expect(codeLine(queueLines[1].newLine!)).toHaveCount(0);
  await expect(page.getByLabel("Change line counts")).toHaveText("+38−0");
  assert.equal(queuedRequests.length, 1, "only one mutation may be in flight");
  await expect(
    page
      .getByRole("button", { name: "Show 10 lines above", exact: true })
      .first(),
  ).toHaveAttribute("aria-disabled", "true");
  await codeLine(queueLines[2].newLine!).click();
  await page.keyboard.press("s");
  await expect(page.getByRole("status")).toContainText("2 queued");
  await expect(codeLine(queueLines[2].newLine!)).toHaveCount(0);
  await expect(page.getByLabel("Change line counts")).toHaveText("+37−0");
  // A new selection must survive earlier operations being acknowledged.
  await codeLine(queueLines[3].newLine!).click();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await expect(page.locator("[data-line][data-fold-selected]")).toHaveCount(1);
  releaseFirst();
  await expect(page.locator(".queue-count")).toHaveCount(0, { timeout: 15000 });
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  assert.equal(queuedRequests.length, 2);
  assert.notEqual(
    queuedRequests[0].version,
    queuedRequests[1].version,
    "second job uses newly acknowledged version",
  );
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  // Undo restores both selections in the compacted batch, but not the first.
  await page.keyboard.press("Escape");
  await pressMutation("u");
  await expect(page.getByLabel("Change line counts")).toHaveText("+39−0");
  await expect(codeLine(queueLines[0].newLine!)).toHaveCount(0);
  for (const row of queueLines.slice(1, 3)) {
    await expect(codeLine(row.newLine!)).toBeVisible();
    await codeLine(row.newLine!).click();
    await pressMutation("s");
  }
  assert.equal(
    (await service.getState()).files.find(
      (file) => file.path === "src/long.ts",
    )!.additions,
    37,
  );
  await page.unroute("**/api/squash-lines");
  console.log(
    "✓ Instant speculative rows/counts, compaction/undo, fresh-version remapping, and selection survives ACKs/layout changes",
  );

  // First squash succeeds; the compacted follow-up fails and must never be retried.
  const failState = await service.getState();
  const failLines = failState.files
    .find((file) => file.path === "src/long.ts")!
    .hunks.flatMap((h) => h.rows)
    .filter((row) => row.raw[0] === "+")
    .slice(0, 3);
  let releaseFailure!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  let failureRequests = 0;
  const failedToolOutput =
    "patching src/long.ts\nHunk #1 FAILED at 71.\nCaused by: permission denied\n<img src=x onerror=alert('unsafe')>\n";
  await page.route("**/api/squash-lines", async (route) => {
    failureRequests++;
    if (failureRequests === 1) {
      await gate;
      await route.continue();
    } else {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Injected queue failure",
          code: "TOOL_FAILED",
          output: failedToolOutput,
        }),
      });
    }
  });
  for (const row of failLines) {
    await codeLine(row.newLine!).click();
    await page.keyboard.press("s");
  }
  await expect(page.getByRole("status")).toContainText("2 queued");
  await expect(page.getByLabel("Change line counts")).toHaveText("+34−0");
  releaseFailure();
  await expect(page.getByRole("alert")).toContainText(
    "Injected queue failure",
    { timeout: 15000 },
  );
  await expect(page.getByRole("status")).toContainText("Queue stopped");
  await expect(page.getByLabel("Squash error details")).toContainText(
    "TOOL_FAILED",
  );
  await expect(page.getByLabel("Squash output")).toHaveText(failedToolOutput);
  await expect(page.getByLabel("Squash output").locator("img")).toHaveCount(0);
  await expect(page.getByLabel("Squash output")).toBeVisible();
  assert.equal(
    await page
      .getByLabel("Squash output")
      .evaluate((node) => getComputedStyle(node).whiteSpace),
    "pre-wrap",
  );
  await expect(page.getByLabel("Change line counts")).toHaveText("+36−0");
  await expect(treeRow("src/long.ts")).toContainText("+36−0");
  assert.equal(failureRequests, 2, "failed compacted batch is not retried");
  await expect(codeLine(failLines[1].newLine!)).toBeVisible();
  await expect(codeLine(failLines[2].newLine!)).toBeVisible();
  assert.equal(
    (await service.getState()).files.find(
      (file) => file.path === "src/long.ts",
    )!.additions,
    36,
  );
  await page.unroute("**/api/squash-lines");
  // The deliberate HTTP failure is the only permitted console resource error.
  const expectedError = errors.findIndex((error) => error.includes("503"));
  if (expectedError >= 0) errors.splice(expectedError, 1);
  await page.keyboard.press("r");
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText(
    "Drag code to select lines",
  );
  console.log(
    "✓ Failure shows literal multiline tool output/code, stops the queue, and reloads without replay",
  );

  await codeLine(failLines[1].newLine!).click();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("status")).toContainText(
    "Drag code to select lines",
  );
  const noSelectionMutations = mutations.length;
  await page.keyboard.press("s");
  await page.waitForTimeout(150);
  assert.equal(mutations.length, noSelectionMutations);
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileCounts = treeRow("src/long.ts").locator(
    '[data-item-section="decoration"]',
  );
  assert(
    await mobileCounts.evaluate((node) => node.clientWidth >= node.scrollWidth),
    "counts remain readable on mobile",
  );
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await expect(page.getByLabel("Current change ID")).toBeVisible();
  await expect(page.getByLabel("Current commit ID")).toBeVisible();
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await page.getByRole("button", { name: "Collapse log sidebar" }).click();
  await expect(
    page.getByRole("button", { name: "Expand files sidebar" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Expand log sidebar" }),
  ).toBeVisible();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "Expand files sidebar" }).click();
  await page.getByRole("button", { name: "Expand log sidebar" }).click();
  await page.screenshot({ path: path.join(dataDir, "jj-stamp-mobile.png") });
  const refreshState = async () => {
    const response = page.waitForResponse((response) =>
      response.url().endsWith("/api/state"),
    );
    await page.keyboard.press("r");
    const result = await response;
    assert.equal(result.status(), 200, await result.text());
    return result.json();
  };
  await jj(initial.repo.path, [
    "describe",
    "-m",
    "Updated commit title\n\nDescription body",
  ]);
  const described = await refreshState();
  await expect(page).toHaveTitle(
    `Updated commit title (${described.source.changeId.slice(0, 8)} ${initial.repo.path})`,
  );
  await jj(initial.repo.path, ["new", "-m", "Next change"]);
  const stillReviewed = await refreshState();
  assert.equal(stillReviewed.source.changeId, described.source.changeId);
  await expect(page).toHaveTitle(
    `Updated commit title (${described.source.changeId.slice(0, 8)} ${initial.repo.path})`,
  );
  await reviewWorkingCopy();
  const next = await refreshState();
  assert.notEqual(next.source.changeId, described.source.changeId);
  await expect(page.locator(".file-tree [role=treeitem]")).toHaveCount(0);
  await expect(page).toHaveTitle(
    `Next change (${next.source.changeId.slice(0, 8)} ${initial.repo.path})`,
  );
  console.log(
    "✓ Page title follows the short change ID and commit title on refresh",
  );
  // Tree structure follows real repository changes, including duplicate
  // basenames, read-only files, and removal/restoration of a whole file.
  await page.setViewportSize({ width: 1440, height: 900 });
  await mkdir(path.join(initial.repo.path, "nested/deep"), { recursive: true });
  await mkdir(path.join(initial.repo.path, "other"), { recursive: true });
  await writeFile(
    path.join(initial.repo.path, "nested/deep/one.txt"),
    "nested\n",
  );
  await writeFile(path.join(initial.repo.path, "other/one.txt"), "other\n");
  await writeFile(path.join(initial.repo.path, "other/raw.txt"), "no newline");
  await refreshState();
  await expect(treeRow("nested/deep/one.txt")).toBeVisible();
  await expect(treeRow("nested/deep/")).toHaveAttribute(
    "aria-label",
    "nested / deep",
  );
  await expect(treeRow("nested/")).toHaveCount(0);
  await expect(treeRow("nested/deep/")).toHaveAttribute("aria-level", "1");
  await expect(treeRow("nested/deep/one.txt")).toHaveAttribute(
    "aria-level",
    "2",
  );
  await expect(treeRow("other/one.txt")).toBeVisible();
  await expect(treeRow("nested/deep/one.txt")).toHaveAttribute(
    "data-item-git-status",
    "added",
  );
  await treeRow("other/raw.txt").click();
  await expect(page.locator(".unsupported")).toBeVisible();
  await expect(
    treeRow("other/raw.txt").locator('[title*="read-only"]'),
  ).toHaveCount(1);
  await treeRow("other/one.txt").click({ modifiers: ["Control"] });
  await expect(page.locator('.file-tree [aria-selected="true"]')).toHaveCount(
    1,
  );
  await expect(page.locator(".file-bar")).toContainText("other/one.txt");
  await treeRow("nested/deep/").click();
  await expect(treeRow("nested/deep/one.txt")).toHaveCount(0);
  await refreshState();
  await expect(treeRow("nested/deep/")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(treeRow("nested/deep/one.txt")).toHaveCount(0);
  await codeLine(1).click();
  await treeRow("other/").click();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await pressMutation("s");
  await expect(page.locator(".file-bar")).toContainText("nested/deep/one.txt");
  await expect(treeRow("nested/deep/one.txt")).toBeVisible();
  await expect(treeRow("nested/deep/one.txt")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(treeRow("other/")).toHaveAttribute("aria-expanded", "false");
  await treeRow("other/").click();
  await expect(treeRow("other/one.txt")).toHaveCount(0);
  await pressMutation("u");
  await expect(treeRow("other/one.txt")).toBeVisible();
  await expect(treeRow("other/one.txt")).toContainText("+1−0");
  console.log(
    "✓ Compact folder chains, collapse survives refresh, duplicate names, whole-file squash/undo, and fallback reveal",
  );
  // A merge can be reviewed, but there is no single safe squash destination.
  const left = (
    await jj(repoPath, ["log", "--no-graph", "-r", "@", "-T", "change_id"])
  ).stdout.trim();
  await jj(repoPath, ["new", "@-", "-m", "Other branch"]);
  await jj(repoPath, ["new", left, "@", "-m", "Two-parent merge"]);
  const merge = (
    await jj(repoPath, ["log", "--no-graph", "-r", "@", "-T", "change_id"])
  ).stdout.trim();
  await refreshState();
  await reviewChange(merge).click();
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    merge,
  );
  await expect(page.locator(".squash-unavailable")).toContainText(
    "exactly one immediate parent",
  );
  await expect(page.getByRole("button", { name: "s squash" })).toBeDisabled();
  await expect(page.getByLabel("Squash destination change ID")).toHaveText("—");
  await reviewChange(left).click();
  await expect(page.locator(".squash-unavailable")).toHaveCount(0);
  console.log(
    "✓ Two-parent change shows an error and disables squashing; another mutable change remains selectable",
  );
  // A healthy new @ does not resurrect an empty review that jj auto-abandoned.
  // Cold-page recovery must work without any successful /state response.
  await jj(repoPath, ["new", "-m", "Healthy replacement change"]);
  const replacement = (
    await jj(repoPath, ["log", "--no-graph", "-r", "@", "-T", "change_id"])
  ).stdout.trim();
  await jj(repoPath, ["new"]);
  await reviewWorkingCopy();
  const pinnedEmpty = await refreshState();
  await page.reload();
  await expect(
    reviewChange(pinnedEmpty.source.changeId).locator(".."),
  ).toContainText("(empty) (no description)");
  await expect(reviewChange(replacement).locator("..")).toContainText(
    "(empty) Healthy replacement change",
  );
  await jj(repoPath, ["edit", replacement]);
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    pinnedEmpty.source.changeId,
  );
  await expect(page.getByRole("alert")).toContainText("SOURCE_UNAVAILABLE");
  await expect(reviewChange(replacement)).toBeEnabled();
  const recoverySelection = page.waitForResponse((response) =>
    response.url().endsWith("/api/revision"),
  );
  await reviewChange(replacement).click();
  const recovered = await recoverySelection;
  assert.equal(recovered.status(), 200, await recovered.text());
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    replacement,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  console.log(
    "✓ Missing pinned source identifies its full ID and permits explicit graph recovery without a loaded diff",
  );
  assert(mutations.every((endpoint) => endpoint === "/api/squash-lines"));
  // Fixture edits intentionally race an outstanding read-only graph refresh.
  // Any 409 must be that guard, never an unexpected mutation/context failure.
  for (const rejected of rejectedReads)
    assert.ok(
      (rejected.path === "/api/graph" && rejected.code === "STALE_STATE") ||
        (rejected.path === "/api/state" &&
          rejected.code === "SOURCE_UNAVAILABLE"),
      JSON.stringify(rejected),
    );
  if (rejectedReads.length) {
    for (let i = 0; i < rejectedReads.length; i++) {
      const index = errors.findIndex((error) =>
        error.includes("409 (Conflict)"),
      );
      if (index >= 0) errors.splice(index, 1);
    }
  }
  assert.equal(blockedLogRequests, 0, "UI must not use /api/log");
  assert.deepEqual(errors, []);
  console.log(
    "✓ Escape, guarded shortcuts, mobile layout, zero confirmation/preview requests",
  );
  console.log("Browser integration passed. Isolated fixture:", dataDir);
} catch (error) {
  console.error("Page errors:", errors);
  console.error(
    await page
      .locator('[role="alert"], [data-error-wrapper]')
      .allTextContents(),
  );
  await page.screenshot({ path: path.join(dataDir, "failure.png") });
  throw error;
} finally {
  await fixture.close();
}
