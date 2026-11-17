// Run with: npx tsx tests/narrow-layout.e2e.ts
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { DiffFile, RepoState } from "../src/types.ts";

const filename = "content/posts/2026-11-15-jj-primer.md";
const rows: DiffFile["hunks"][number]["rows"] = [
  { index: 1, raw: " # Jujutsu primer", oldLine: 1, newLine: 1 },
  { index: 2, raw: " ", oldLine: 2, newLine: 2 },
  { index: 3, raw: "-Configure the repository.", oldLine: 3 },
  { index: 4, raw: "+Configure your user settings.", newLine: 3 },
  ...Array.from({ length: 30 }, (_, index) => ({
    index: index + 5,
    raw: ` Review step ${index + 1}`,
    oldLine: index + 4,
    newLine: index + 4,
  })),
];
const header = "@@ -1,33 +1,33 @@";
const source = {
  changeId: "ttmloswsabcdefgh",
  commitId: "90d0490123456789",
  description: "Review configuration documentation",
};
const parent = {
  changeId: "sxlqolsuabcdefgh",
  commitId: "0123456789abcdef",
  description: "Documentation",
};
const state: RepoState = {
  repo: { name: "docs", path: "/docs" },
  version: "fixture-v1",
  operation: "fixture-op",
  source,
  parent,
  targets: [parent],
  canUndo: false,
  files: [
    {
      path: filename,
      additions: 1,
      deletions: 1,
      hunks: [{ id: "primer", header, rows }],
      patch: [
        `diff --git a/${filename} b/${filename}`,
        `--- a/${filename}`,
        `+++ b/${filename}`,
        header,
        ...rows.map((row) => row.raw),
        "",
      ].join("\n"),
    },
  ],
};
const app = express();
app.get("/api/state", (_request, response) => response.json(state));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: state.version,
    rows: [
      { graph: "@  ", revision: source, mutable: true },
      { graph: "○  ", revision: parent, mutable: true },
    ],
  }),
);
const fixture = await createBrowserFixture({
  app,
  config: {
    "files-expanded": false,
    "color-scheme": "solarized-light",
  },
  viewport: { width: 569, height: 900 },
});
const { page } = fixture;
const screenshots = process.env.JJ_STAMP_SCREENSHOTS;
async function screenshot(name: string) {
  if (!screenshots) return;
  await mkdir(screenshots, { recursive: true });
  await page.screenshot({ path: path.join(screenshots, name) });
}
try {
  await page.goto(fixture.url);
  await expect(page.locator(".file-bar-filename")).toHaveText(filename);
  await expect(page.locator("[data-line]").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await screenshot("narrow-569px.png");

  for (const fontSize of [13, 24]) {
    await page.request.post(`${fixture.url}/api/config`, {
      data: { "font-size": fontSize },
    });
    await expect(page.locator("html")).toHaveCSS("font-size", `${fontSize}px`);
    for (const view of ["One file", "All files"]) {
      await page.getByRole("button", { name: view, exact: true }).click();
      for (const width of [569, 320, 390, 600, 601, 850, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const button of [
          page.locator(".squash-destination-trigger"),
          page.getByRole("button", { name: "Open revision", exact: true }),
          page.getByRole("button", { name: "Settings", exact: true }),
        ])
          await expect(button).toHaveCSS("font-size", `${fontSize}px`);
        const geometry = await page.locator(".file-bar").evaluate((bar) => {
          const title = bar.querySelector(".file-bar-title")!;
          const tools = bar.querySelector(".file-bar-tools")!;
          return {
            bar: bar.getBoundingClientRect().toJSON(),
            title: title.getBoundingClientRect().toJSON(),
            tools: tools.getBoundingClientRect().toJSON(),
            basis: getComputedStyle(title).flexBasis,
          };
        });
        const label = `${width}px, font ${fontSize}px, ${view}`;
        assert(
          geometry.title.height <= fontSize + 12,
          `${label}: title inflated to ${geometry.title.height}px`,
        );
        assert(
          geometry.title.left >= geometry.bar.left &&
            geometry.title.right <= geometry.bar.right,
          `${label}: title overflows the header`,
        );
        if (width <= 600) {
          assert(
            Math.abs(geometry.tools.top - geometry.title.bottom - 5) < 1,
            `${label}: extra space between title and controls`,
          );
          assert(
            geometry.bar.height <=
              geometry.title.height + geometry.tools.height + 16,
            `${label}: extra vertical space in header`,
          );
        } else {
          assert.equal(geometry.basis, "240px", label);
        }
        if (width === 320 && fontSize === 13 && view === "One file")
          await screenshot("narrow-320px.png");
      }
    }
  }
  assert.deepEqual(fixture.errors, []);
  console.log(
    "Narrow layout browser regression passed: 7 widths, 2 font sizes, both file views.",
  );
} finally {
  await fixture.close();
}
