// Mock repository updates exercise the real App refresh and virtual renderer.
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { parseFile } from "../server/diff.ts";
import type { DiffFile, RepoState } from "../src/types.ts";
import { createBrowserFixture } from "./browser-fixture.ts";

function diff(extra = 0, edited = false): DiffFile {
  const body = [
    `@@ -1,1 +1,${extra + 1} @@`,
    "-old heading",
    "+new heading",
    ...Array.from({ length: extra }, (_, i) => `+earlier insertion ${i}`),
    `@@ -100,2 +${100 + extra},302 @@`,
    " begin",
    ...Array.from({ length: 300 }, (_, i) =>
      i === 50 && edited ? "+edited cursor line" : "+repeated line",
    ),
    " end",
  ].join("\n");
  const patch = `diff --git a/review.txt b/review.txt\n--- a/review.txt\n+++ b/review.txt\n${body}\n`;
  return {
    path: "review.txt",
    patch,
    additions: extra + 301,
    deletions: 1,
    hunks: parseFile(patch, "review.txt").hunks.map((hunk, i) => ({
      ...hunk,
      id: `hunk-${extra}-${edited}-${i}`,
    })),
  };
}
const source = {
  changeId: "source",
  commitId: "a".repeat(40),
  description: "Review",
};
const parent = {
  changeId: "parent",
  commitId: "b".repeat(40),
  description: "Parent",
};
let state: RepoState = {
  repo: { name: "vim-refresh", path: "/tmp/vim-refresh" },
  source,
  parent,
  targets: [parent],
  version: "v1",
  operation: "op1",
  files: [diff()],
  canUndo: false,
};
const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => response.json(state));
app.get("/api/events", (_request, response) => response.sendStatus(204));
app.get("/api/graph", (_request, response) =>
  response.json({ version: state.version, rows: [] }),
);
app.post("/api/commit", (_request, response) =>
  response.status(404).json({ error: "No preview" }),
);
const fixture = await createBrowserFixture({
  app,
  viewport: { width: 1280, height: 720 },
});
const { page, url, errors } = fixture;
const surface = page.locator(".code-surface");
const cursor = page.locator("[data-line][data-fold-vim-cursor]");
const selected = page.locator("[data-line][data-fold-selected]");
const refresh = page.getByRole("button", { name: "refresh r", exact: true });
async function at(line: number) {
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toHaveAttribute("data-line", String(line));
  await expect
    .poll(() =>
      cursor.evaluate((row) => {
        const viewport = (row.getRootNode() as ShadowRoot).host
          .closest(".viewer-scroll")!
          .getBoundingClientRect();
        const box = row.getBoundingClientRect();
        return box.top >= viewport.top - 1 && box.bottom <= viewport.bottom + 1;
      }),
    )
    .toBe(true);
}
async function update(file: DiffFile, automatic: boolean) {
  state = {
    ...state,
    version: `${state.version}-next`,
    operation: `${state.operation}-next`,
    source: { ...state.source, commitId: `${state.source.commitId.slice(1)}c` },
    files: [file],
  };
  const response = page.waitForResponse("**/api/state");
  if (automatic)
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  else await refresh.click();
  await response;
  await expect(refresh).toBeEnabled();
  await expect(page.locator(".statusbar")).not.toContainText("Refreshing");
}
try {
  await page.addInitScript(() => {
    localStorage.setItem("jj-stamp.vim-mode", "true");
  });
  await page.goto(url);
  await expect(surface.locator("[data-line]").first()).toBeAttached();
  await page.locator(".viewer-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(surface.locator('[data-line="1"]').first()).toBeVisible();
  // Start in normal mode, without a controlled selection to reconstruct from.
  await surface.focus();
  await page.keyboard.press("j");
  for (let i = 0; i < 53; i++) await page.keyboard.press("j");
  await at(151);
  await expect(selected).toHaveCount(0);

  // Earlier insertions move the unchanged hunk; repeated rows must keep their
  // exact offset within it, despite new hunk IDs and new commit identity.
  await update(diff(120), true);
  await at(271);
  await expect(surface).toBeFocused();
  await expect(surface).toHaveAttribute("data-vim-mode", "normal");
  await page.keyboard.press("j");
  await at(272);
  await page.keyboard.press("k");
  await at(271);

  // A manual refresh uses the same mapping, without forcing diff focus.
  await update(diff(0), false);
  await at(151);
  await expect(surface).not.toBeFocused();
  await surface.focus();

  // Visual ranges are cleared for safety, but their cursor survives. No stale
  // visual anchor may make the next motion select unrelated updated rows.
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("j");
  await at(152);
  await expect(selected).toHaveCount(2);
  await update(diff(120), true);
  await at(272);
  await expect(selected).toHaveCount(0);
  await expect(surface).toHaveAttribute("data-vim-mode", "normal");
  await page.keyboard.press("k");
  await at(271);
  await expect(selected).toHaveCount(0);

  // A changed cursor row stays nearby, not at the start of the file.
  await update(diff(120, true), true);
  await expect(cursor).toHaveCount(1);
  const fallbackLine = Number(await cursor.getAttribute("data-line"));
  assert(
    Math.abs(fallbackLine - 271) <= 1,
    `Unexpected fallback line ${fallbackLine}`,
  );
  await at(fallbackLine);

  // Metadata-only refreshes leave an otherwise identical patch's cursor alone.
  await update(state.files[0], true);
  await at(fallbackLine);

  // Split mode retains the same addition-side coordinate across a hunk shift.
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await surface.focus();
  await update(diff(0, true), true);
  await at(fallbackLine - 120);
  await expect(cursor).toHaveAttribute("data-line-type", "change-addition");

  // A different logical revision must not inherit this revision's cursor.
  state = { ...state, source: { ...state.source, changeId: "other-source" } };
  await update(diff(), true);
  await expect(cursor).toHaveCount(0);
  assert.deepEqual(errors, []);
  console.log(
    "Vim refresh checks passed: hunk shifts, repeated rows, manual/focus refresh, visual clears, edited rows, revision boundaries.",
  );
} finally {
  await fixture.close();
}
