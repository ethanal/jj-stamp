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
test("context-only and unresolved selections never produce squash specs", () => {
  assert.deepEqual(
    selectionFromRange(hunks, { start: 1, end: 10 }, getIndex),
    {},
  );
  assert.deepEqual(
    selectionFromRange(hunks, { start: 1000, end: 12 }, getIndex),
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
