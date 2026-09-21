import assert from "node:assert/strict";
import test from "node:test";
import type { GetLineIndexUtility } from "@pierre/diffs";
import { selectionFromRange } from "../src/selection.ts";
import type { Hunk } from "../src/types.ts";
const hunks: Hunk[] = [
  {
    id: "first",
    header: "@@ -10,3 +10,4 @@",
    rows: [
      { index: 1, raw: " before", oldLine: 10, newLine: 10 },
      { index: 2, raw: "-old", oldLine: 11 },
      { index: 3, raw: "+new", newLine: 11 },
      { index: 4, raw: "+extra", newLine: 12 },
      { index: 5, raw: " after", oldLine: 12, newLine: 13 },
    ],
  },
  {
    id: "second",
    header: "@@ -30,2 +31,2 @@",
    rows: [
      { index: 1, raw: "-second old", oldLine: 30 },
      { index: 2, raw: "+second new", newLine: 31 },
      { index: 3, raw: " end", oldLine: 31, newLine: 32 },
    ],
  },
];
// Unified indices supplied by the display renderer. Includes context outside hunks.
const getIndex: GetLineIndexUtility = (line, side = "additions") => {
  const key = `${side}:${line}`;
  const positions: Record<string, number> = {
    "additions:1": 0,
    "additions:10": 9,
    "deletions:11": 10,
    "additions:11": 11,
    "additions:12": 12,
    "additions:13": 13,
    "additions:25": 25,
    "deletions:30": 31,
    "additions:31": 32,
    "additions:32": 33,
    "additions:42": 43,
  };
  return positions[key] === undefined
    ? undefined
    : [positions[key], positions[key]];
};
test("a single addition selects its exact one-based tool row, not the hunk", () => {
  assert.deepEqual(
    selectionFromRange(hunks, { start: 12, end: 12 }, getIndex),
    { first: [4] },
  );
});
test("a single deletion never widens to its replacement", () => {
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 11, end: 11, side: "deletions" },
      getIndex,
    ),
    { first: [2] },
  );
});
test("cross-side ranges preserve exact unified order, in either drag direction", () => {
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 11, side: "deletions", end: 12, endSide: "additions" },
      getIndex,
    ),
    { first: [2, 3, 4] },
  );
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 12, side: "additions", end: 11, endSide: "deletions" },
      getIndex,
    ),
    { first: [2, 3, 4] },
  );
});
test("expanded context endpoints work across multiple original hunks", () => {
  assert.deepEqual(selectionFromRange(hunks, { start: 1, end: 42 }, getIndex), {
    first: [2, 3, 4],
    second: [1, 2],
  });
  assert.deepEqual(
    selectionFromRange(hunks, { start: 25, end: 42 }, getIndex),
    { second: [1, 2] },
  );
});
test("context-only, unresolved, and non-finite selections produce no squash specs", () => {
  assert.deepEqual(
    selectionFromRange(hunks, { start: 1, end: 10 }, getIndex),
    {},
  );
  assert.deepEqual(
    selectionFromRange(hunks, { start: 1000, end: 12 }, getIndex),
    {},
  );
  const nonFinite: GetLineIndexUtility = (line) =>
    line === 1 ? [-Infinity, -Infinity] : [Infinity, Infinity];
  assert.deepEqual(
    selectionFromRange(hunks, { start: 1, end: 2 }, nonFinite),
    {},
  );
});
test("a short range within a hundred-line hunk never selects the rest", () => {
  const hunk: Hunk = {
    id: "long",
    header: "@@ -0,0 +1,100 @@",
    rows: Array.from({ length: 100 }, (_, i) => ({
      index: i + 1,
      newLine: i + 1,
      raw: `+line ${i + 1}`,
    })),
  };
  const index: GetLineIndexUtility = (line) => [line - 1, line - 1];
  assert.deepEqual(selectionFromRange([hunk], { start: 45, end: 47 }, index), {
    long: [45, 46, 47],
  });
});

test("split ranges always select both aligned columns, regardless of drag origin", () => {
  const index: GetLineIndexUtility = (line, side = "additions") => {
    if (line === 11 && side === "deletions") return [10, 10];
    if (line === 11) return [11, 10];
    if (line === 12) return [12, 11];
    return getIndex(line, side);
  };
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 11, end: 11, side: "additions" },
      index,
      "split",
    ),
    { first: [2, 3] },
  );
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 11, end: 12, side: "additions" },
      index,
      "split",
    ),
    { first: [2, 3, 4] },
  );
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 11, end: 11, side: "deletions" },
      index,
      "split",
    ),
    { first: [2, 3] },
  );
  assert.deepEqual(
    selectionFromRange(
      hunks,
      { start: 11, end: 11, side: "deletions", endSide: "additions" },
      index,
      "split",
    ),
    { first: [2, 3] },
  );
});

test("Shift extends the controlled anchor; plain clicks and resets re-anchor", async () => {
  const { selectionAnchor } = await import("../src/selection.ts");
  const point = { line: 30, side: "additions" as const };
  const range = { start: 11, end: 12, side: "deletions" as const };
  assert.deepEqual(selectionAnchor(point, true, range), {
    line: 11,
    side: "deletions",
  });
  assert.deepEqual(selectionAnchor(point, false, range), point);
  assert.deepEqual(selectionAnchor(point, true, null), point);
});

test("editor maps old-side replacement, context, and shifted expanded lines", async () => {
  const { workingTreeLine } = await import("../src/selection.ts");
  const old = (line: number) =>
    workingTreeLine(hunks, { line, side: "deletions" });
  assert.equal(old(11), 11);
  assert.equal(old(12), 13);
  assert.equal(old(25), 26);
  assert.equal(old(30), 31);
  assert.equal(old(40), 41);
  assert.equal(workingTreeLine(hunks, { line: 25, side: "additions" }), 25);
});

test("editor maps pure deletions to surviving context, including EOF and empty files", async () => {
  const { workingTreeLine } = await import("../src/selection.ts");
  const deleted = (rows: Hunk["rows"], header: string, line = 11) =>
    workingTreeLine([{ id: "deleted", header, rows }], {
      line,
      side: "deletions",
    });
  const before = { index: 1, raw: " before", oldLine: 10, newLine: 10 };
  const removal = { index: 2, raw: "-gone", oldLine: 11 };
  const after = { index: 3, raw: " after", oldLine: 12, newLine: 11 };
  assert.equal(deleted([before, removal, after], "@@ -10,3 +10,2 @@"), 11);
  assert.equal(deleted([before, removal], "@@ -10,2 +10,1 @@"), 10);
  assert.equal(
    deleted([{ index: 1, raw: "-gone", oldLine: 1 }], "@@ -1,1 +0,0 @@", 1),
    1,
  );
});

test("editor clamps uneven replacements to their last new-side line", async () => {
  const { workingTreeLine } = await import("../src/selection.ts");
  const rows = [
    { index: 1, raw: "-one", oldLine: 1 },
    { index: 2, raw: "-two", oldLine: 2 },
    { index: 3, raw: "-three", oldLine: 3 },
    { index: 4, raw: "+first", newLine: 1 },
    { index: 5, raw: "+second", newLine: 2 },
  ];
  const hunks = [{ id: "replace", header: "@@ -1,3 +1,2 @@", rows }];
  for (const [line, expected] of [
    [1, 1],
    [2, 2],
    [3, 2],
  ])
    assert.equal(workingTreeLine(hunks, { line, side: "deletions" }), expected);
});

test("expanded context accounts for zero-context insert/delete hunk coordinates", async () => {
  const { workingTreeLine } = await import("../src/selection.ts");
  const insertion = [
    {
      id: "add",
      header: "@@ -10,0 +11,2 @@",
      rows: [
        { index: 1, raw: "+one", newLine: 11 },
        { index: 2, raw: "+two", newLine: 12 },
      ],
    },
  ];
  assert.equal(workingTreeLine(insertion, { line: 10, side: "deletions" }), 10);
  assert.equal(workingTreeLine(insertion, { line: 11, side: "deletions" }), 13);
  const deletion = [
    {
      id: "del",
      header: "@@ -10,2 +9,0 @@",
      rows: [
        { index: 1, raw: "-one", oldLine: 10 },
        { index: 2, raw: "-two", oldLine: 11 },
      ],
    },
  ];
  assert.equal(workingTreeLine(deletion, { line: 12, side: "deletions" }), 10);
});
