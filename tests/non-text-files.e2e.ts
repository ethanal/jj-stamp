import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import express from "express";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApi } from "../server/api.ts";
import { jj } from "../server/process.ts";
import { ReviewService } from "../server/service.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-non-text-"));
const screenshots = path.resolve(
  process.env.JJ_STAMP_SCREENSHOTS ?? ".data/screenshots/non-text-files",
);
await mkdir(screenshots, { recursive: true });
const repoPath = await createDemo(directory);
await writeFile(path.join(repoPath, "logo.png"), Buffer.from("old\0image"));
await writeFile(path.join(repoPath, "removed.bin"), Buffer.from("old\0data"));
await writeFile(path.join(repoPath, "mode.sh"), "echo unchanged\n");
await jj(repoPath, ["commit", "-m", "Add project assets"]);
await writeFile(path.join(repoPath, "logo.png"), Buffer.from("new\0image"));
await writeFile(path.join(repoPath, "added.bin"), Buffer.from("new\0data"));
await rm(path.join(repoPath, "removed.bin"));
await chmod(path.join(repoPath, "mode.sh"), 0o755);
await symlink("logo.png", path.join(repoPath, "asset-link"));
await writeFile(
  path.join(repoPath, "notes.txt"),
  "Review the updated assets.\n",
);
await jj(repoPath, ["describe", "-m", "Update project assets"]);
const service = new ReviewService({ repoPath });
const app = express();
app.use("/api", createApi(service));
const fixture = await createBrowserFixture({
  app,
  config: { "files-width": 300, "log-expanded": false },
  viewport: { width: 1440, height: 900 },
});
const { page, url, errors } = fixture;
const treeRow = (name: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${name}"]`);
const section = (name: string) =>
  page.locator(`.file-diff-section[data-file-path="${name}"]`);
const mutations: string[] = [];
page.on("request", (request) => {
  if (/\/api\/(?:squash|preview)/.test(request.url()))
    mutations.push(request.url());
});

try {
  await page.goto(url);
  await treeRow("logo.png").click();
  await expect(section("logo.png").locator(".unsupported")).toBeVisible();
  await page.screenshot({
    path: path.join(screenshots, "non-text-file-single.png"),
  });
  for (const name of ["logo.png", "added.bin", "removed.bin"]) {
    await expect(treeRow(name)).toContainText("Binary");
    await expect(treeRow(name)).not.toContainText("+0");
    await expect(treeRow(name)).not.toContainText("−0");
    await expect(treeRow(name)).not.toContainText("·");
    await treeRow(name).click();
    await expect(section(name).getByRole("heading")).toHaveText("Binary file");
    await expect(section(name).locator(".unsupported p")).toHaveText(
      "Squashing is unavailable.",
    );
    await expect(section(name).locator(".code-surface")).toHaveCount(0);
    await expect(page.locator(".file-bar .line-counts")).toHaveCount(0);
    await expect(
      section(name).getByRole("button", { name: `Squash file ${name}` }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: `Squash file ${name}`, exact: true }),
    ).toBeDisabled();
    await expect(section(name).locator("details, summary, pre")).toHaveCount(0);
    await expect(section(name)).not.toContainText("diff --git");
  }
  // Git statuses still describe binary additions, deletions and modifications.
  await expect(treeRow("added.bin")).toContainText("A");
  await expect(treeRow("removed.bin")).toContainText("D");
  await expect(treeRow("logo.png")).toContainText("M");

  for (const name of ["asset-link"]) {
    await expect(treeRow(name)).toContainText("Read-only");
    await treeRow(name).click();
    await expect(section(name).getByRole("heading")).toHaveText(
      "Text diff unavailable",
    );
    await expect(section(name).locator(".unsupported")).not.toContainText(
      "Binary file",
    );
    await expect(section(name).locator("details, summary, pre")).toHaveCount(0);
    await expect(section(name)).not.toContainText("diff --git");
  }
  await treeRow("mode.sh").click();
  await expect(treeRow("mode.sh")).not.toContainText("Read-only");
  await expect(section("mode.sh").locator(".unsupported")).toHaveCount(0);
  await expect(section("mode.sh").locator(".rename-notice")).toContainText(
    "Make executable",
  );
  await expect(
    page.getByRole("button", { name: "Squash file mode.sh", exact: true }),
  ).toBeEnabled();
  await treeRow("notes.txt").click();
  await expect(treeRow("notes.txt")).toContainText("+1");
  await expect(treeRow("notes.txt")).not.toContainText("Read-only");
  await expect(section("notes.txt").locator(".code-surface")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Squash file notes.txt", exact: true }),
  ).toBeEnabled();

  await page.getByRole("button", { name: "All files", exact: true }).click();
  await expect(
    page.locator(".unsupported details, .unsupported pre"),
  ).toHaveCount(0);
  await expect(page.getByText("View raw patch", { exact: true })).toHaveCount(
    0,
  );
  for (const name of ["logo.png", "added.bin", "removed.bin"]) {
    await expect(section(name).locator(".file-diff-heading")).toContainText(
      "Binary",
    );
    await expect(section(name).locator(".line-counts")).toHaveCount(0);
  }
  await page.locator(".viewer-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: path.join(screenshots, "non-text-files-all.png"),
  });
  await page.getByRole("button", { name: "One file", exact: true }).click();
  await treeRow("logo.png").click();
  await page.screenshot({
    path: path.join(screenshots, "non-text-file-single.png"),
  });
  await page.keyboard.press("s");
  assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []);
  console.log(
    `Non-text file browser checks passed. Screenshots: ${screenshots}`,
  );
} finally {
  await fixture.close();
  await service.drain();
  await rm(directory, { recursive: true, force: true });
}
