// Run with: npx tsx tests/file-view.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { createBrowserFixture } from "./browser-fixture.ts";
import { expect, type Locator } from "@playwright/test";
import { projectSquash, refsFromSelection } from "../src/optimistic";
import type { DiffFile, RepoState, Selections } from "../src/types";

const source = {
  changeId: "fileviewchangeid",
  changeIdPrefix: "file",
  commitId: "0123456789abcdef",
  description: "Exercise file view modes",
  author: "Fixture Author",
};
const parent = {
  changeId: "parentchangeid",
  changeIdPrefix: "pare",
  commitId: "fedcba9876543210",
  description: "Fixture parent",
};

function longFile(path: string, changedLines: number[]): DiffFile {
  const length = 120;
  const changed = new Set(changedLines);
  const rows: DiffFile["hunks"][number]["rows"] = [];
  for (let line = 1; line <= length; line++) {
    if (changed.has(line)) {
      rows.push({
        index: rows.length + 1,
        raw: `-original ${path} line ${line}`,
        oldLine: line,
      });
      rows.push({
        index: rows.length + 1,
        raw: `+updated ${path} line ${line}`,
        newLine: line,
      });
    } else {
      rows.push({
        index: rows.length + 1,
        raw: ` unchanged ${path} line ${line}`,
        oldLine: line,
        newLine: line,
      });
    }
  }
  const hunk = {
    id: `hunk:${path}`,
    header: `@@ -1,${length} +1,${length} @@`,
    rows,
  };
  return {
    path,
    additions: changedLines.length,
    deletions: changedLines.length,
    hunks: [hunk],
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      hunk.header,
      ...rows.map((row) => row.raw),
      "",
    ].join("\n"),
  };
}

const firstPath = "src/long-alpha.ts";
const secondPath = "tests/long-beta.ts";
const unsupportedPath = "vendor/archive.bin";
const firstFile = longFile(
  firstPath,
  Array.from({ length: 10 }, (_, index) => (index + 1) * 10),
);
const secondFile = longFile(
  secondPath,
  Array.from({ length: 11 }, (_, index) => (index + 1) * 10),
);
const unsupportedFile: DiffFile = {
  path: unsupportedPath,
  additions: 0,
  deletions: 0,
  patch: "",
  hunks: [],
  unsupported: "Binary files cannot be reviewed line by line.",
};
const initialState: RepoState = {
  repo: { name: "file-view-fixture", path: "/tmp/file-view-fixture" },
  version: "fixture-v1",
  source,
  parent,
  targets: [parent],
  files: [firstFile, secondFile, unsupportedFile],
  operation: "fixture-op-1",
  canUndo: false,
};
type SquashInput = {
  version: string;
  selections: { id: string; lines: number[] }[];
};
let serverState = structuredClone(initialState);
let squashRefs: ReturnType<typeof refsFromSelection> = [];
const squashInputs: SquashInput[] = [];

const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => response.json(serverState));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: serverState.version,
    rows: [{ graph: "@  ", revision: source, mutable: true }],
  }),
);
app.post("/api/squash-lines", (request, response) => {
  const squashInput = request.body as SquashInput;
  squashInputs.push(squashInput);
  const selected = Object.fromEntries(
    squashInput.selections.map((spec) => [spec.id, spec.lines]),
  ) as Selections;
  squashRefs = refsFromSelection(serverState, selected);
  serverState = {
    ...projectSquash(serverState, squashRefs),
    version: `fixture-v${squashInputs.length + 1}`,
    operation: `fixture-op-${squashInputs.length + 1}`,
    canUndo: true,
  };
  response.json({ state: serverState });
});

const fixture = await createBrowserFixture({
  app,
});
const { page, url, errors } = fixture;

const section = (path: string) =>
  page.locator(`.file-diff-section[data-file-path="${path}"]`);
const treeRow = (path: string) =>
  page.locator(`.file-tree [role="treeitem"][data-item-path="${path}"]`);
const addition = (path: string, line: number): Locator =>
  section(path)
    .locator(`[data-line="${line}"][data-line-type="change-addition"]`)
    .last();
const selectedRows = (path: string) =>
  section(path).locator("[data-line][data-fold-selected]");

try {
  await page.goto(url);

  const oneFile = page.getByRole("button", { name: "One file", exact: true });
  const allFiles = page.getByRole("button", { name: "All files", exact: true });
  await expect(oneFile).toHaveAttribute("aria-pressed", "true");
  await expect(allFiles).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".file-bar")).toContainText(firstPath);
  await expect(page.locator(".file-diff-section")).toHaveCount(1);
  await expect(section(firstPath)).toBeVisible();
  await expect(page.locator(".file-diff-heading")).toHaveCount(0);
  await expect(page.getByLabel("jj log output")).toHaveCSS(
    "padding-left",
    "20px",
  );

  const currentLog = page.locator(".log-row.is-current");
  await expect(currentLog).toBeVisible();
  const graphInset = await currentLog.evaluate(
    (row) =>
      row.firstElementChild!.getBoundingClientRect().left -
      row.getBoundingClientRect().left,
  );
  assert(
    graphInset >= 4,
    "The @ marker needs padding inside the highlighted row",
  );

  await allFiles.click();
  await expect(allFiles).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".file-bar")).toContainText("All changed files");
  await expect(page.locator(".file-diff-section")).toHaveCount(3);
  for (const [path, counts] of [
    [firstPath, "+10−10"],
    [secondPath, "+11−11"],
    [unsupportedPath, "+0−0"],
  ] as const) {
    await expect(section(path).locator(".file-diff-heading h2")).toHaveText(
      path,
    );
    await expect(
      section(path).locator(".file-diff-heading .line-counts"),
    ).toHaveText(counts);
  }
  await expect(section(unsupportedPath).locator(".unsupported")).toContainText(
    "Binary files cannot be reviewed line by line.",
  );
  await expect(section(unsupportedPath).locator("diffs-container")).toHaveCount(
    0,
  );

  const viewport = page.locator(".viewer-scroll");
  await treeRow(secondPath).click();
  await expect(treeRow(secondPath)).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".file-diff-section")).toHaveCount(3);
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(100);
  await expect
    .poll(async () => {
      const viewportBox = await viewport.boundingBox();
      const sectionBox = await section(secondPath).boundingBox();
      assert(viewportBox && sectionBox);
      return Math.abs(sectionBox.y - viewportBox.y);
    })
    .toBeLessThanOrEqual(2);

  await treeRow(firstPath).click();
  await expect(treeRow(firstPath)).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBe(0);

  // Each heading sticks to the viewport, then yields to the next file.
  await viewport.evaluate((element) => {
    element.scrollTop = 300;
  });
  await expect
    .poll(async () => {
      const heading = await section(firstPath)
        .locator(".file-diff-heading")
        .boundingBox();
      const view = await viewport.boundingBox();
      assert(heading && view);
      return Math.abs(heading.y - view.y);
    })
    .toBeLessThanOrEqual(2);
  await treeRow(secondPath).click();
  await viewport.evaluate((element) => {
    element.scrollTop += 300;
  });
  await expect
    .poll(async () => {
      const heading = await section(secondPath)
        .locator(".file-diff-heading")
        .boundingBox();
      const view = await viewport.boundingBox();
      assert(heading && view);
      return Math.abs(heading.y - view.y);
    })
    .toBeLessThanOrEqual(2);
  await expect(
    section(unsupportedPath).getByRole("button", {
      name: `Squash file ${unsupportedPath}`,
      exact: true,
    }),
  ).toBeDisabled();

  await addition(firstPath, 80).click();
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await expect(selectedRows(firstPath)).toHaveCount(1);
  await expect(selectedRows(secondPath)).toHaveCount(0);

  // Shift on another file must not extend the old file's range. If line 80's
  // anchor leaked, this click would select every beta change from 20 through 80.
  await addition(secondPath, 20).click({ modifiers: ["Shift"] });
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await expect(selectedRows(firstPath)).toHaveCount(0);
  await expect(selectedRows(secondPath)).toHaveCount(1);
  await expect(addition(secondPath, 20)).toHaveAttribute(
    "data-fold-selected",
    "",
  );
  await expect(treeRow(secondPath)).toHaveAttribute("aria-selected", "true");

  await oneFile.click();
  await expect(page.locator(".file-diff-section")).toHaveCount(1);
  await expect(section(secondPath)).toBeVisible();
  await expect(selectedRows(secondPath)).toHaveCount(1);
  await expect(page.getByRole("status")).toContainText(
    "1 changed line selected",
  );
  await allFiles.click();
  await expect(page.locator(".file-diff-section")).toHaveCount(3);
  // Both remounted renderers must finish expanding before checking the scroll
  // result: the first file growing asynchronously must not push the active
  // second file back out of view.
  await expect(addition(firstPath, 10)).toBeAttached();
  await expect(addition(secondPath, 20)).toBeAttached();
  await expect
    .poll(() =>
      section(firstPath).evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
    )
    .toBeGreaterThan(600);
  await expect(
    section(secondPath).locator(".file-diff-heading"),
  ).toBeInViewport();
  await expect(selectedRows(firstPath)).toHaveCount(0);
  await expect(selectedRows(secondPath)).toHaveCount(1);
  await expect(treeRow(secondPath)).toHaveAttribute("aria-selected", "true");

  await page.locator(".file-bar").click();
  await page.keyboard.press("f");
  await expect(section(secondPath).locator(".code-surface")).toBeFocused();

  const originalFirstPatch = initialState.files[0].patch;
  const squashResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/squash-lines"),
  );
  await page.keyboard.press("s");
  assert.equal((await squashResponse).status(), 200);
  await expect(page.locator(".queue-count")).toHaveCount(0);
  assert.equal(squashInputs.length, 1);
  const [squashInput] = squashInputs;
  assert.deepEqual(
    [...new Set(squashRefs.map((ref) => ref.path))],
    [secondPath],
  );
  assert.deepEqual(
    squashInput.selections.map((selection) => selection.id),
    [`hunk:${secondPath}`],
  );
  assert.equal(
    serverState.files.find((file) => file.path === firstPath)?.patch,
    originalFirstPatch,
  );
  await expect(page.getByRole("status")).toContainText("1 line squashed");

  await page.reload();
  await expect(allFiles).toHaveAttribute("aria-pressed", "true");
  await expect(oneFile).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".file-diff-section")).toHaveCount(3);

  const sidebarSquash = page.locator(".file-tree-squash");
  await treeRow(unsupportedPath).hover();
  await expect(sidebarSquash).toBeDisabled();
  await expect(sidebarSquash).toHaveAttribute(
    "title",
    unsupportedFile.unsupported!,
  );
  await page.locator('.file-tree [data-item-path="vendor/"]').hover();
  await expect(sidebarSquash).toHaveCount(0);

  // Keyboard users can reach the same action without navigating to that file.
  await page.locator(".file-bar").hover();
  await treeRow(secondPath).focus();
  await page.keyboard.press("Tab");
  await expect(sidebarSquash).toBeFocused();
  await expect(sidebarSquash).toHaveAttribute(
    "aria-label",
    `Squash file ${secondPath}`,
  );
  await page.keyboard.press("Escape");
  await expect(treeRow(secondPath)).toBeFocused();

  // A whole-file action ignores the active line selection in another file.
  await addition(firstPath, 10).click();
  await section(secondPath)
    .getByRole("button", { name: `Squash file ${secondPath}`, exact: true })
    .click();
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(section(secondPath)).toHaveCount(0);
  assert.equal(squashInputs.length, 2);
  assert.equal(
    squashRefs.length,
    21,
    "Only the remaining changes after the earlier partial squash",
  );
  assert(squashRefs.every((ref) => ref.path === secondPath));
  assert.equal(serverState.files[0].patch, originalFirstPatch);

  // Restore to exercise the one-file header and the sidebar separately.
  serverState = {
    ...structuredClone(initialState),
    version: "fixture-reset",
    operation: "fixture-op-reset",
  };
  await page.keyboard.press("r");
  await expect(section(secondPath)).toHaveCount(1);
  await oneFile.click();
  await page
    .locator(".file-bar")
    .getByRole("button", { name: `Squash file ${firstPath}`, exact: true })
    .click();
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(treeRow(firstPath)).toHaveCount(0);
  assert(squashRefs.every((ref) => ref.path === firstPath));
  assert.equal(squashRefs.length, 20);

  await treeRow(unsupportedPath).click();
  await expect(
    page.locator(".file-bar").getByRole("button", {
      name: `Squash file ${unsupportedPath}`,
      exact: true,
    }),
  ).toBeDisabled();
  await treeRow(secondPath).hover();
  await page
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: `Squash file ${secondPath}`, exact: true })
    .click();
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(treeRow(secondPath)).toHaveCount(0);
  await expect(treeRow(unsupportedPath)).toHaveAttribute(
    "aria-selected",
    "true",
  );
  assert(squashRefs.every((ref) => ref.path === secondPath));
  assert.equal(squashRefs.length, 22);
  await allFiles.click();

  // Read-only destination guards disable both entry points, not just line squash.
  serverState = {
    ...structuredClone(initialState),
    parent: null,
    squashUnavailable: "The parent is immutable.",
    version: "fixture-blocked",
    operation: "fixture-op-blocked",
  };
  await page.keyboard.press("r");
  await expect(
    section(firstPath).getByRole("button", {
      name: `Squash file ${firstPath}`,
      exact: true,
    }),
  ).toBeDisabled();
  await treeRow(firstPath).hover();
  await expect(sidebarSquash).toBeDisabled();
  await expect(sidebarSquash).toHaveAttribute(
    "title",
    "The parent is immutable.",
  );

  serverState = {
    ...serverState,
    version: "fixture-empty",
    operation: "fixture-op-empty",
    files: [],
    canUndo: false,
  };
  const emptyRefresh = page.waitForResponse((response) =>
    response.url().endsWith("/api/state"),
  );
  await page.keyboard.press("r");
  await emptyRefresh;
  await expect(page.locator(".file-diff-section")).toHaveCount(0);
  await expect(page.locator(".viewer-scroll .empty")).toContainText(
    "No changes in this revision.",
  );
  await expect(allFiles).toHaveAttribute("aria-pressed", "true");

  assert.deepEqual(errors, []);
  console.log(
    "File view browser checks passed: mode rendering/persistence, section navigation, file-scoped selection, focus, unsupported/empty states, squash targeting, and log padding.",
  );
} finally {
  await fixture.close();
}
