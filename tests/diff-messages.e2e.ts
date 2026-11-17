// Run with: npx tsx tests/diff-messages.e2e.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const directory = await mkdtemp(
  path.join(os.tmpdir(), "jj-stamp-diff-message-"),
);
const screenshots = path.resolve(
  process.env.JJ_STAMP_SCREENSHOTS ?? ".data/screenshots/diff-messages",
);
await mkdir(screenshots, { recursive: true });
const repoPath = await createDemo(directory);
const filename = "header-like.txt";
await writeFile(path.join(repoPath, filename), "-- before\n");
await jj(repoPath, ["commit", "-m", "Before header-like code edit"]);
await writeFile(path.join(repoPath, filename), "++ after\n");
const app = express();
app.use("/api", createApi(new ReviewService({ repoPath })));
const fixture = await createBrowserFixture({
  app,
  config: { "log-expanded": false },
  captureConsoleErrors: true,
});
try {
  const { page } = fixture;
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await page.goto(fixture.url);
  await page
    .locator(`.file-tree [role="treeitem"][data-item-path="${filename}"]`)
    .click();
  const notice = page.locator(".unsupported p");
  await expect(notice).toHaveText(
    "This patch contains header-like code lines that cannot be parsed safely.",
  );
  await expect(notice).not.toContainText(/native|editor/i);
  await expect(
    page.getByRole("button", { name: `Squash file ${filename}`, exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: path.join(screenshots, "unsupported-diff-plain-language.png"),
  });
  assert.deepEqual(fixture.errors, []);
  console.log("Diff message browser regression passed.");
} finally {
  await fixture.close();
  await rm(directory, { recursive: true, force: true });
}
