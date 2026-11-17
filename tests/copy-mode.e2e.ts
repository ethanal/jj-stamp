// Run with: npx tsx tests/copy-mode.e2e.ts
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import { expect as baseExpect } from "@playwright/test";
const expect = baseExpect.configure({ timeout: 30000 });
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createBrowserFixture } from "./browser-fixture.ts";

const repoPath = await mkdtemp(
  path.join(os.tmpdir(), "jj-stamp-copy-mode-browser-"),
);
const screenshots = path.resolve(
  process.env.JJ_STAMP_SCREENSHOTS ?? ".data/screenshots/copy-mode",
);
await mkdir(screenshots, { recursive: true });
await jj(repoPath, ["git", "init", "--no-colocate", "."]);
await jj(repoPath, ["config", "set", "--repo", "user.name", "Copy Mode Test"]);
await jj(repoPath, [
  "config",
  "set",
  "--repo",
  "user.email",
  "copy@example.com",
]);
await jj(repoPath, [
  "config",
  "set",
  "--repo",
  'revset-aliases."immutable_heads()"',
  "root()",
]);
const base = Array.from(
  { length: 24 },
  (_, i) => `export const value${i} = ${i};\n`,
).join("");
await writeFile(path.join(repoPath, "original.ts"), base);
await writeFile(
  path.join(repoPath, "run.sh"),
  "#!/bin/sh\nprintf 'ready\\n'\n",
);
await chmod(path.join(repoPath, "run.sh"), 0o644);
await jj(repoPath, ["commit", "-m", "Base files"]);
const original = base.replace("value0 = 0", "value0 = 100");
await writeFile(path.join(repoPath, "original.ts"), original);
await writeFile(
  path.join(repoPath, "copy.ts"),
  base
    .replace("value5 = 5", "value5 = 50")
    .replace("value20 = 20", "value20 = 200"),
);
await chmod(path.join(repoPath, "copy.ts"), 0o755);
await chmod(path.join(repoPath, "run.sh"), 0o755);
await jj(repoPath, [
  "describe",
  "-m",
  "Copy module and make scripts executable",
]);
const service = new ReviewService({ repoPath });
const before = await service.getState();
assert.equal(
  before.files.find((f) => f.path === "copy.ts")?.copyFrom,
  "original.ts",
);
const app = express();
app.use("/api", createApi(service));
const fixture = await createBrowserFixture({
  app,
  config: { "log-expanded": false },
  captureConsoleErrors: true,
});
const { page, errors, url } = fixture;
await page.addInitScript(() => {
  document.hasFocus = () => false;
});
const treeRow = (name: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${name}"]`);
const squashFile = (name: string) =>
  page.getByRole("button", { name: `Squash file ${name}`, exact: true });
const undo = () => page.getByRole("button", { name: "Undo", exact: true });
async function undoCompleted() {
  const response = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/undo") &&
      response.request().method() === "POST",
  );
  await undo().click();
  assert.equal((await response).status(), 200);
  await expect(page.getByRole("status")).toHaveText("Squash undone");
  await expect(
    page.getByRole("button", { name: "Refresh", exact: true }),
  ).toBeEnabled();
}
try {
  await page.goto(url, { timeout: 90000 });
  await treeRow("copy.ts").click();
  await expect(page.locator(".file-bar-filename")).toContainText(
    "original.ts → copy.ts",
  );
  await expect(page.locator(".rename-notice").first()).toContainText(
    "Copied and modified.",
  );
  await expect(page.locator(".rename-notice").last()).toContainText(
    "Make executable",
  );
  await expect(page.locator(".unsupported")).toHaveCount(0);
  await expect(squashFile("copy.ts")).toBeEnabled();
  await expect(
    page
      .locator('[data-line-type="change-addition"]')
      .filter({ hasText: "value5 = 50" })
      .last(),
  ).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "copy-and-executable-mode.png"),
  });
  await page
    .locator('[data-line-type="change-deletion"]')
    .filter({ hasText: "value5 = 5" })
    .last()
    .click();
  await page
    .locator('[data-line-type="change-addition"]')
    .filter({ hasText: "value5 = 50" })
    .last()
    .click({ modifiers: ["Shift"] });
  await page.keyboard.press("s");
  await expect(undo()).toBeEnabled();
  await expect(page.locator(".rename-notice")).toHaveCount(0);
  await expect(page.locator(".file-bar-filename")).toHaveText("copy.ts");
  const after = await service.getState();
  const parentCopy = (
    await jj(repoPath, [
      "file",
      "show",
      "-r",
      after.parent!.commitId,
      "--",
      "copy.ts",
    ])
  ).stdout;
  assert.equal(parentCopy, base.replace("value5 = 5", "value5 = 50"));
  assert.equal(
    (
      await jj(repoPath, [
        "file",
        "show",
        "-r",
        after.parent!.commitId,
        "--",
        "original.ts",
      ])
    ).stdout,
    base,
  );
  assert.equal(
    await readFile(path.join(repoPath, "original.ts"), "utf8"),
    original,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({
    path: path.join(screenshots, "copy-after-selected-hunk-squash.png"),
  });
  await undoCompleted();
  await treeRow("copy.ts").click();
  await expect(page.locator(".rename-notice").first()).toContainText(
    "Copied and modified.",
  );
  await squashFile("copy.ts").click();
  await expect(undo()).toBeEnabled();
  await expect(treeRow("copy.ts")).toHaveCount(0);
  await undoCompleted();
  await treeRow("run.sh").click();
  await expect(page.locator(".rename-notice")).toContainText(
    "Make executable (100644 → 100755)",
  );
  await expect(page.locator(".code-surface")).toHaveCount(0);
  await expect(squashFile("run.sh")).toBeEnabled();
  await page.screenshot({
    path: path.join(screenshots, "mode-only-file-squash.png"),
  });
  await squashFile("run.sh").click();
  await expect(undo()).toBeEnabled();
  await expect(treeRow("run.sh")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await undoCompleted();
  await treeRow("run.sh").click();
  await expect(page.locator(".rename-notice")).toContainText("Make executable");
  await page.getByRole("button", { name: "All files", exact: true }).click();
  await expect(squashFile("run.sh")).toBeEnabled();
  await squashFile("run.sh").click();
  await expect(undo()).toBeEnabled();
  await expect(treeRow("run.sh")).toHaveCount(0);
  await undoCompleted();
  await expect(squashFile("run.sh")).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "copy/mode browser checks passed (line/file squash, both views, undo, screenshots)",
  );
} finally {
  await fixture.close();
  await rm(repoPath, { recursive: true, force: true });
}
