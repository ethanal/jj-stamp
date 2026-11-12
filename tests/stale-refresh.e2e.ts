import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-stale-"));
await using resources = new AsyncDisposableStack();
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const service = new ReviewService({ repoPath });
resources.defer(() => service.drain());
const router = createApi(service);
resources.defer(() => router.closeEvents());
const app = express();
let staleState = 1;
let staleGraph = 2;
let stateReads = 0;
let graphReads = 0;
let squashes = 0;
app.use("/api", (request, response, next) => {
  if (request.path === "/squash-lines") squashes++;
  const reject =
    request.path === "/state"
      ? (++stateReads, staleState-- > 0)
      : request.path === "/graph"
        ? (++graphReads, staleGraph-- > 0)
        : false;
  if (reject) {
    // Exercise old servers too: this message must never reach a read-only UI.
    response.status(409).json({
      error:
        "The repository changed. Refresh the diff and review your selection again; nothing was squashed.",
      code: "STALE_STATE",
    });
  } else next();
});
app.use("/api", router);
const fixture = await createBrowserFixture({ app });
resources.defer(() => fixture.close());
const { page, url, errors } = fixture;
// Only synthetic focus triggers reads, keeping retry budgets deterministic.
await page.addInitScript(() => {
  document.hasFocus = () => false;
});
const alerts = page.getByRole("alert");
const selected = page.locator("[data-line][data-fold-selected]");
const refresh = page.getByRole("button", { name: "Refresh", exact: true });
async function focus() {
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
}
async function settled() {
  await expect(refresh).toBeEnabled();
  await expect(page.locator(".statusbar")).not.toContainText("Refreshing");
}

// Startup reads race external writes with no selected lines or squash intent.
await page.goto(url);
await expect(page.locator(".code-surface")).toBeVisible();
await expect(page.locator(".log-change").first()).toBeVisible();
await settled();
assert.equal(stateReads, 2);
assert.equal(graphReads, 3);
await expect(alerts).toHaveCount(0);
await expect(selected).toHaveCount(0);
assert.equal(squashes, 0);

// A stale focus read recovers automatically without resetting an unchanged
// view, selection, or DOM (and therefore reading position).
await page.locator('[data-line-type="change-addition"]').first().click();
await expect(selected.first()).toBeVisible();
const selection = await selected.evaluateAll((lines) =>
  lines.map((line) => line.outerHTML),
);
const surface = await page.locator(".code-surface").elementHandle();
assert(surface);
let before = stateReads;
staleState = 1;
await focus();
await expect.poll(() => stateReads).toBe(before + 2);
await settled();
assert(await surface.evaluate((element) => element.isConnected));
assert.deepEqual(
  await selected.evaluateAll((lines) => lines.map((line) => line.outerHTML)),
  selection,
);
await expect(alerts).toHaveCount(0);

// When state really changed, retries publish fresh content and discard stale
// line selections. Graph races stay quiet even if all attempts fail.
const filename = path.join(repoPath, "src/notifications.ts");
await writeFile(
  filename,
  (await readFile(filename, "utf8")) + "\n// automatic stale recovery\n",
);
before = stateReads;
const graphsBefore = graphReads;
staleState = 1;
staleGraph = Infinity;
await focus();
await expect.poll(() => stateReads).toBe(before + 2);
await expect(page.locator(".code-surface")).toContainText(
  "// automatic stale recovery",
);
await expect(selected).toHaveCount(0);
await expect(page.locator(".statusbar")).toContainText("selection cleared");
await expect.poll(() => graphReads).toBe(graphsBefore + 3);
await settled();
await expect(alerts).toHaveCount(0);

// Continued churn has bounded reads, no background alert, and no polling loop.
before = stateReads;
staleState = Infinity;
await focus();
await expect.poll(() => stateReads).toBe(before + 3);
await settled();
await expect(alerts).toHaveCount(0);
await page.waitForTimeout(1_000);
assert.equal(stateReads, before + 3);
assert.equal(squashes, 0, "read recovery must never dispatch a mutation");

// A later focus event still recovers; failures have not poisoned refresh.
staleState = 0;
staleGraph = 0;
before = stateReads;
const graphsBeforeRecovery = graphReads;
await focus();
await expect.poll(() => stateReads).toBe(before + 1);
await expect.poll(() => graphReads).toBe(graphsBeforeRecovery + 1);
await settled();
await expect(alerts).toHaveCount(0);

// A real squash can race an editor save after selection. The server must reject
// the old version, then the UI may refresh reads but must never replay the POST.
staleState = 0;
staleGraph = 0;
const squash = page.getByRole("button", { name: "Squash", exact: true });
await page.locator('[data-line-type="change-addition"]').first().click();
await expect(selected).toHaveCount(1);
await expect(squash).toBeEnabled();
const savedContents = await readFile(filename, "utf8");
await writeFile(filename, savedContents + "\n// stale squash recovery\n");
// No jj command, focus event or state read snapshots this edit before the POST.
before = stateReads;
const rejected = page.waitForResponse("**/api/squash-lines");
const recovery = page.waitForResponse("**/api/state");
await squash.click();
const rejectedResponse = await rejected;
assert.equal(rejectedResponse.status(), 409);
assert.equal((await rejectedResponse.json()).code, "STALE_STATE");
const staleVersion = rejectedResponse.request().postDataJSON().version;
const recoveryResponse = await recovery;
assert.equal(recoveryResponse.status(), 200);
const freshState = await recoveryResponse.json();
assert.notEqual(freshState.version, staleVersion);
await expect(page.locator(".code-surface")).toContainText(
  "// stale squash recovery",
);
await expect(selected).toHaveCount(0);
await expect(alerts).toHaveCount(0);
await expect(page.locator(".statusbar")).toContainText(
  "Nothing was squashed by the rejected request",
);
await expect(squash).toBeDisabled();
await settled();
assert.equal(stateReads, before + 1);
assert.equal(squashes, 1);
await page.waitForTimeout(500);
assert.equal(squashes, 1, "the rejected squash must never be replayed");
assert.equal(stateReads, before + 1, "recovery must not start a polling loop");
assert.equal(
  await readFile(filename, "utf8"),
  savedContents + "\n// stale squash recovery\n",
);

// No manual refresh or error dismissal is needed. A fresh, explicit selection
// uses the refreshed repository version and can squash successfully.
await page
  .locator('[data-line-type="change-addition"]')
  .filter({ hasText: "// stale squash recovery" })
  .click();
await expect(selected).toHaveCount(1);
await expect(squash).toBeEnabled();
const accepted = page.waitForResponse("**/api/squash-lines");
await squash.click();
const acceptedResponse = await accepted;
assert.equal(acceptedResponse.status(), 200);
assert.equal(
  acceptedResponse.request().postDataJSON().version,
  freshState.version,
);
assert.equal((await acceptedResponse.json()).warning, undefined);
await expect(page.locator(".statusbar")).toContainText("1 line squashed.");
await expect(selected).toHaveCount(0);
await expect(alerts).toHaveCount(0);
await settled();
assert.equal(squashes, 2, "only the two explicit squash actions send POSTs");
assert.deepEqual(errors, []);
console.log(
  "Stale recovery: quiet bounded read retries, preserved selection, real squash rejection without replay and explicit fresh squash passed.",
);
