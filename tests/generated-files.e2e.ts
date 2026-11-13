import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { DiffFile, RepoState } from "../src/types";

function changedFile(path: string, generated = false): DiffFile {
  return {
    path,
    generated,
    additions: 1,
    deletions: 1,
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      "-old contents",
      `+new contents of ${path}`,
      "",
    ].join("\n"),
    hunks: [
      {
        id: `hunk:${path}`,
        header: "@@ -1 +1 @@",
        rows: [
          { index: 1, raw: "-old contents", oldLine: 1 },
          { index: 2, raw: `+new contents of ${path}`, newLine: 1 },
        ],
      },
    ],
  };
}

const generatedPath = "generated.ts";
const ordinaryPath = "ordinary.ts";
let state: RepoState = {
  repo: { name: "generated-files", path: "/tmp/generated-files" },
  version: "v1",
  operation: "op1",
  source: {
    changeId: "generatedchange",
    commitId: "0123456789abcdef",
    description: "Generated file fixture",
  },
  parent: null,
  targets: [],
  squashUnavailable: "Read-only fixture",
  files: [changedFile(generatedPath, true), changedFile(ordinaryPath)],
  canUndo: false,
};

const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => response.json(state));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: state.version,
    rows: [{ graph: "@  ", revision: state.source }],
  }),
);

const fixture = await createBrowserFixture({ app });
const { page, url, errors } = fixture;
const section = (path: string) =>
  page.locator(`.file-diff-section[data-file-path="${path}"]`);
const expand = (path: string) =>
  section(path).getByRole("button", {
    name: `Expand file ${path}`,
    exact: true,
  });
const collapse = (path: string) =>
  section(path).getByRole("button", {
    name: `Collapse file ${path}`,
    exact: true,
  });
const diff = (path: string) => section(path).locator(".code-surface");
const oneFile = page.getByRole("button", { name: "One file", exact: true });
const allFiles = page.getByRole("button", { name: "All files", exact: true });
const treeRow = (path: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${path}"]`);

try {
  await page.goto(url);
  // Generated files remain listed, but no diff renderer mounts until expanded,
  // including the default one-file view.
  await expect(treeRow(generatedPath)).toBeVisible();
  await expect(expand(generatedPath)).toHaveAttribute("aria-expanded", "false");
  await expect(
    section(generatedPath).getByText("Generated", { exact: true }),
  ).toBeVisible();
  await expect(diff(generatedPath)).toHaveCount(0);
  await expand(generatedPath).focus();
  await page.keyboard.press("Enter");
  await expect(diff(generatedPath)).toBeVisible();

  // Explicit expansion survives view switches and revision rewrites/refresh.
  await allFiles.click();
  await expect(diff(generatedPath)).toBeVisible();
  await expect(diff(ordinaryPath)).toBeVisible();
  state = {
    ...state,
    version: "v2",
    source: { ...state.source, commitId: "abcdef0123456789" },
  };
  await page.keyboard.press("r");
  await expect(collapse(generatedPath)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await collapse(generatedPath).click();
  await oneFile.click();
  await expect(expand(generatedPath)).toHaveAttribute("aria-expanded", "false");

  // Search can reveal hidden generated content and keeps it expanded afterward.
  await page.keyboard.press("Control+f");
  await page
    .getByRole("searchbox", { name: "Search diff" })
    .fill(`new contents of ${generatedPath}`);
  await expect(diff(generatedPath)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(collapse(generatedPath)).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await collapse(generatedPath).click();
  await treeRow(ordinaryPath).click();
  await expect(diff(ordinaryPath)).toBeVisible();
  await expect(section(ordinaryPath).locator(".file-collapse")).toHaveCount(0);

  // Defaults also apply to files newly marked generated after a refresh.
  state = {
    ...state,
    version: "v3",
    source: { ...state.source, commitId: "abcdef0123456780" },
    files: state.files.map((file) => ({ ...file, generated: true })),
  };
  await page.keyboard.press("r");
  await expect(expand(ordinaryPath)).toHaveAttribute("aria-expanded", "false");

  // A different change resets manual choices to the attribute defaults.
  await expand(ordinaryPath).click();
  state = {
    ...state,
    version: "v4",
    source: {
      ...state.source,
      changeId: "otherchange",
      commitId: "abcdef0123456781",
    },
  };
  await page.keyboard.press("r");
  await expect(expand(ordinaryPath)).toHaveAttribute("aria-expanded", "false");
  await allFiles.click();
  await expect(expand(generatedPath)).toHaveAttribute("aria-expanded", "false");
  assert.deepEqual(errors, []);
  console.log("Generated file collapse and reveal checks passed");
} finally {
  await fixture.close();
}
