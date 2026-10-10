import assert from "node:assert/strict";
import test from "node:test";
import type { SelectedLineRange } from "@pierre/diffs";
import { parseFile } from "../server/diff.ts";
import {
  projectSquash,
  refsFromSelection,
  type RowRef,
} from "../src/optimistic.ts";
import type { DiffFile, RepoState, Selections } from "../src/types.ts";
import { advanceVimSelection, firstVimSelection } from "../src/vim-squash.ts";

function file(path: string, body: string): DiffFile {
  const patch = `diff --git a/${path} b/${path}\nindex aaaaaaa..bbbbbbb 100644\n--- a/${path}\n+++ b/${path}\n${body}\n`;
  const parsed = parseFile(patch, path);
  return {
    path,
    patch,
    additions: (body.match(/^\+/gm) ?? []).length,
    deletions: (body.match(/^-/gm) ?? []).length,
    hunks: parsed.hunks.map((hunk, index) => ({
      ...hunk,
      id: `${path}-${index}`,
    })),
  };
}

function state(current: DiffFile): RepoState {
  return {
    repo: { name: "test", path: "/test" },
    version: "v0",
    source: { changeId: "source", commitId: "commit", description: "source" },
    parent: null,
    targets: [],
    files: [current],
    operation: "op0",
    canUndo: false,
  };
}

function project(
  before: DiffFile,
  selections: Selections,
): { after: DiffFile | undefined; refs: RowRef[] } {
  const repo = state(before);
  const refs = refsFromSelection(repo, selections);
  return { after: projectSquash(repo, refs).files[0], refs };
}

const point = (
  start: number,
  side: "additions" | "deletions",
  end = start,
  endSide = side,
): SelectedLineRange => ({ start, side, end, endSide });

test("unified additions advance to the next addition and preserve new coordinates", () => {
  const before = file(
    "a",
    "@@ -1,2 +1,5 @@\n before\n+one\n+two\n+three\n after",
  );
  const { after, refs } = project(before, { "a-0": [2, 3] });
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(1, "additions", 2),
      "unified",
      refs,
    ),
    {
      range: point(4, "additions"),
      selections: { "a-0": [4] },
    },
  );
});

test("surviving deletions use parent coordinates shifted by selected rows", () => {
  const before = file(
    "a",
    "@@ -1,5 +1,2 @@\n before\n-first\n-second\n-third\n after",
  );
  const { after, refs } = project(before, { "a-0": [2, 3] });
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(2, "deletions", 3),
      "unified",
      refs,
    ),
    {
      range: point(2, "deletions"),
      selections: { "a-0": [2] },
    },
  );
});

test("identical surviving deletions do not inherit a consumed deletion origin", () => {
  const before = file("a", "@@ -1,2 +0,0 @@\n-same\n-same");
  const { after, refs } = project(before, { "a-0": [1] });
  assert.deepEqual(
    advanceVimSelection(before, after, point(1, "deletions"), "unified", refs),
    {
      range: point(1, "deletions"),
      selections: { "a-0": [1] },
    },
  );
});

test("partial replacements skip consumed rows and reversed ranges use their visual bottom", () => {
  const before = file(
    "a",
    "@@ -1,4 +1,5 @@\n before\n-old one\n-old two\n+new one\n+new two\n+new three\n after",
  );
  const { after, refs } = project(before, { "a-0": [2, 3, 4, 5] });
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(2, "additions", 2, "deletions"),
      "unified",
      refs,
    ),
    {
      range: point(4, "additions"),
      selections: { "a-0": [4] },
    },
  );
});

test("split mode advances by visual rows and handles an unpaired deletion", () => {
  const before = file(
    "a",
    "@@ -1,4 +1,3 @@\n before\n-old one\n-old two\n+new one\n after",
  );
  const { after, refs } = project(before, { "a-0": [2, 4] });
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(2, "deletions", 2, "additions"),
      "split",
      refs,
    ),
    {
      range: point(2, "deletions"),
      selections: { "a-0": [2] },
    },
  );
});

test("split paired targets span both panes and select both changed rows", () => {
  const before = file(
    "a",
    "@@ -0,0 +1,1 @@\n+first\n@@ -10,1 +11,1 @@\n-old\n+new",
  );
  const { after, refs } = project(before, { "a-0": [1] });
  assert.deepEqual(
    advanceVimSelection(before, after, point(1, "additions"), "split", refs),
    {
      range: point(11, "deletions", 11, "additions"),
      selections: { "a-1": [1, 2] },
    },
  );
});

test("uneven split blocks use renderer similarity alignment, not positional zip", () => {
  const before = file(
    "a",
    "@@ -10,2 +10,1 @@\n-prefix only\n-shared suffix\n+shared suffix",
  );
  // The renderer leaves the dissimilar first deletion unpaired and pairs the
  // addition with the identical second deletion. A positional zip would
  // incorrectly include row 3 in this first visual selection.
  assert.deepEqual(firstVimSelection(before, "split"), {
    range: point(10, "deletions"),
    selections: { "a-0": [1] },
  });

  const { after, refs } = project(before, { "a-0": [1] });
  assert.deepEqual(
    advanceVimSelection(before, after, point(10, "deletions"), "split", refs),
    {
      range: point(10, "deletions", 10, "additions"),
      selections: { "a-0": [1, 2] },
    },
  );
});

test("contracted context is skipped in favor of the next displayed row", () => {
  const middle = Array.from(
    { length: 10 },
    (_, index) => ` context ${index + 1}`,
  );
  const before = file(
    "a",
    `@@ -1,12 +1,12 @@\n-old first\n+new first\n${middle.join("\n")}\n-old last\n+new last`,
  );
  const { after, refs } = project(before, { "a-0": [1, 2] });
  assert.deepEqual(
    after?.hunks[0].rows.map((row) => row.raw),
    [" context 8", " context 9", " context 10", "-old last", "+new last"],
  );
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(1, "deletions", 1, "additions"),
      "unified",
      refs,
    ),
    {
      range: point(9, "additions"),
      selections: {},
    },
  );
});

test("expanded context endpoints are ordered by their file coordinates", () => {
  const before = file(
    "a",
    "@@ -10,1 +10,1 @@\n-old first\n+new first\n@@ -30,1 +30,1 @@\n-old second\n+new second",
  );
  const { after, refs } = project(before, { "a-0": [1, 2] });
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(10, "deletions", 20, "additions"),
      "unified",
      refs,
    ),
    {
      range: point(30, "deletions"),
      selections: { "a-1": [1] },
    },
  );
});

test("EOF advances by clamping to the last displayed remaining row", () => {
  const context = Array.from(
    { length: 8 },
    (_, index) => ` context ${index + 1}`,
  );
  const before = file(
    "a",
    `@@ -1,10 +1,10 @@\n-old first\n+new first\n${context.join("\n")}\n-old last\n+new last`,
  );
  const { after, refs } = project(before, { "a-0": [11, 12] });
  assert.deepEqual(
    advanceVimSelection(
      before,
      after,
      point(10, "deletions", 10, "additions"),
      "unified",
      refs,
    ),
    {
      range: point(4, "additions"),
      selections: {},
    },
  );
});

test("a removed file has no selection to advance", () => {
  const before = file("a", "@@ -1,1 +1,1 @@\n-old\n+new");
  const { after, refs } = project(before, { "a-0": [1, 2] });
  assert.equal(after, undefined);
  assert.equal(
    advanceVimSelection(
      before,
      after,
      point(1, "deletions", 1, "additions"),
      "split",
      refs,
    ),
    null,
  );
});

test("split selection fails closed for malformed or mismatched patch metadata", () => {
  const current = file("a", "@@ -4,1 +4,1 @@\n-old\n+new");
  const malformed = { ...current, patch: "not a patch" };
  const mismatched = {
    ...current,
    patch: current.patch.replace("@@ -4,1 +4,1 @@", "@@ -40,1 +40,1 @@"),
  };
  assert.equal(firstVimSelection(malformed, "split"), null);
  assert.equal(firstVimSelection(mismatched, "split"), null);

  const { after, refs } = project(current, { "a-0": [1] });
  assert.ok(after);
  assert.equal(
    advanceVimSelection(
      current,
      { ...after, patch: "not a patch" },
      point(4, "deletions"),
      "split",
      refs,
    ),
    null,
  );
});

test("first selection uses the first complete split visual row", () => {
  const current = file("a", "@@ -4,1 +4,1 @@\n-old\n+new");
  assert.deepEqual(firstVimSelection(current, "split"), {
    range: point(4, "deletions", 4, "additions"),
    selections: { "a-0": [1, 2] },
  });
});
