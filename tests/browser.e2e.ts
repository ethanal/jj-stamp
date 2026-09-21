import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { chromium, expect, type Locator } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";

// A real browser and real jj; never use the user-facing demo repository.
const dataDir = await mkdtemp(path.join(tmpdir(), "fold-browser-"));
const service = new ReviewService({ dataDir });
const initial = await service.getState();
const app = express();
const server = createServer(app);
app.use("/api", createApi(service));
const vite = await createVite({
  server: { middlewareMode: true, hmr: false },
  appType: "spa",
});
app.use(vite.middlewares);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("No test port");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors: string[] = [],
  mutations: string[] = [];
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
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("request", (request) => {
  if (
    request.method() === "POST" &&
    /\/api\/(squash|preview)/.test(request.url())
  )
    mutations.push(new URL(request.url()).pathname);
});
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
  await page.goto(`http://127.0.0.1:${address.port}`);
  await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
  await expect(page.getByRole("checkbox")).toHaveCount(0);
  await expect(codeLine(21)).toBeVisible();
  await expect(page).toHaveTitle(
    `jj-stamp ${initial.source.changeId.slice(0, 8)}: ${initial.source.description}`,
  );
  await expect(page.locator(".app-name")).toHaveText("jj-stamp");
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
    "✓ jj-stamp branding, full revision IDs on hover, persistent sidebar rails, selection retained across collapse",
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

  await expect(page.getByLabel("Working copy line counts")).toHaveText("+8−5");
  await expect(
    page.getByTitle("src/notifications.ts", { exact: true }),
  ).toContainText("+2−2");
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

  await page.getByTitle("tests/notifications.test.ts", { exact: true }).click();
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
    "✓ Exact single-line squash and Shift-click; no whole-hunk selection",
  );

  await expect(
    page.getByRole("complementary", { name: "Revision graph" }),
  ).toBeVisible();
  const actualLog = (await jj(initial.repo.path, ["log", "--limit", "100"]))
    .stdout;
  await expect(page.getByLabel("jj log output")).toHaveText(actualLog);
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
    "✓ Right-side raw jj log, independent of diff, and guarded empty selection",
  );

  await page.getByTitle("src/notifications.ts", { exact: true }).click();
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
  await page.keyboard.press("r");
  await expect(page.getByTitle("src/long.ts", { exact: true })).toBeVisible();
  await page.getByTitle("src/long.ts", { exact: true }).click();
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
  const queueLines = longAdditions.slice(4, 7);
  await codeLine(queueLines[0].newLine!).click();
  await page.keyboard.press("s");
  await expect(page.getByRole("status")).toContainText("1 queued");
  await expect(codeLine(queueLines[0].newLine!)).toHaveCount(0);
  await expect(page.getByLabel("Working copy line counts")).toHaveText("+39−0");
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
  await expect(page.getByLabel("Working copy line counts")).toHaveText("+38−0");
  assert.equal(queuedRequests.length, 1, "only one mutation may be in flight");
  await expect(
    page
      .getByRole("button", { name: "Show 10 lines above", exact: true })
      .first(),
  ).toHaveAttribute("aria-disabled", "true");
  // A new selection must survive earlier operations being acknowledged.
  await codeLine(queueLines[2].newLine!).click();
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
  await pressMutation("s");
  assert.equal(
    (await service.getState()).files.find(
      (file) => file.path === "src/long.ts",
    )!.additions,
    37,
  );
  await page.unroute("**/api/squash-lines");
  console.log(
    "✓ Instant speculative rows/counts, FIFO, fresh-version remapping, and selection survives ACKs/layout changes",
  );

  // First queued operation succeeds, second fails, third must never be dispatched.
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
  await page.route("**/api/squash-lines", async (route) => {
    failureRequests++;
    if (failureRequests === 1) {
      await gate;
      await route.continue();
    } else {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Injected queue failure" }),
      });
    }
  });
  for (const row of failLines) {
    await codeLine(row.newLine!).click();
    await page.keyboard.press("s");
  }
  await expect(page.getByRole("status")).toContainText("3 queued");
  await expect(page.getByLabel("Working copy line counts")).toHaveText("+34−0");
  releaseFailure();
  await expect(page.getByRole("alert")).toContainText(
    "Injected queue failure",
    { timeout: 15000 },
  );
  await expect(page.getByRole("status")).toContainText("Queue stopped");
  await expect(page.getByLabel("Working copy line counts")).toHaveText("+36−0");
  assert.equal(
    failureRequests,
    2,
    "failed second job is not retried; third is canceled",
  );
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
    "✓ Failure stops FIFO, cancels unsent jobs, and reloads actual diff/counts without replay",
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
    "describe", "-m", "Updated commit title\n\nDescription body",
  ]);
  const described = await refreshState();
  await expect(page).toHaveTitle(
    `jj-stamp ${described.source.changeId.slice(0, 8)}: Updated commit title`,
  );
  await jj(initial.repo.path, ["new", "-m", "Next change"]);
  const next = await refreshState();
  assert.notEqual(next.source.changeId, described.source.changeId);
  await expect(page).toHaveTitle(
    `jj-stamp ${next.source.changeId.slice(0, 8)}: Next change`,
  );
  console.log("✓ Page title follows the short change ID and commit title on refresh");
  assert(mutations.every((endpoint) => endpoint === "/api/squash-lines"));
  // Fixture edits intentionally race an outstanding read-only graph refresh.
  // Any 409 must be that guard, never an unexpected mutation/context failure.
  for (const rejected of rejectedReads)
    assert.deepEqual(rejected, { path: "/api/log", code: "STALE_STATE" });
  if (rejectedReads.length) {
    for (let i = 0; i < rejectedReads.length; i++) {
      const index = errors.findIndex((error) =>
        error.includes("409 (Conflict)"),
      );
      if (index >= 0) errors.splice(index, 1);
    }
  }
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
  await browser.close();
  await vite.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
