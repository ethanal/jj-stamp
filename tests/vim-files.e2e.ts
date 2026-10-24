// Run with: npx tsx tests/vim-files.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { DiffFile, RepoState } from "../src/types";

function addedFile(path: string, count: number): DiffFile {
  const rows = Array.from({ length: count }, (_, index) => ({
    index: index + 1,
    raw: `+${path} line ${index + 1}`,
    newLine: index + 1,
  }));
  const header = `@@ -0,0 +1,${count} @@`;
  return {
    path,
    additions: count,
    deletions: 0,
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n${header}\n${rows.map((row) => row.raw).join("\n")}\n`,
    hunks: [{ id: path, header, rows }],
  };
}
const source = {
  changeId: "vim-files",
  commitId: "a".repeat(40),
  description: "File navigation",
};
const state: RepoState = {
  repo: { name: "vim-files", path: "/tmp/vim-files" },
  version: "v1",
  source,
  parent: null,
  targets: [],
  files: [
    addedFile("a.txt", 3),
    {
      path: "binary",
      additions: 0,
      deletions: 0,
      hunks: [],
      patch: "",
      unsupported: "Binary file",
    },
    { path: "empty", additions: 0, deletions: 0, hunks: [], patch: "" },
    addedFile("z.txt", 300),
    addedFile("zz.txt", 2),
  ],
  operation: "op1",
  canUndo: false,
};
const app = express();
app.get("/api/state", (_request, response) => response.json(state));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: state.version,
    rows: [{ graph: "@ ", revision: source, mutable: true }],
  }),
);
app.get("/api/events", (_request, response) => response.sendStatus(204));
const fixture = await createBrowserFixture({ app });
const { page, url, errors } = fixture;
const section = (path: string) =>
  page.locator(`.file-diff-section[data-file-path="${path}"]`);
const surface = (path: string) => section(path).locator(".code-surface");
async function at(path: string, line: number) {
  await expect(surface(path)).toBeFocused();
  const cursor = section(path).locator("[data-line][data-fold-vim-cursor]");
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toHaveAttribute("data-line", String(line));
  await expect(cursor).toBeInViewport();
}
async function moveWithMinimalScroll(
  path: string,
  line: number,
  key: "j" | "k",
) {
  const target = section(path).locator(`[data-line="${line}"]`).last();
  const expected = await target.evaluate((row) => {
    const host = (row.getRootNode() as ShadowRoot).host;
    const viewport = host.closest<HTMLElement>(".viewer-scroll")!;
    const section = host.closest(".file-diff-section")!;
    const inset =
      section?.querySelector(".file-diff-heading")?.getBoundingClientRect()
        .height ?? 0;
    const box = viewport.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    const delta =
      rect.top < box.top + inset
        ? rect.top - box.top - inset
        : Math.max(0, rect.bottom - box.top - viewport.clientHeight);
    return Math.max(
      0,
      Math.min(
        viewport.scrollHeight - viewport.clientHeight,
        viewport.scrollTop + delta,
      ),
    );
  });
  await page.keyboard.press(key);
  await at(path, line);
  await expect
    .poll(() =>
      page.locator(".viewer-scroll").evaluate((element) => element.scrollTop),
    )
    .toBeCloseTo(expected, 0);
}
try {
  await page.goto(url);
  for (const view of ["single", "all"]) {
    for (const layout of ["unified", "split"]) {
      await page.evaluate((view) => {
        localStorage.setItem("jj-stamp.vim-mode", "true");
        localStorage.setItem("jj-stamp.file-view", view);
      }, view);
      await page.reload();
      await expect(surface("a.txt")).toBeVisible();
      // Exercise both visual line layouts.
      await page
        .getByRole("button", {
          name: layout === "split" ? "Split" : "Stacked",
          exact: true,
        })
        .click();
      await surface("a.txt").focus();
      await page.keyboard.press("j");
      await at("a.txt", 1);
      await page.keyboard.press("k"); // no wrapping before the first file
      await at("a.txt", 1);
      await page.keyboard.press("j");
      await page.keyboard.press("j");
      await at("a.txt", 3);
      await page.keyboard.press("Shift+V");
      await page.keyboard.press("j"); // visual ranges stay within one file
      await at("a.txt", 3);
      await page.keyboard.press("Escape");
      if (view === "all") {
        await page
          .getByRole("button", { name: "Collapse file z.txt", exact: true })
          .click();
        await surface("a.txt").focus();
      }
      await page.keyboard.press("j"); // skip binary and empty diffs, reveal collapsed target
      await at("z.txt", 1);
      await expect(page.locator("[data-line][data-fold-selected]")).toHaveCount(
        0,
      );
      if (view === "all") await moveWithMinimalScroll("a.txt", 3, "k");
      else {
        await page.keyboard.press("k");
        await at("a.txt", 3);
      }
      // Crossing to an already-visible line must not jump to its heading.
      if (view === "all") await moveWithMinimalScroll("z.txt", 1, "j");
      else {
        await page.keyboard.press("j");
        await at("z.txt", 1);
      }
      // Start at a virtualized EOF; returning upward must also reveal that EOF.
      for (let i = 1; i < 300; i++) await page.keyboard.press("j");
      await at("z.txt", 300);
      if (view === "all") {
        await moveWithMinimalScroll("zz.txt", 1, "j");
        await moveWithMinimalScroll("z.txt", 300, "k");
      } else {
        await page.keyboard.press("j");
        await at("zz.txt", 1);
        await page.keyboard.press("k"); // reveal the previous file's virtualized EOF
        await at("z.txt", 300);
      }
      await page.keyboard.press("j");
      await at("zz.txt", 1);
      await page.keyboard.press("j");
      await at("zz.txt", 2);
      await page.keyboard.press("j"); // no wrapping after the last file
      await at("zz.txt", 2);
      await page.keyboard.press("k");
      await page.keyboard.press("k");
      await at("z.txt", 300);
      for (let i = 300; i > 1; i--) await page.keyboard.press("k");
      await at("z.txt", 1);
      await page.keyboard.press("k");
      await at("a.txt", 3);
    }
  }
  assert.deepEqual(errors, []);
  console.log("Vim cross-file navigation checks passed");
} finally {
  await fixture.close();
}
