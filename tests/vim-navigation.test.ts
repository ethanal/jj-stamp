import assert from "node:assert/strict";
import test from "node:test";
import type { GetLineIndexUtility } from "@pierre/diffs";
import type { LinePoint } from "../src/selection.ts";
import type { Hunk } from "../src/types.ts";
import { moveVimLine, vimLines, type VimLine } from "../src/vim-navigation.ts";

const hunks: Hunk[] = [
  {
    id: "first",
    header: "@@ -10,3 +20,4 @@",
    rows: [
      { index: 1, raw: " before", oldLine: 10, newLine: 20 },
      { index: 2, raw: "-old", oldLine: 11 },
      { index: 3, raw: "+new", newLine: 21 },
      { index: 4, raw: "+extra", newLine: 22 },
      { index: 5, raw: " after", oldLine: 12, newLine: 23 },
      {
        index: 6,
        raw: "\\ No newline at end of file",
        oldLine: 13,
        newLine: 24,
      },
    ],
  },
  {
    id: "second",
    header: "@@ -30,2 +40,1 @@",
    rows: [
      { index: 1, raw: "-gone", oldLine: 30 },
      { index: 2, raw: " end", oldLine: 31, newLine: 40 },
    ],
  },
];

const positions: Record<string, [number, number]> = {
  "deletions:5": [-2, -2],
  "additions:6": [-1, -1],
  "deletions:10": [0, 0],
  "additions:20": [0, 0],
  "deletions:11": [1, 1],
  "additions:21": [2, 1],
  "additions:22": [3, 2],
  "deletions:12": [4, 3],
  "additions:23": [4, 3],
  "deletions:13": [5, 4],
  "additions:24": [5, 4],
  "deletions:30": [7, 6],
  "deletions:31": [8, 7],
  "additions:40": [8, 7],
  "additions:50": [9, 8],
  "deletions:60": [10, Number.NaN],
  "additions:60": [Number.POSITIVE_INFINITY, 10],
};
const getIndex: GetLineIndexUtility = (line, side = "additions") =>
  positions[`${side}:${line}`];

const points = (lines: readonly VimLine[]) =>
  lines.map(({ line, side, index }) => `${index}:${side}:${line}`);

test("unified navigation candidates include patch changes and right-side context", () => {
  assert.deepEqual(points(vimLines(hunks, getIndex, "unified")), [
    "0:additions:20",
    "1:deletions:11",
    "2:additions:21",
    "3:additions:22",
    "4:additions:23",
    "7:deletions:30",
    "8:additions:40",
  ]);
});

test("split candidates include paired context on both sides and unpaired changes", () => {
  assert.deepEqual(points(vimLines(hunks, getIndex, "split")), [
    "0:deletions:10",
    "0:additions:20",
    "1:deletions:11",
    "1:additions:21",
    "2:additions:22",
    "3:deletions:12",
    "3:additions:23",
    "6:deletions:30",
    "7:deletions:31",
    "7:additions:40",
  ]);
});

test("expanded rendered context is merged, deduplicated, sorted, and validated", () => {
  const rendered: LinePoint[] = [
    { line: 6, side: "additions" },
    { line: 5, side: "deletions" },
    { line: 20, side: "additions" },
    { line: 50, side: "additions" },
    { line: 999, side: "additions" },
    { line: 60, side: "additions" },
  ];
  assert.deepEqual(points(vimLines(hunks, getIndex, "unified", rendered)), [
    "-2:deletions:5",
    "-1:additions:6",
    "0:additions:20",
    "1:deletions:11",
    "2:additions:21",
    "3:additions:22",
    "4:additions:23",
    "7:deletions:30",
    "8:additions:40",
    "9:additions:50",
  ]);

  assert.doesNotThrow(() =>
    vimLines(hunks, () => undefined, "split", [{ line: 1, side: "additions" }]),
  );
  assert.deepEqual(
    vimLines(hunks, () => undefined, "split"),
    [],
  );
  assert.equal(
    vimLines(hunks, getIndex, "split", [{ line: 60, side: "deletions" }]).some(
      (line) => line.line === 60,
    ),
    false,
  );
});

const lines: VimLine[] = [
  { index: 0, line: 10, side: "deletions" },
  { index: 0, line: 20, side: "additions" },
  { index: 1, line: 11, side: "deletions" },
  { index: 1, line: 21, side: "additions" },
  { index: 2, line: 22, side: "additions" },
  { index: 3, line: 12, side: "deletions" },
  { index: 3, line: 23, side: "additions" },
];
const point = (line: number, side: LinePoint["side"]): LinePoint => ({
  line,
  side,
});

test("missing and invalid cursors start at the first visual row without skipping", () => {
  const first = { index: 0, line: 20, side: "additions" };
  assert.deepEqual(moveVimLine(lines, null, "j", "split"), first);
  assert.deepEqual(moveVimLine(lines, null, "k", "split"), first);
  assert.deepEqual(
    moveVimLine(lines, point(999, "additions"), "l", "split"),
    first,
  );
  assert.equal(moveVimLine([], null, "j", "unified"), null);
});

test("j and k move by visual row while preferring the current side", () => {
  assert.deepEqual(
    moveVimLine(lines, point(20, "additions"), "j", "split"),
    lines[3],
  );
  assert.deepEqual(
    moveVimLine(lines, point(21, "additions"), "j", "split"),
    lines[4],
  );
  assert.deepEqual(
    moveVimLine(lines, point(22, "additions"), "j", "split"),
    lines[6],
  );
  assert.deepEqual(
    moveVimLine(lines, point(11, "deletions"), "j", "split"),
    lines[4],
  );
  assert.deepEqual(
    moveVimLine(lines, point(12, "deletions"), "k", "split"),
    lines[4],
  );
  assert.deepEqual(
    moveVimLine(lines, point(23, "additions"), "k", "split"),
    lines[4],
  );
});

test("vertical movement clamps at the first and last visual rows", () => {
  assert.deepEqual(
    moveVimLine(lines, point(10, "deletions"), "k", "split"),
    lines[0],
  );
  assert.deepEqual(
    moveVimLine(lines, point(23, "additions"), "j", "split"),
    lines[6],
  );
});

test("split h and l switch sides when a counterpart exists", () => {
  assert.deepEqual(
    moveVimLine(lines, point(21, "additions"), "h", "split"),
    lines[2],
  );
  assert.deepEqual(
    moveVimLine(lines, point(11, "deletions"), "l", "split"),
    lines[3],
  );
  assert.deepEqual(
    moveVimLine(lines, point(22, "additions"), "h", "split"),
    lines[4],
  );
});

test("unified h and l leave the current line unchanged", () => {
  assert.deepEqual(
    moveVimLine(lines, point(21, "additions"), "h", "unified"),
    lines[3],
  );
  assert.deepEqual(
    moveVimLine(lines, point(11, "deletions"), "l", "unified"),
    lines[2],
  );
});
