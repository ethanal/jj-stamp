// Commit-keyed prefetch and pending navigation integration; no real repository.
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import type { DiffFile, RepoState } from "../src/types.ts";

const revisions = Array.from({ length: 14 }, (_, index) => ({
  commitId: (index + 1).toString(16).padStart(40, "0"),
  changeId: `change-${index}`,
  description: `Change ${index}`,
}));
const repo = { name: "prefetch", path: "/fixture/prefetch" };
const file = (index: number): DiffFile => ({
  path: "example.txt",
  additions: 1,
  deletions: 1,
  patch: `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,3 +1,3 @@\n before\n-old ${index}\n+new ${index}\n after\n`,
  hunks: [
    {
      id: `hunk-${index}`,
      header: "@@ -1,3 +1,3 @@",
      rows: [
        { index: 1, raw: " before", oldLine: 1, newLine: 1 },
        { index: 2, raw: `-old ${index}`, oldLine: 2 },
        { index: 3, raw: `+new ${index}`, newLine: 2 },
        { index: 4, raw: " after", oldLine: 3, newLine: 3 },
      ],
    },
  ],
});
let selected = 5;
let generation = 0;
const state = (index = selected): RepoState => ({
  repo,
  version: `version-${index}-${generation}`,
  source: revisions[index],
  parent: revisions[index + 1] ?? null,
  targets: [],
  files: [file(index)],
  operation: "same-recorded-operation",
  canUndo: false,
});
const commits: string[] = [];
const contents: string[] = [];
const selections: { changeId: string; version: string }[] = [];
let graphReads = 0;
let hideLastRevision = false;
const app = express();
app.use(express.json());
app.get("/api/state", (_req, res) => res.json(state()));
app.get("/api/graph", (_req, res) => {
  graphReads++;
  res.json({
    version: state().version,
    rows: revisions
      .filter(
        (_revision, index) =>
          !hideLastRevision || index !== revisions.length - 1,
      )
      .flatMap((revision) => [
        { graph: "│" },
        { graph: "○ ", revision, mutable: true },
      ]),
  });
});
app.post("/api/commit", (req, res) => {
  commits.push(req.body.commitId);
  const index = revisions.findIndex(
    (item) => item.commitId === req.body.commitId,
  );
  assert(index >= 0);
  res.json({
    repo,
    commitId: revisions[index].commitId,
    baseCommitId: revisions[index + 1]?.commitId ?? null,
    files: [file(index)],
  });
});
app.post("/api/commit-file", (req, res) => {
  contents.push(req.body.commitId);
  const index = revisions.findIndex(
    (item) => item.commitId === req.body.commitId,
  );
  assert(index >= 0);
  res.json({
    oldFile: { name: "example.txt", contents: `before\nold ${index}\nafter\n` },
    newFile: { name: "example.txt", contents: `before\nnew ${index}\nafter\n` },
  });
});
app.post("/api/revision", (req, res) => {
  selections.push(req.body);
  if (req.body.version !== state().version) {
    res.status(409).json({ error: "Stale selection", code: "STALE_STATE" });
    return;
  }
  selected = revisions.findIndex((item) => item.changeId === req.body.changeId);
  assert(selected >= 0);
  res.json({ state: state() });
});

await using resources = new AsyncDisposableStack();
const { page, url, errors, close } = await createBrowserFixture({ app });
resources.defer(close);
await page.goto(url);
await expect(page.locator(".code-surface")).toContainText("new 5");
await expect.poll(() => contents.length).toBe(11);
assert.deepEqual(
  commits,
  [4, 6, 3, 7, 2, 8, 1, 9, 0, 10].map((index) => revisions[index].commitId),
);
assert.equal(new Set(contents).size, 11, "one content read per warmed commit");
assert.equal(graphReads, 1);

// Same immutable identities and refreshed authorization never cause refetch.
generation++;
await page.getByRole("button", { name: "refresh r", exact: true }).click();
await expect(
  page.getByRole("button", { name: "refresh r", exact: true }),
).toBeEnabled();
await expect.poll(() => graphReads).toBe(2);
await page.waitForTimeout(100);
assert.equal(commits.length, 10);
assert.equal(contents.length, 11);

// Hold the stateful selection while allowing cached browsing immediately.
let release!: () => void;
const gate = new Promise<void>((resolve) => {
  release = resolve;
});
let held = false;
await page.route("**/api/revision", async (route) => {
  if (!held) {
    held = true;
    await gate;
  }
  await route.continue();
});
const choose = (index: number) =>
  page
    .getByRole("button", {
      name: `Review change ${revisions[index].changeId}`,
      exact: true,
    })
    .click();
// Graph aliases can change without changing repository history. A validated
// selection must still refresh graph metadata; immutable content stays cached.
hideLastRevision = true;
await choose(4);
await expect(page.locator(".code-surface")).toContainText("new 4");
await expect(page.locator(".squash-unavailable")).toContainText(
  "Validating revision",
);
await expect(page.locator(".squash-file")).toBeDisabled();
await expect(page.locator(".file-tree")).not.toHaveAttribute("inert", "");
await choose(3);
await expect(page.locator(".code-surface")).toContainText("new 3");
await choose(2);
await expect(page.locator(".code-surface")).toContainText("new 2");
assert.equal(contents.length, 11, "cached previews do not refetch contents");
release();
await expect(page.locator(".statusbar")).not.toContainText("switching change");
await expect(page.locator(".squash-unavailable")).toHaveCount(0);
await expect(page.locator(".code-surface")).toContainText("new 2");
assert.deepEqual(selections, [
  { changeId: revisions[4].changeId, version: "version-5-1" },
  { changeId: revisions[2].changeId, version: "version-4-1" },
]);
await expect.poll(() => graphReads).toBe(3);
await expect(
  page.getByRole("button", { name: "Review change change-13", exact: true }),
).toHaveCount(0);
assert.equal(contents.filter((id) => id === revisions[2].commitId).length, 1);

// A cold tab must still navigate while speculative file I/O is indefinitely
// slow. Hold the nearest background file, not the selected commit's demand read.
let releaseBackground!: () => void;
let capturedBackground!: () => void;
const backgroundGate = new Promise<void>((resolve) => {
  releaseBackground = resolve;
});
const backgroundCaptured = new Promise<void>((resolve) => {
  capturedBackground = resolve;
});
let backgroundHeld = false;
await page.route("**/api/commit-file", async (route) => {
  if (
    !backgroundHeld &&
    route.request().postDataJSON().commitId !== revisions[2].commitId
  ) {
    backgroundHeld = true;
    capturedBackground();
    await backgroundGate;
  }
  await route.continue();
});
await page.reload();
await backgroundCaptured;
await choose(1);
await expect(
  page.getByRole("button", { name: "refresh r", exact: true }),
).toBeEnabled();
await expect(page.locator(".code-surface")).toContainText("new 1");
assert.equal(
  selected,
  1,
  "live revision selection did not wait for background file I/O",
);
releaseBackground();
await page.waitForLoadState("networkidle");
assert.deepEqual(errors, []);
console.log(
  "Prefetch: nearest 10, commit reuse, immediate read-only previews, coalesced validated navigation passed.",
);
