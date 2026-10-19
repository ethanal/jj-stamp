// Run with: npx tsx tests/squash-navigation.e2e.ts (mock API; no jj executable).
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import { projectSquash, refsFromSelection } from "../src/optimistic.ts";
import type {
  DiffFile,
  RepoState,
  Revision,
  Selections,
} from "../src/types.ts";

type Gate = { promise: Promise<void>; release: () => void };
type SquashInput = {
  version: string;
  selections: { id: string; lines: number[] }[];
};
const gates: Gate[] = [];
function gate(): Gate {
  let release!: () => void;
  const result = {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release: () => release(),
  };
  gates.push(result);
  return result;
}
const revision = (name: string, index: number): Revision => ({
  changeId: `navigation-${name}`,
  changeIdPrefix: `navigation-${name}`,
  commitId: index.toString(16).padStart(40, "0"),
  description: `Revision ${name}`,
});
const source = revision("source", 1);
const parent = revision("parent", 2);
const b = revision("B", 30);
const c = revision("C", 31);
const workingCopy = revision("working", 32);
// Targets are outside the nearest-ten speculative window. A preview of B/C
// during the paused queue therefore MUST issue a demand /commit read.
const revisions = [
  source,
  ...Array.from({ length: 12 }, (_, i) => revision(`filler-${i}`, i + 3)),
  b,
  c,
  workingCopy,
];
const repo = { name: "squash-navigation", path: "/fixture/squash-navigation" };
function newFile(path: string): DiffFile {
  return {
    path,
    additions: 1,
    deletions: 0,
    patch: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+source ${path}\n`,
    hunks: [
      {
        id: `${path}-hunk`,
        header: "@@ -0,0 +1 @@",
        rows: [{ index: 1, raw: `+source ${path}`, newLine: 1 }],
      },
    ],
  };
}
function previewFile(label: string, path = "preview.txt"): DiffFile {
  return {
    path,
    additions: 1,
    deletions: 1,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -10,3 +10,3 @@\n context 10\n-old ${label}\n+new ${label}\n context 12\n`,
    hunks: [
      {
        id: `${path}-${label}`,
        header: "@@ -10,3 +10,3 @@",
        rows: [
          { index: 1, raw: " context 10", oldLine: 10, newLine: 10 },
          { index: 2, raw: `-old ${label}`, oldLine: 11 },
          { index: 3, raw: `+new ${label}`, newLine: 11 },
          { index: 4, raw: " context 12", oldLine: 12, newLine: 12 },
        ],
      },
    ],
  };
}
const snapshotFiles = (rev: Revision) => [
  previewFile(`SNAPSHOT ${rev.description}`),
  previewFile(`DETAIL ${rev.description}`, "detail.txt"),
];
function initialState(): RepoState {
  return {
    repo,
    version: "source-v0",
    source,
    parent,
    targets: [parent],
    files: [newFile("one.txt"), newFile("two.txt"), newFile("remain.txt")],
    operation: "source-op0",
    canUndo: true,
  };
}
let serverState = initialState();
let acknowledgements = 0;
let squashGates: Gate[] = [];
const previewGates = new Map<string, Gate>();
const missing = new Set<string>();
let outcome: "success" | "warning" | "failure" = "success";
let stateReads = 0;
const commits: string[] = [];
const contents: { commitId: string; path: string }[] = [];
const squashes: (SquashInput & { source: string })[] = [];
const selections: { changeId: string; version: string }[] = [];
const forbidden: string[] = [];
const violations: string[] = [];
const app = express();
app.use(express.json());
app.get("/api/state", (_req, res) => {
  stateReads++;
  res.json(serverState);
});
app.get("/api/events", (_req, res) => res.sendStatus(204));
app.get("/api/graph", (_req, res) =>
  res.json({
    version: serverState.version,
    rows: revisions.map((rev) => ({
      graph: rev === workingCopy ? "@ " : "○ ",
      revision:
        rev.changeId === serverState.source.changeId ? serverState.source : rev,
      mutable: true,
      isWorkingCopy: rev === workingCopy,
    })),
  }),
);
app.post("/api/commit", async (req, res) => {
  const id = req.body.commitId as string;
  commits.push(id);
  await previewGates.get(id)?.promise;
  const rev = revisions.find((item) => item.commitId === id);
  if (missing.has(id) || !rev) {
    res.status(404).json({ error: "Snapshot deliberately unavailable" });
    return;
  }
  res.json({
    repo,
    commitId: id,
    baseCommitId: parent.commitId,
    files: snapshotFiles(rev),
  });
});
app.post("/api/commit-file", (req, res) => {
  contents.push(req.body);
  const rev = revisions.find((item) => item.commitId === req.body.commitId);
  const label = `${req.body.path === "detail.txt" ? "DETAIL" : "SNAPSHOT"} ${rev?.description}`;
  const text = (side: string) =>
    Array.from({ length: 25 }, (_, i) =>
      i === 10 ? `${side} ${label}` : `context ${i + 1}`,
    ).join("\n") + "\n";
  res.json({
    oldFile: { name: req.body.path, contents: text("old") },
    newFile: { name: req.body.path, contents: text("new") },
  });
});
app.post("/api/squash-lines", async (req, res) => {
  const input = req.body as SquashInput;
  squashes.push({ ...input, source: serverState.source.changeId });
  await squashGates.shift()?.promise;
  if (
    input.version !== serverState.version ||
    serverState.source.changeId !== source.changeId
  ) {
    violations.push(`Wrong-source/stale squash: ${JSON.stringify(input)}`);
    res.status(409).json({ error: "Invalid squash authorization" });
    return;
  }
  if (outcome === "failure") {
    res.status(500).json({
      error: "Injected navigation squash failure",
      code: "SQUASH_NAVIGATION_FAILED",
      output: "jj diagnostic: original source locked",
    });
    return;
  }
  const selected = Object.fromEntries(
    input.selections.map((selection) => [selection.id, selection.lines]),
  ) as Selections;
  const projected = projectSquash(
    serverState,
    refsFromSelection(serverState, selected),
  );
  acknowledgements++;
  serverState = {
    ...projected,
    version: `source-v${acknowledgements}`,
    operation: `source-op${acknowledgements}`,
    canUndo: true,
    source: { ...source, commitId: String(acknowledgements + 5).repeat(40) },
  };
  res.json({
    state: serverState,
    ...(outcome === "warning" ? { warning: "Injected squash warning" } : {}),
  });
});
app.post("/api/revision", (req, res) => {
  selections.push(req.body);
  if (req.body.version !== serverState.version) {
    violations.push(
      `Stale revision authorization: ${JSON.stringify(req.body)}`,
    );
    res.status(409).json({ error: "Stale revision version" });
    return;
  }
  const rev =
    req.body.changeId === "@"
      ? workingCopy
      : revisions.find((item) => item.changeId === req.body.changeId);
  if (!rev) {
    res.status(404).json({ error: "Unknown revision" });
    return;
  }
  serverState = {
    ...serverState,
    source: { ...rev, commitId: "f".repeat(40) },
    version: `live-${rev.changeId}`,
    files: [previewFile(`LIVE REWRITTEN ${rev.description}`)],
  };
  res.json({ state: serverState });
});
for (const endpoint of ["undo", "editor"])
  app.post(`/api/${endpoint}`, (_req, res) => {
    forbidden.push(endpoint);
    res.status(409).json({ error: `Unexpected ${endpoint}` });
  });

const fixture = await createBrowserFixture({ app });
const { page, url, errors } = fixture;
await page.addInitScript(() => {
  localStorage.setItem("jj-stamp.vim-mode", "true");
  localStorage.setItem("jj-stamp.file-view", "single");
  localStorage.setItem("jj-stamp.diff-style", "unified");
});
const heading = page.getByLabel("Reviewed revision");
const notice = page.locator(".navigation-notice");
const surface = page.locator(".code-surface");
const choose = (rev: Revision) =>
  page
    .getByRole("button", { name: `Review change ${rev.changeId}`, exact: true })
    .click();
async function reset() {
  for (const held of gates) held.release();
  serverState = initialState();
  acknowledgements = 0;
  stateReads = 0;
  squashGates = [];
  previewGates.clear();
  missing.clear();
  outcome = "success";
  commits.length =
    contents.length =
    squashes.length =
    selections.length =
    forbidden.length =
    violations.length =
      0;
  await page.goto(url);
  await expect(surface).toContainText("source one.txt");
  await page.waitForLoadState("networkidle", { timeout: 10000 });
  assert(
    !commits.includes(b.commitId) && !commits.includes(c.commitId),
    "remote previews must start cold",
  );
}
async function queueTwo() {
  const first = gate(),
    second = gate();
  squashGates = [first, second];
  await page
    .getByRole("button", { name: "Squash file one.txt", exact: true })
    .click();
  await expect.poll(() => squashes.length).toBe(1);
  await expect(
    page.getByRole("button", { name: "Squash file two.txt", exact: true }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Squash file two.txt", exact: true })
    .click();
  await expect(surface).toContainText("source remain.txt");
  await expect(page.locator(".queue-count")).toContainText("2");
  assert.equal(
    squashes.length,
    1,
    "second batch stays queued behind the first ACK",
  );
  return { first, second };
}
async function preview(rev: Revision) {
  await choose(rev);
  await expect(heading).toContainText(rev.description);
  await expect(surface).toContainText(`SNAPSHOT ${rev.description}`);
  await expect(notice).toContainText("Read-only snapshot");
  await expect(notice).toContainText(
    `Finishing squashes in ${source.changeId}`,
  );
  assert.equal(serverState.source.changeId, source.changeId);
  assert.deepEqual(
    selections,
    [],
    "immutable browsing must not select a live source",
  );
}
async function drain(first: Gate, second: Gate, destination?: Revision | "@") {
  const snapshotCommit =
    (await notice.count()) &&
    (await notice.innerText()).includes("Read-only snapshot")
      ? await page.getByLabel("Current commit ID").getAttribute("title")
      : null;
  first.release();
  await expect.poll(() => squashes.length).toBe(2);
  if (snapshotCommit) {
    await expect(page.getByLabel("Current commit ID")).toHaveAttribute(
      "title",
      snapshotCommit,
    );
    await expect(surface).toContainText("SNAPSHOT");
    await expect(notice).toContainText("Finishing squashes in");
    assert.notEqual(
      serverState.source.commitId,
      source.commitId,
      "ACK really rewrites the source while the snapshot stays pinned",
    );
  }
  assert.deepEqual(
    selections,
    [],
    "first ACK must not release the deferred handoff",
  );
  assert.deepEqual(
    squashes.map(({ version, source: id, selections: selected }) => ({
      version,
      source: id,
      selections: selected,
    })),
    [
      {
        version: "source-v0",
        source: source.changeId,
        selections: [{ id: "one.txt-hunk", lines: [1] }],
      },
      {
        version: "source-v1",
        source: source.changeId,
        selections: [{ id: "two.txt-hunk", lines: [1] }],
      },
    ],
  );
  second.release();
  await expect(page.locator(".queue-count")).toHaveCount(0);
  if (destination) {
    const rev = destination === "@" ? workingCopy : destination;
    await expect(surface).toContainText(`LIVE REWRITTEN ${rev.description}`);
    await expect(heading).toContainText(rev.description);
    await expect(
      page.getByRole("button", {
        name: "Squash file preview.txt",
        exact: true,
      }),
    ).toBeEnabled();
    assert.deepEqual(selections, [
      {
        changeId: destination === "@" ? "@" : destination.changeId,
        version: "source-v2",
      },
    ]);
  } else {
    await expect(heading).toContainText(source.description);
    assert.deepEqual(selections, []);
  }
  await expect(notice).toHaveCount(0);
  assert.deepEqual(violations, []);
}
async function settle() {
  await page.waitForLoadState("networkidle", { timeout: 10000 });
  assert.deepEqual(forbidden, []);
  assert.deepEqual(violations, []);
}

try {
  // Two real optimistic batches, cold immutable B -> C, one latest-only live
  // handoff authorized by the *last* ACK, never by a preview's synthetic token.
  await reset();
  const queued = await queueTwo();
  await preview(b);
  assert.equal(commits.filter((id) => id === b.commitId).length, 1);
  await expect(page.locator(".squash-file")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Squash", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toBeDisabled();
  // Read-only snapshots retain Vim browsing, not visual/mutation controls.
  // Move pointer focus out of the graph before directing keys to this diff.
  await surface.hover();
  await surface.focus();
  await expect(surface).toBeFocused();
  const cursor = surface.locator("[data-line][data-fold-vim-cursor]");
  await expect(cursor).toHaveCount(0);
  await page.keyboard.press("j");
  await expect(cursor).toHaveCount(1);
  await expect(cursor).toHaveAttribute("data-line", "10");
  const initialSide = await cursor.getAttribute("data-line-type");
  assert(initialSide);
  await page.keyboard.press("j");
  await expect(cursor).toHaveAttribute("data-line", "11");
  await expect(cursor).toHaveAttribute("data-line-type", "change-deletion");
  await page.keyboard.press("k");
  await expect(cursor).toHaveAttribute("data-line", "10");
  await expect(cursor).toHaveAttribute("data-line-type", initialSide);
  await page.keyboard.press("Shift+V");
  await expect(surface).toHaveAttribute("data-vim-mode", "normal");
  await expect(
    page.locator("[data-fold-selected], [data-fold-context-selected]"),
  ).toHaveCount(0);

  const added = page
    .locator('[data-line][data-line-type="change-addition"]')
    .last();
  await added.click();
  await added.hover();
  for (const key of ["Shift+V", "s", "u", "e"]) await page.keyboard.press(key);
  await expect(
    page.locator("[data-fold-selected], [data-fold-context-selected]"),
  ).toHaveCount(0);
  assert.equal(squashes.length, 1);
  assert.deepEqual(forbidden, []);
  // Context and file browsing are useful in snapshots even though selection,
  // squashing and opening the mutable working tree in an editor are forbidden.
  const expand = page
    .getByLabel("Show 10 lines above", { exact: true })
    .first();
  await expect(expand).toHaveAttribute("aria-disabled", "false");
  await expand.click();
  await expect(surface).toContainText("context 1");
  assert(
    contents.some(
      (request) =>
        request.commitId === b.commitId && request.path === "preview.txt",
    ),
  );
  await page
    .locator('.file-tree [role="treeitem"][data-item-path="detail.txt"]')
    .click();
  await expect(surface).toContainText(`DETAIL ${b.description}`);
  await page
    .locator('.file-tree [role="treeitem"][data-item-path="preview.txt"]')
    .click();
  await preview(c);
  await drain(queued.first, queued.second, c);
  await settle();
  assert.equal(squashes.length, 2);

  // A late B snapshot must not displace newer C, including after live handoff.
  await reset();
  const racing = await queueTwo();
  const lateB = gate();
  previewGates.set(b.commitId, lateB);
  await choose(b);
  await expect.poll(() => commits.includes(b.commitId)).toBe(true);
  await preview(c);
  await drain(racing.first, racing.second, c);
  lateB.release();
  await settle();
  await expect(surface).toContainText(`LIVE REWRITTEN ${c.description}`);
  await expect(heading).toContainText(c.description);
  assert.equal(selections.length, 1);

  // Missing snapshots stay deferred, do not fail the queue, and still open live.
  await reset();
  const unavailable = await queueTwo();
  missing.add(b.commitId);
  await choose(b);
  await expect(notice).toContainText("Snapshot unavailable");
  await expect(heading).toContainText(source.description);
  await expect(surface).toContainText("source remain.txt");
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.deepEqual(selections, []);
  await drain(unavailable.first, unavailable.second, b);
  await settle();

  // Both ways back cancel the unsent navigation and restore the projected
  // original (not its pre-squash files), without losing the ability to enqueue.
  for (const method of ["graph", "button"] as const) {
    await reset();
    const returning = await queueTwo();
    await preview(b);
    if (method === "graph") await choose(source);
    else
      await page
        .getByRole("button", {
          name: "Return to squashing change",
          exact: true,
        })
        .click();
    await expect(heading).toContainText(source.description);
    await expect(notice).toHaveCount(0);
    await expect(surface).toContainText("source remain.txt");
    await expect(page.getByLabel("Change line counts")).toHaveText("+1−0");
    await page
      .getByRole("button", { name: "Squash file remain.txt", exact: true })
      .click();
    // The queue compacts additional selections into its one waiting batch.
    await expect(page.locator(".viewer-scroll .empty")).toContainText(
      "All changes queued",
    );
    await expect(page.locator(".queue-count")).toContainText("2");
    returning.first.release();
    await expect.poll(() => squashes.length).toBe(2);
    assert.deepEqual(selections, []);
    returning.second.release();
    await expect(page.locator(".queue-count")).toHaveCount(0);
    await settle();
    assert.deepEqual(
      squashes.map((request) => [
        request.source,
        request.version,
        request.selections,
      ]),
      [
        [source.changeId, "source-v0", [{ id: "one.txt-hunk", lines: [1] }]],
        [
          source.changeId,
          "source-v1",
          [
            { id: "two.txt-hunk", lines: [1] },
            { id: "remain.txt-hunk", lines: [1] },
          ],
        ],
      ],
    );
    assert.deepEqual(selections, []);
    await expect(heading).toContainText(source.description);
    await expect(page.locator(".viewer-scroll .empty")).toContainText(
      "No changes",
    );
  }

  // Returning before a demand read completes must invalidate that completion.
  await reset();
  const canceled = await queueTwo();
  const canceledPreview = gate();
  previewGates.set(b.commitId, canceledPreview);
  await choose(b);
  await expect.poll(() => commits.includes(b.commitId)).toBe(true);
  await choose(source);
  canceledPreview.release();
  await expect(
    page.getByRole("button", { name: "Squash file remain.txt", exact: true }),
  ).toBeEnabled();
  await drain(canceled.first, canceled.second);
  await settle();
  await expect(surface).toContainText("source remain.txt");
  assert.deepEqual(selections, []);

  // @ is a moving target: replace B's intent, clear its immutable preview, and
  // only resolve the working copy on the server once both squashes finish.
  await reset();
  const moving = await queueTwo();
  await preview(b);
  const beforeWorkingCopy = [...commits];
  await page.keyboard.press("@");
  await expect(notice).toContainText("then opening the working copy");
  await expect(notice).not.toContainText("Read-only snapshot");
  await expect(heading).toContainText(source.description);
  await expect(surface).toContainText("source remain.txt");
  assert.deepEqual(
    commits,
    beforeWorkingCopy,
    "@ must not fetch a guessed immutable working-copy snapshot",
  );
  assert.deepEqual(selections, []);
  await drain(moving.first, moving.second, "@");
  await settle();

  // Queue diagnostics win over a preview and any late read. Warning preserves
  // the first ACK; failure restores the initial source via exactly one GET.
  for (const stopped of ["warning", "failure"] as const) {
    await reset();
    const stopping = await queueTwo();
    await preview(b);
    const lateC = gate();
    previewGates.set(c.commitId, lateC);
    await choose(c);
    await expect.poll(() => commits.includes(c.commitId)).toBe(true);
    outcome = stopped;
    const readsBefore = stateReads;
    stopping.first.release();
    await expect(page.getByRole("alert")).toContainText(
      stopped === "warning"
        ? "Injected squash warning"
        : "Injected navigation squash failure",
    );
    await expect(heading).toContainText(source.description);
    await expect(notice).toHaveCount(0);
    await expect(page.getByLabel("Change line counts")).toHaveText(
      stopped === "warning" ? "+2−0" : "+3−0",
    );
    lateC.release();
    stopping.second.release();
    await settle();
    await expect(heading).toContainText(source.description);
    if (stopped === "failure") {
      await expect(page.getByRole("alert")).toContainText(
        "SQUASH_NAVIGATION_FAILED",
      );
      await expect(page.getByRole("alert")).toContainText(
        "jj diagnostic: original source locked",
      );
      assert.equal(
        stateReads,
        readsBefore + 1,
        "failure reloads once, never retries",
      );
    } else
      assert.equal(
        stateReads,
        readsBefore,
        "known warning state needs no recovery read",
      );
    assert.equal(
      squashes.length,
      1,
      "remaining batches must be canceled, not retried",
    );
    assert.deepEqual(
      selections,
      [],
      "stopped squashes must cancel the automatic handoff",
    );
    await expect(page.locator(".squash-file")).toBeDisabled();
  }
  assert.deepEqual(errors, []);
  console.log(
    "Squash navigation passed: cold read-only previews, latest-only final-version handoff, immutable context, shortcut guards, late/missing reads, return/cancel, @, warning and failure.",
  );
} finally {
  // Express handlers must finish before server.close(), including assertion
  // failures that leave a squash or demand-preview request deliberately held.
  for (const held of gates) held.release();
  await fixture.close();
}
