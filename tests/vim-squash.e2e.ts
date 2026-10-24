// Run with: npx tsx tests/vim-squash.e2e.ts (mock API; no jj executable needed)
import assert from "node:assert/strict";
import express from "express";
import { expect, type Locator } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import { projectSquash, refsFromSelection } from "../src/optimistic.ts";
import type { DiffFile, RepoState, Row, Selections } from "../src/types.ts";

type SquashInput = {
  version: string;
  selections: { id: string; lines: number[] }[];
};
type Gate = { promise: Promise<void>; release: () => void };

const parent = {
  changeId: "vim-squash-parent",
  changeIdPrefix: "vim-squa",
  commitId: "e".repeat(40),
  description: "Mutable parent",
};

function file(
  path: string,
  header: string,
  rows: Row[],
  kind: "regular" | "new" | "deleted" = "regular",
): DiffFile {
  const additions = rows.filter((row) => row.raw.startsWith("+")).length;
  const deletions = rows.filter((row) => row.raw.startsWith("-")).length;
  return {
    path,
    additions,
    deletions,
    hunks: [{ id: `${path}-hunk`, header, rows }],
    patch: [
      `diff --git a/${path} b/${path}`,
      ...(kind === "new" ? ["new file mode 100644"] : []),
      ...(kind === "deleted" ? ["deleted file mode 100644"] : []),
      `--- ${kind === "new" ? "/dev/null" : `a/${path}`}`,
      `+++ ${kind === "deleted" ? "/dev/null" : `b/${path}`}`,
      header,
      ...rows.map((row) => row.raw),
      "",
    ].join("\n"),
  };
}

function newFile(path: string, count: number, prefix = "added"): DiffFile {
  return file(
    path,
    `@@ -0,0 +1,${count} @@`,
    Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      raw: `+${prefix} ${index + 1}`,
      newLine: index + 1,
    })),
    "new",
  );
}

function deletedFile(path: string, count: number): DiffFile {
  return file(
    path,
    `@@ -1,${count} +0,0 @@`,
    Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      raw: `-deleted ${index + 1}`,
      oldLine: index + 1,
    })),
    "deleted",
  );
}

function state(name: string, files: DiffFile[]): RepoState {
  return {
    repo: { name: "vim-squash", path: "/tmp/vim-squash" },
    version: `${name}-v1`,
    source: {
      changeId: `vim-squash-${name}`,
      changeIdPrefix: "vim-squa",
      commitId: "1".repeat(40),
      description: `Vim squash ${name}`,
      author: "Fixture Author",
    },
    parent,
    targets: [parent],
    files,
    operation: `${name}-op1`,
    canUndo: false,
  };
}

function gate(): Gate {
  let release!: () => void;
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve;
    }),
    release,
  };
}

let serverState = state("initial", [newFile("initial.txt", 2)]);
let acknowledgements = 0;
let responseGates: Gate[] = [];
let failNext = false;
const requests: SquashInput[] = [];

const app = express();
app.use(express.json());
app.get("/api/state", (_request, response) => response.json(serverState));
app.get("/api/graph", (_request, response) =>
  response.json({
    version: serverState.version,
    rows: [{ graph: "@  ", revision: serverState.source, mutable: true }],
  }),
);
app.get("/api/events", (_request, response) => response.sendStatus(204));
app.post("/api/commit", (_request, response) =>
  response.status(404).json({ error: "No cached preview" }),
);
app.post("/api/commit-file", (_request, response) =>
  response.status(404).json({ error: "No source preview" }),
);
app.post("/api/squash-lines", async (request, response) => {
  const input = request.body as SquashInput;
  requests.push(input);
  const held = responseGates.shift();
  if (held) await held.promise;
  if (failNext) {
    failNext = false;
    response.status(500).json({
      error: "Injected Vim squash failure",
      code: "VIM_SQUASH_FAILED",
    });
    return;
  }
  const selected = Object.fromEntries(
    input.selections.map((selection) => [selection.id, selection.lines]),
  ) as Selections;
  const refs = refsFromSelection(serverState, selected);
  acknowledgements++;
  const projected = projectSquash(serverState, refs);
  const commitId = ((acknowledgements + 1) % 10).toString().repeat(40);
  serverState = {
    ...projected,
    version: `${serverState.source.changeId}-ack-${acknowledgements}`,
    operation: `ack-op-${acknowledgements}`,
    canUndo: true,
    source: { ...projected.source, commitId },
  };
  response.json({ state: serverState });
});

const fixture = await createBrowserFixture({
  app,
  viewport: { width: 1280, height: 720 },
});
const { browser, url, errors } = fixture;
let { page } = fixture;
await page.addInitScript(() => {
  localStorage.setItem("jj-stamp.vim-mode", "true");
  localStorage.setItem("jj-stamp.file-view", "single");
  localStorage.setItem("jj-stamp.diff-style", "unified");
});

const section = (path: string) =>
  page.locator(`.file-diff-section[data-file-path="${path}"]`);
const surface = (path: string) => section(path).locator(".code-surface");
const changed = (path: string, line: number, side: "addition" | "deletion") =>
  section(path)
    .locator(`[data-line="${line}"][data-line-type="change-${side}"]`)
    .last();
const changedText = (path: string, text: string) =>
  section(path)
    .locator('[data-line][data-line-type^="change-"]')
    .filter({ hasText: text })
    .last();
const cursor = () => page.locator("[data-line][data-fold-vim-cursor]");
const selected = () => page.locator("[data-line][data-fold-selected]");
const contextSelected = () =>
  page.locator("[data-line][data-fold-context-selected]");

async function openState(next: RepoState) {
  serverState = structuredClone(next);
  acknowledgements = 0;
  responseGates = [];
  failNext = false;
  requests.length = 0;
  const loaded = page.waitForResponse((response) =>
    response.url().endsWith("/api/state"),
  );
  await page.goto(`${url}?fixture=${encodeURIComponent(next.version)}`);
  await loaded;
  if (next.files.length) {
    await expect(page.locator(".file-bar-filename")).toContainText(
      next.files[0].path,
    );
  }
}

async function useLayout(layout: "Stacked" | "Split") {
  const button = page.getByRole("button", { name: layout, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true")
    await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

async function enterVisual(row: Locator) {
  await row.click();
  await page.keyboard.press("Shift+V");
  await expect(selected().or(contextSelected())).not.toHaveCount(0);
}

async function expectCursor(
  path: string,
  line: number,
  side?: "addition" | "deletion",
) {
  await expect(cursor()).toHaveCount(1);
  await expect(cursor()).toHaveAttribute("data-line", String(line));
  if (side)
    await expect(cursor()).toHaveAttribute("data-line-type", `change-${side}`);
  await expect(surface(path)).toHaveAttribute("data-vim-mode", "normal");
  await expect(selected()).toHaveCount(0);
  await expect(contextSelected()).toHaveCount(0);
  await expect(surface(path)).toBeFocused();
}

async function expectOverlayGeometry(path: string) {
  await expect(surface(path).locator(".vim-line-cursor")).toBeVisible();
  const geometry = await surface(path).evaluate((root) => {
    const overlay = root.querySelector<HTMLElement>(".vim-line-cursor")!;
    const host = root.querySelector("diffs-container")!;
    const anchor = host.shadowRoot!.querySelector<HTMLElement>(
      "[data-line][data-fold-vim-cursor]",
    )!;
    const rootBox = root.getBoundingClientRect();
    const overlayBox = overlay.getBoundingClientRect();
    const anchorBox = anchor.getBoundingClientRect();
    return {
      left: overlayBox.left - rootBox.left,
      right: rootBox.right - overlayBox.right,
      width: overlayBox.width - rootBox.width,
      top: overlayBox.top - anchorBox.top,
      height: overlayBox.height - anchorBox.height,
      position: getComputedStyle(overlay).position,
    };
  });
  assert.equal(geometry.position, "absolute");
  for (const [name, value] of Object.entries(geometry).filter(
    ([name]) => name !== "position",
  ))
    assert(Math.abs(value as number) < 1, `${name} differs by ${value}px`);
}

try {
  await page.goto(url);
  await expect(page.locator(".code-surface")).toBeVisible();

  // A contracted seven-row range advances past rows removed or contextualized
  // by projection, leaving the cursor on the next displayed row in nav mode.
  const contraction = state("contraction", [
    newFile("contraction.txt", 14, "contract"),
  ]);
  await openState(contraction);
  await useLayout("Stacked");
  await enterVisual(changed("contraction.txt", 3, "addition"));
  for (let line = 4; line <= 9; line++) await page.keyboard.press("j");
  await expect(selected()).toHaveCount(7);
  const contractionResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await contractionResponse).status(), 200);
  await expectCursor("contraction.txt", 10, "addition");
  await expect(contextSelected()).toHaveCount(0);
  assert.deepEqual(requests[0].selections, [
    {
      id: "contraction.txt-hunk",
      lines: [3, 4, 5, 6, 7, 8, 9],
    },
  ]);
  assert.equal(serverState.files[0].additions, 7);

  // Context is a valid next cursor position, without selecting context or changes.
  const contextFile = file("context-next.txt", "@@ -1,2 +1,2 @@", [
    { index: 1, raw: "-old value", oldLine: 1 },
    { index: 2, raw: "+new value", newLine: 1 },
    { index: 3, raw: " tail", oldLine: 2, newLine: 2 },
  ]);
  await openState(state("context", [contextFile]));
  await enterVisual(changed("context-next.txt", 1, "addition"));
  const contextResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await contextResponse).status(), 200);
  await expectCursor("context-next.txt", 2);
  await expect(selected()).toHaveCount(0);
  await expect(contextSelected()).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(selected()).toHaveCount(0);
  await expect(contextSelected()).toHaveCount(0);
  await expect(cursor()).toHaveCount(1); // Normal-mode cursor remains.
  await expect(surface("context-next.txt")).toHaveAttribute(
    "data-vim-mode",
    "normal",
  );

  // Deleted-side source coordinates shift after projection. The next original
  // row ("deleted 3") is now old line 2 and must be the navigation cursor.
  await openState(state("deletion", [deletedFile("deletion.txt", 5)]));
  await enterVisual(changed("deletion.txt", 2, "deletion"));
  const deletionResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await deletionResponse).status(), 200);
  await expectCursor("deletion.txt", 2, "deletion");
  await expect(changedText("deletion.txt", "deleted 3")).toHaveAttribute(
    "data-fold-vim-cursor",
    "",
  );
  assert.deepEqual(requests[0].selections, [
    { id: "deletion.txt-hunk", lines: [2] },
  ]);
  assert.equal(serverState.files[0].deletions, 4);

  // A bounded 200-line new file exercises virtualization, repeated s, queued
  // parent remapping, optimistic focus, and real ACK states with new commit IDs.
  // Start it in a fresh page so j's initial cursor assertion is independent of
  // browser scroll restoration from the preceding projection checks.
  await page.close();
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem("jj-stamp.vim-mode", "true");
    localStorage.setItem("jj-stamp.file-view", "single");
    localStorage.setItem("jj-stamp.diff-style", "unified");
  });
  await openState(state("long", [newFile("long.txt", 200, "virtual")]));
  const firstAck = gate();
  const secondAck = gate();
  responseGates = [firstAck, secondAck];
  const viewport = page.locator(".viewer-scroll");
  await surface("long.txt").evaluate((element) =>
    (element as HTMLElement).focus({ preventScroll: true }),
  );
  await viewport.evaluate((element) => element.scrollTo(0, 0));
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBe(0);
  const renderedAdditions = section("long.txt").locator(
    '[data-line][data-line-type="change-addition"]',
  );
  await expect(renderedAdditions).not.toHaveCount(0);
  const firstDisplayed = await renderedAdditions.evaluateAll((rows) => {
    const viewport = document
      .querySelector(".viewer-scroll")!
      .getBoundingClientRect();
    return Number(
      [...rows]
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.bottom > viewport.top && box.top < viewport.bottom;
        })
        .sort(
          (left, right) =>
            left.getBoundingClientRect().top -
            right.getBoundingClientRect().top,
        )[0]
        .getAttribute("data-line"),
    );
  });
  assert(Number.isSafeInteger(firstDisplayed));
  await expect(surface("long.txt")).toBeFocused();
  await page.keyboard.press("j"); // Vim initializes on the first displayed row.
  await expect(cursor()).toHaveAttribute("data-line", String(firstDisplayed));
  const squashLine = Math.min(firstDisplayed + 15, 196);
  const direction = squashLine >= firstDisplayed ? "j" : "k";
  for (
    let line = firstDisplayed + (direction === "j" ? 1 : -1);
    direction === "j" ? line <= squashLine : line >= squashLine;
    line += direction === "j" ? 1 : -1
  ) {
    await page.keyboard.press(direction);
    await expect(cursor()).toHaveAttribute("data-line", String(line));
  }
  await page.keyboard.press("Shift+V");
  await expect(selected()).toHaveCount(1);
  await page.keyboard.press("s");
  await expect.poll(() => requests.length).toBe(1);
  await expectCursor("long.txt", squashLine + 1, "addition");
  await expect(page.getByLabel("Change line counts")).toHaveText("+199−0");
  await expectOverlayGeometry("long.txt");

  // A real user motion replaces the one-shot projected request before its ACK.
  // The stable request token must not move the cursor back or restore selection.
  await page.keyboard.press("j");
  await expectCursor("long.txt", squashLine + 2, "addition");
  firstAck.release();
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expectCursor("long.txt", squashLine + 2, "addition");

  // Re-enter visual mode to select a range, then squash behind its held ACK.
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("k");
  await expect(selected()).toHaveCount(2);
  await page.keyboard.press("s");
  await expect.poll(() => requests.length).toBe(2);
  await expectCursor("long.txt", squashLine + 3, "addition");
  await page.keyboard.press("s"); // no selection: do not squash again
  await expectCursor("long.txt", squashLine + 3, "addition");
  await expect(page.getByLabel("Change line counts")).toHaveText("+197−0");
  await page.keyboard.press("Shift+V");
  await page.keyboard.press("s");
  await expectCursor("long.txt", squashLine + 4, "addition");
  await expect(page.getByLabel("Change line counts")).toHaveText("+196−0");
  assert.equal(requests.length, 2, "only one squash request may be in flight");
  secondAck.release();
  await expect.poll(() => requests.length).toBe(3);
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(page.getByLabel("Current commit ID")).toHaveText(
    serverState.source.commitId.slice(0, 12),
  );
  await expectCursor("long.txt", squashLine + 4, "addition");
  await expectOverlayGeometry("long.txt");
  assert.deepEqual(
    requests.map((request) => request.selections),
    [
      [{ id: "long.txt-hunk", lines: [squashLine] }],
      [
        {
          id: "long.txt-hunk",
          lines: [squashLine + 1, squashLine + 2],
        },
      ],
      [{ id: "long.txt-hunk", lines: [squashLine + 3] }],
    ],
  );
  assert.notEqual(requests[0].version, requests[1].version);
  assert.notEqual(requests[1].version, requests[2].version);
  assert.equal(serverState.files[0].additions, 196);
  await page.keyboard.press("j");
  await expectCursor("long.txt", squashLine + 5, "addition");
  await page.keyboard.press("k");
  await expectCursor("long.txt", squashLine + 4, "addition");

  // Unequal replacement blocks advance to a navigation cursor in split mode.
  // On a deletion-only visual row the root overlay still spans the blank pane,
  // gutters, and center gap before and after resizing the split.
  const splitFile = file("split.txt", "@@ -10,2 +10,1 @@", [
    { index: 1, raw: "-prefix only", oldLine: 10 },
    { index: 2, raw: "-shared suffix", oldLine: 11 },
    { index: 3, raw: "+shared suffix", newLine: 10 },
  ]);
  await openState(state("split", [splitFile]));
  await useLayout("Split");
  const loneDeletion = changedText("split.txt", "prefix only");
  await enterVisual(loneDeletion);
  await expect(selected()).toHaveCount(1);
  await expect(cursor()).toHaveAttribute("data-line-type", "change-deletion");
  const blankOpposite = await cursor().evaluate((anchor) => {
    const index = anchor.getAttribute("data-line-index")!;
    const shadow = anchor.getRootNode() as ShadowRoot;
    return !shadow.querySelector(
      `[data-additions] [data-line][data-line-index="${index}"]`,
    );
  });
  assert(
    blankOpposite,
    "fixture cursor row must be blank on the addition side",
  );
  await expectOverlayGeometry("split.txt");
  const divider = page.getByRole("separator", { name: "Resize split diff" });
  await divider.press("End");
  await expect(divider).toHaveAttribute("aria-valuenow", "80");
  await expectOverlayGeometry("split.txt");
  await expect(cursor()).toHaveCount(1);
  const splitResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await splitResponse).status(), 200);
  await expect(selected()).toHaveCount(0);
  await expectCursor("split.txt", 10, "addition");
  assert.deepEqual(requests[0].selections, [
    { id: "split.txt-hunk", lines: [1] },
  ]);

  // At EOF clamp to the last remaining displayed row rather than clearing.
  await openState(state("eof", [newFile("eof.txt", 3, "eof")]));
  await useLayout("Stacked");
  await enterVisual(changed("eof.txt", 3, "addition"));
  const eofResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await eofResponse).status(), 200);
  await expectCursor("eof.txt", 2, "addition");
  await expect(changedText("eof.txt", "eof 2")).toHaveAttribute(
    "data-fold-vim-cursor",
    "",
  );

  // Removing the active file falls forward to the first remaining supported
  // file, skipping an unsupported entry. If no supported file remains, clear.
  const unsupported: DiffFile = {
    path: "unsupported.txt",
    additions: 0,
    deletions: 0,
    patch: "Binary files differ\n",
    hunks: [],
    unsupported: "Unsupported fixture",
  };
  await openState(
    state("fallback", [
      newFile("remove.txt", 1, "remove"),
      unsupported,
      newFile("fallback.txt", 2, "fallback"),
    ]),
  );
  await enterVisual(changed("remove.txt", 1, "addition"));
  const fallbackResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await fallbackResponse).status(), 200);
  await expect(page.locator(".file-bar-filename")).toHaveText("fallback.txt");
  await expectCursor("fallback.txt", 1, "addition");

  await openState(state("empty", [newFile("only.txt", 1, "only")]));
  await enterVisual(changed("only.txt", 1, "addition"));
  const emptyResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await emptyResponse).status(), 200);
  await expect(page.locator(".viewer-scroll .empty")).toHaveText(
    "No changes in this revision.",
  );
  await expect(
    page
      .locator(".viewer-scroll")
      .getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Undo", exact: true }),
  ).toHaveCount(1);
  await expect(
    page
      .locator(".statusbar")
      .getByRole("button", { name: "Undo", exact: true }),
  ).toBeEnabled();
  await expect(cursor()).toHaveCount(0);
  await expect(selected()).toHaveCount(0);
  await expect(contextSelected()).toHaveCount(0);

  // Clicking the status-bar action also exits visual mode and preserves focus.
  await openState(state("button", [newFile("button.txt", 4, "button")]));
  await enterVisual(changed("button.txt", 1, "addition"));
  const buttonResponse = page.waitForResponse("**/api/squash-lines");
  const squashButton = page.getByRole("button", {
    name: "Squash",
    exact: true,
  });
  await squashButton.click();
  assert.equal((await buttonResponse).status(), 200);
  await expectCursor("button.txt", 2, "addition");
  await expect(squashButton).toBeDisabled();
  await page.keyboard.press("j");
  await expectCursor("button.txt", 3, "addition");
  await page.keyboard.press("s");
  await expectCursor("button.txt", 3, "addition");
  assert.equal(requests.length, 1);

  // A failed mutation rolls the optimistic patch back to the confirmed state,
  // clears Vim visual state/cursor, and never leaves the speculative next row.
  await openState(state("failure", [newFile("failure.txt", 3, "failure")]));
  failNext = true;
  await enterVisual(changed("failure.txt", 2, "addition"));
  const failed = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await failed).status(), 500);
  await expect(page.getByRole("alert")).toContainText(
    "Injected Vim squash failure",
  );
  await expect(page.getByLabel("Change line counts")).toHaveText("+3−0");
  await expect(changed("failure.txt", 2, "addition")).toBeVisible();
  await expect(cursor()).toHaveCount(0);
  await expect(selected()).toHaveCount(0);
  await expect(contextSelected()).toHaveCount(0);
  await expect(surface("failure.txt")).toHaveAttribute(
    "data-vim-mode",
    "normal",
  );

  // Outside Vim mode, squash retains the existing behavior: selection clears
  // instead of automatically entering another visual row.
  await openState(state("nonvim", [newFile("nonvim.txt", 3, "nonvim")]));
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("checkbox", { name: "Vim mode", exact: true }).uncheck();
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(surface("nonvim.txt")).toHaveAttribute("data-vim-mode", "off");
  await changed("nonvim.txt", 1, "addition").click();
  await expect(selected()).toHaveCount(1);
  const nonVimResponse = page.waitForResponse("**/api/squash-lines");
  await page.keyboard.press("s");
  assert.equal((await nonVimResponse).status(), 200);
  await expect(selected()).toHaveCount(0);
  await expect(contextSelected()).toHaveCount(0);
  await expect(cursor()).toHaveCount(0);

  assert.deepEqual(errors, []);
  console.log(
    "Vim squash checks passed: contraction/context advance, deletion remap, virtual queued ACKs, split overlay, EOF/file fallbacks, failure rollback, Escape and non-Vim clear.",
  );
} finally {
  await fixture.close();
}
