import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const directory = await mkdtemp(
  path.join(tmpdir(), "jj-stamp-rename-browser-"),
);
const screenshots = path.resolve(".data/screenshots/renamed-files");
await mkdir(screenshots, { recursive: true });
const repoPath = await createDemo(directory);
await jj(repoPath, ["commit", "-m", "Polish notification delivery"]);
const oldPath = "src/notifications.ts";
const newPath = "src/delivery.ts";
const original = await readFile(path.join(repoPath, oldPath), "utf8");
await rename(path.join(repoPath, oldPath), path.join(repoPath, newPath));
await writeFile(
  path.join(repoPath, newPath),
  original
    .replace("MAX_ATTEMPTS = 3", "MAX_ATTEMPTS = 5")
    .replace("RETRY_DELAY_MS = 500", "RETRY_DELAY_MS = 250")
    .replace(
      "return notification.id;",
      "return `${notification.channel}:${notification.id}`;",
    ),
);
await rename(
  path.join(repoPath, "src/preferences.ts"),
  path.join(repoPath, "src/settings.ts"),
);
await writeFile(
  path.join(repoPath, "README.md"),
  "# Notification delivery\n\nRetry delivery with a channel-specific key.\n",
);
await jj(repoPath, [
  "describe",
  "-m",
  "Rename delivery module and tune retries",
]);
const service = new ReviewService({ repoPath });
const state = await service.getState();
assert.equal(
  state.files.find((file) => file.path === newPath)?.oldPath,
  oldPath,
);
const app = express();
app.use("/api", createApi(service));
const fixture = await createBrowserFixture({
  app,
  viewport: { width: 1600, height: 1000 },
  captureConsoleErrors: true,
});
const { page, url, errors } = fixture;
await page.addInitScript(() => {
  document.hasFocus = () => false;
  localStorage.setItem("jj-stamp.files-width", "280");
  localStorage.setItem("jj-stamp.log-expanded", "false");
});
const mutations: string[] = [];
page.on("request", (request) => {
  if (/\/api\/(squash|preview)/.test(request.url()))
    mutations.push(request.url());
});
const treeRow = (name: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${name}"]`);
const changedLine = (value: string) =>
  page
    .locator('[data-line-type="change-addition"]')
    .filter({ hasText: value })
    .last();
try {
  await page.goto(url);
  await treeRow(newPath).click();
  await expect(page.locator(".file-bar-filename")).toHaveText(
    `${oldPath} → ${newPath}`,
  );
  await expect(treeRow(newPath)).toContainText("R");
  await expect(page.locator(".rename-notice")).toContainText(
    "Renamed and modified.",
  );
  await expect(page.locator(".unsupported")).toHaveCount(0);
  await expect(changedLine("MAX_ATTEMPTS = 5")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Squash file ${newPath}`, exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".code-surface")).toHaveAttribute(
    "aria-label",
    /Read-only diff/,
  );

  // Renamed sides hydrate from distinct paths, including collapsed old-side context.
  await page.locator("[data-expand-button]").first().click();
  await expect(page.locator('[data-line="10"]').last()).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(changedLine("MAX_ATTEMPTS = 5")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "renamed-modified-split.png"),
  });

  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await expect(changedLine("RETRY_DELAY_MS = 250")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "renamed-modified-stacked.png"),
  });

  // Search still navigates rendered rename hunks.
  await page.keyboard.press("Control+f");
  await page
    .getByRole("searchbox", { name: "Search diff" })
    .fill("MAX_ATTEMPTS");
  await expect(page.locator(".diff-search-count")).toHaveText("1 / 2");
  await page.keyboard.press("Escape");
  await page.keyboard.press("s");
  await expect(page.getByRole("alert")).toContainText(/renam/i);
  assert.deepEqual(mutations, []);
  await page.getByRole("button", { name: "Dismiss error" }).click();

  await treeRow("src/settings.ts").click();
  await expect(page.locator(".file-bar-filename")).toHaveText(
    "src/preferences.ts → src/settings.ts",
  );
  await expect(page.locator(".rename-notice")).toContainText(
    "Renamed without content changes.",
  );
  await expect(page.locator(".code-surface")).toHaveCount(0);

  await page.getByRole("button", { name: "All files", exact: true }).click();
  await expect(page.locator(`[data-file-path="${newPath}"] h2`)).toHaveText(
    `${oldPath} → ${newPath}`,
  );
  await expect(
    page.locator('[data-file-path="src/settings.ts"] h2'),
  ).toHaveText("src/preferences.ts → src/settings.ts");
  await expect(
    page.getByRole("button", { name: "Squash file README.md", exact: true }),
  ).toBeEnabled();
  await page.locator(".viewer-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(screenshots, "renamed-files-overview.png"),
  });
  assert.deepEqual(errors, []);
  console.log(`Rename browser regression passed. Screenshots: ${screenshots}`);
} finally {
  await fixture.close();
  await service.drain();
  await rm(directory, { recursive: true, force: true });
}
