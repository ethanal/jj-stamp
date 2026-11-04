// Capture the current, unmodified UI against an isolated jj fixture.
// Run from the repository root: npx tsx design/capture-pr-review.ts
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "../tests/browser-fixture.ts";
import { createDemo } from "../tests/fixtures.ts";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";

const temporary = await mkdtemp(path.join(tmpdir(), "jj-stamp-ui-study-"));
const repoPath = await createDemo(temporary);
const service = new ReviewService({ repoPath });
const app = express();
app.use("/api", createApi(service));
const fixture = await createBrowserFixture({
  app,
  viewport: { width: 1440, height: 760 },
});
try {
  const { page, url } = fixture;
  await page.addInitScript(() => {
    document.hasFocus = () => false;
    localStorage.setItem("jj-stamp.color-scheme", "dark");
    localStorage.setItem("jj-stamp.file-view", "single");
  });
  await page.goto(url);
  await expect(
    page.locator("[data-line-type='change-addition']").first(),
  ).toBeVisible();
  await expect(page.locator(".log-row").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const out = ".data/pr-review-capture";
  await mkdir(out, { recursive: true });
  const captures: Record<string, string> = {};
  for (const [name, selector] of [
    ["topbar", ".topbar"],
    ["workspace", ".workspace"],
    ["statusbar", ".statusbar"],
  ]) {
    const bytes = await page
      .locator(selector)
      .screenshot({ path: `${out}/${name}.png` });
    captures[name] = `data:image/png;base64,${bytes.toString("base64")}`;
  }
  // A real shorter viewport preserves the file sidebar's source → parent footer
  // when the proposed PR strip reserves 42px above the workspace.
  await page.setViewportSize({ width: 1440, height: 718 });
  const ribbon = await page.locator(".workspace").screenshot({
    path: `${out}/workspace-ribbon.png`,
  });
  captures["workspace-ribbon"] =
    `data:image/png;base64,${ribbon.toString("base64")}`;
  await page.setViewportSize({ width: 1440, height: 760 });
  await writeFile(
    `${out}/geometry.json`,
    JSON.stringify(
      await page.evaluate(() =>
        Object.fromEntries(
          [
            ".topbar",
            ".workspace",
            ".sidebar",
            ".viewer",
            ".log-panel",
            ".statusbar",
            ".toolbar-actions",
            ".statusbar-actions",
          ].map((selector) => {
            const { x, y, width, height } = document
              .querySelector(selector)!
              .getBoundingClientRect();
            return [selector, { x, y, width, height }];
          }),
        ),
      ),
      null,
      2,
    ),
  );
  assert.deepEqual(fixture.errors, []);
  const htmlPath = "design/pr-review-options.html";
  const html = await readFile(htmlPath, "utf8");
  assert(
    html.includes('id="captures"'),
    "Missing embedded capture placeholder",
  );
  await writeFile(
    htmlPath,
    html.replace(
      /(<script id="captures" type="application\/json">)[\s\S]*?(<\/script>)/,
      (_match, start, end) => `${start}${JSON.stringify(captures)}${end}`,
    ),
  );
  console.log(`Captured the actual UI in ${out}; fixture: ${repoPath}`);
} finally {
  await fixture.close();
  await service.drain();
}
