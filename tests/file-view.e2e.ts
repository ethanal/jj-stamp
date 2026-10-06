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
  const fileBarTitle = page.locator(".file-bar-title");
  await expect(fileBarTitle.locator(".file-bar-filename")).toHaveText(
    firstPath,
  );
  await expect(fileBarTitle.locator(".line-counts")).toHaveText("+10−10");
  await expect(
    fileBarTitle.getByRole("button", {
      name: `Squash file ${firstPath}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator(".file-bar-tools .line-counts")).toHaveCount(0);
  await expect(page.locator(".file-bar-tools .squash-file")).toHaveCount(0);
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
  // App-level find searches patch data, so virtualized offscreen rows are
  // reachable even though browser find cannot see their DOM yet.
  const offscreenNeedle = `updated ${secondPath} line 110`;
  await expect(addition(secondPath, 110)).toHaveCount(0);
  await page.keyboard.press("Control+f");
  const search = page.getByRole("searchbox", { name: "Search diff" });
  await expect(search).toBeFocused();
  await expect(search).toHaveAttribute("type", "text");
  await search.fill(offscreenNeedle);
  const searchControls = page.locator(".diff-search");
  await expect(page.locator(".diff-search-count")).toHaveText("1 / 1");
  const searchWidth = await searchControls.evaluate(
    (element) => (element as HTMLElement).offsetWidth,
  );
  await search.fill("no such diff text");
  await expect(page.locator(".diff-search-count")).toHaveText("No results");
  assert.equal(
    await searchControls.evaluate(
      (element) => (element as HTMLElement).offsetWidth,
    ),
    searchWidth,
  );
  await search.fill(offscreenNeedle);
  await expect(page.locator(".diff-search-count")).toHaveText("1 / 1");
  await expect(addition(secondPath, 110)).toHaveAttribute(
    "data-fold-search-current",
    "",
  );
  await expect(addition(secondPath, 110)).toBeInViewport();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });
  await search.press("Enter");
  await expect(addition(secondPath, 110)).toBeInViewport();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(addition(secondPath, 110)).toBeInViewport();
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await expect(addition(secondPath, 110)).toBeInViewport();
  const regex = page.getByRole("button", {
    name: "Use regular expression",
    exact: true,
  });
  await regex.click();
  await expect(regex).toHaveAttribute("aria-pressed", "true");
  await search.fill(`^updated tests/long-beta\\.ts line (100|110)$`);
  await expect(page.locator(".diff-search-count")).toHaveText("1 / 2");
  await expect(addition(secondPath, 100)).toHaveAttribute(
    "data-fold-search-current",
    "",
  );
  await search.press("Enter");
  await expect(page.locator(".diff-search-count")).toHaveText("2 / 2");
  await expect(addition(secondPath, 110)).toHaveAttribute(
    "data-fold-search-current",
    "",
  );
  await search.fill("[");
  await expect(search).toHaveAttribute("aria-invalid", "true");
  await expect(page.locator(".diff-search-count")).toHaveText("Invalid regex");
  assert.equal(
    await searchControls.evaluate(
      (element) => (element as HTMLElement).offsetWidth,
    ),
    searchWidth,
  );
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(allFiles).toBeFocused();
  await viewport.evaluate((element) => {
    element.scrollTop = 0;
  });

  // The same split applies to virtualized files as they enter the viewport.
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const divider = page.getByRole("separator", { name: "Resize split diff" });
  await section(firstPath).getByRole("separator").press("Shift+ArrowRight");
  for (const path of [firstPath, secondPath]) {
    await treeRow(path).click();
    const left = section(path).locator("[data-code][data-deletions]");
    const right = section(path).locator("[data-code][data-additions]");
    await expect(left).toBeVisible();
    await expect
      .poll(async () => {
        const a = await left.boundingBox();
        const b = await right.boundingBox();
        assert(a && b);
        return Math.round((a.width / (a.width + b.width)) * 100);
      })
      .toBe(60);
  }
  await treeRow(unsupportedPath).click();
  await expect(divider).toHaveCount(2);
  await expect(section(unsupportedPath).getByRole("separator")).toHaveCount(0);
  await page.getByRole("button", { name: "Stacked", exact: true }).click();
  await expect(divider).toHaveCount(0);
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
  // Scroll like a user: virtualized offscreen rows do not exist for Playwright
  // to auto-scroll to. Scrolling (unlike sidebar navigation) retains selection.
  await viewport.evaluate((element, path) => {
    const target = element.querySelector<HTMLElement>(
      `[data-file-path="${path}"]`,
    )!;
    element.scrollTop +=
      target.getBoundingClientRect().top - element.getBoundingClientRect().top;
  }, secondPath);
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
  // Offscreen files retain measured height, not their full row DOM. The active
  // file must mount in place without being pushed out by background rendering.
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

  for (const button of await page.locator(".squash-file").all()) {
    await expect(button).toHaveText("");
    await expect(button.locator('svg[aria-hidden="true"]')).toHaveCount(1);
    await expect(button).toHaveCSS("width", "24px");
    await expect(button).toHaveCSS("height", "24px");
  }
  await expect(
    page.getByRole("button", { name: "s squash", exact: true }),
  ).toBeVisible();
  // Sidebar rows remain navigation-only on both hover and keyboard focus.
  const sidebarSquash = page
    .getByRole("navigation", { name: "Changed files" })
    .getByRole("button", { name: /^Squash file / });
  for (const path of [firstPath, secondPath, unsupportedPath]) {
    await treeRow(path).hover();
    await expect(sidebarSquash).toHaveCount(0);
    await treeRow(path).focus();
    await expect(sidebarSquash).toHaveCount(0);
  }
  await page.keyboard.press("Tab");
  await expect(sidebarSquash).toHaveCount(0);

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

  // Restore to exercise the one-file header.
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
  await treeRow(secondPath).click();
  await page
    .locator(".file-bar")
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

  // Read-only destinations hide every squash control without an idle warning.
  serverState = {
    ...structuredClone(initialState),
    parent: null,
    squashUnavailable: "The parent is immutable.",
    version: "fixture-blocked",
    operation: "fixture-op-blocked",
  };
  await page.keyboard.press("r");
  await expect(page.locator(".squash-file")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "s squash" })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await treeRow(firstPath).hover();
  await expect(sidebarSquash).toHaveCount(0);
  const beforeBlocked = squashInputs.length;
  // The shortcut explains the restriction even without a line selection.
  await page.keyboard.press("s");
  await expect(page.getByRole("alert")).toContainText(
    "The parent is immutable.",
  );
  assert.equal(squashInputs.length, beforeBlocked);
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await treeRow(firstPath).click();
  await oneFile.click();
  await expect(page.locator(".squash-file")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "s squash" })).toHaveCount(0);
  await addition(firstPath, 10).click();
  await page.keyboard.press("s");
  await expect(page.getByRole("alert")).toContainText(
    "The parent is immutable.",
  );
  assert.equal(squashInputs.length, beforeBlocked);
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await allFiles.click();

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
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "s squash" })).toHaveCount(0);
  await page.keyboard.press("s");
  await expect(page.getByRole("alert")).toContainText(
    "The parent is immutable.",
  );
  assert.equal(squashInputs.length, beforeBlocked);
  await page.keyboard.press("Escape");

  serverState = {
    ...structuredClone(initialState),
    version: "fixture-writable-again",
    operation: "fixture-op-writable-again",
  };
  await page.keyboard.press("r");
  await expect(page.locator(".squash-file")).toHaveCount(3);
  await expect(page.getByRole("button", { name: "s squash" })).toBeVisible();
  await expect(
    section(firstPath).getByRole("button", {
      name: `Squash file ${firstPath}`,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Single-sided files use Pierre's full-width layout, even in a mixed list.
  const singleSidedFiles = ["new", "deleted"].map((kind): DiffFile => {
    const added = kind === "new";
    const path = `${kind}.txt`;
    const rows = Array.from({ length: 100 }, (_, i) => ({
      index: i + 1,
      raw: `${added ? "+" : "-"}single-sided line ${i + 1}`,
      ...(added ? { newLine: i + 1 } : { oldLine: i + 1 }),
    }));
    const header = added ? "@@ -0,0 +1,100 @@" : "@@ -1,100 +0,0 @@";
    return {
      path,
      additions: added ? 100 : 0,
      deletions: added ? 0 : 100,
      hunks: [{ id: path, header, rows }],
      patch: `diff --git a/${path} b/${path}\n${added ? "new" : "deleted"} file mode 100644\n--- ${added ? "/dev/null" : `a/${path}`}\n+++ ${added ? `b/${path}` : "/dev/null"}\n${header}\n${rows.map((row) => row.raw).join("\n")}\n`,
    };
  });
  serverState = {
    ...serverState,
    version: "mixed-split",
    files: [firstFile, ...singleSidedFiles, secondFile],
  };
  await page.keyboard.press("r");
  await expect(page.locator(".file-diff-section")).toHaveCount(4);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(divider).toHaveCount(2);
  for (const mode of [allFiles, oneFile]) {
    await mode.click();
    for (const file of singleSidedFiles) {
      await treeRow(file.path).click();
      await expect(section(file.path).getByRole("separator")).toHaveCount(0);
      const code = section(file.path).locator("[data-code]");
      await expect(code).toBeVisible();
      await expect(code).toHaveCount(1);
      const codeBox = await code.boundingBox();
      const surfaceBox = await section(file.path)
        .locator(".code-surface")
        .boundingBox();
      assert(
        codeBox && surfaceBox && Math.abs(codeBox.width - surfaceBox.width) < 2,
      );
      const viewBox = await viewport.boundingBox();
      assert(viewBox);
      const seam = await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest(".split-diff-resize") !==
          null,
        { x: surfaceBox.x + surfaceBox.width * 0.6, y: viewBox.y + 150 },
      );
      assert.equal(
        seam,
        false,
        "No resize hit target over a single-sided file",
      );
    }
    await treeRow(firstPath).click();
    await expect(section(firstPath).getByRole("separator")).toHaveAttribute(
      "aria-valuenow",
      "60",
    );
  }

  assert.deepEqual(errors, []);
  console.log(
    "File view browser checks passed: mode rendering/persistence, section navigation, file-scoped selection, focus, unsupported/empty states, squash targeting, and log padding.",
  );
} finally {
  await fixture.close();
}
