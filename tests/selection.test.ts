import assert from "node:assert/strict";
import test from "node:test";
import { changed, rangeForRows, rowsForRange } from "../src/selection.ts";
import type { Hunk } from "../src/types.ts";
const hunk: Hunk = {
  id: "abcdef0",
  header: "@@ -10,5 +10,6 @@",
  rows: [
    { index: 1, raw: " before", oldLine: 10, newLine: 10 },
    { index: 2, raw: "-old A", oldLine: 11 },
    { index: 3, raw: "-old B", oldLine: 12 },
    { index: 4, raw: "+new A", newLine: 11 },
    { index: 5, raw: "+new B", newLine: 12 },
    { index: 6, raw: "+new C", newLine: 13 },
    { index: 7, raw: " after", oldLine: 13, newLine: 14 },
    { index: 8, raw: "-last old", oldLine: 14 },
    { index: 9, raw: "+last new", newLine: 15 },
  ],
};
test("unified single addition and deletion select exact patch-body indices", () => {
  assert.deepEqual(
    rowsForRange(hunk, { start: 12, end: 12, side: "additions" }, "unified"),
    [5],
  );
  assert.deepEqual(
    rowsForRange(hunk, { start: 11, end: 11, side: "deletions" }, "unified"),
    [2],
  );
});
test("unified cross-side drag includes only changed rows in patch order", () => {
  const forward = {
    start: 12,
    side: "deletions" as const,
    end: 13,
    endSide: "additions" as const,
  };
  assert.deepEqual(rowsForRange(hunk, forward, "unified"), [3, 4, 5, 6]);
  assert.deepEqual(
    rowsForRange(
      hunk,
      { start: 13, side: "additions", end: 12, endSide: "deletions" },
      "unified",
    ),
    [3, 4, 5, 6],
  );
});
test("context never becomes part of a squash", () => {
  assert.deepEqual(rowsForRange(hunk, { start: 10, end: 10 }, "unified"), []);
  assert.deepEqual(
    rowsForRange(hunk, { start: 13, end: 15 }, "unified"),
    [6, 8, 9],
  );
  assert.deepEqual(rowsForRange(hunk, { start: 1, end: 200 }, "unified"), []);
});
test("split selections match paired visual rows, including unequal change blocks", () => {
  assert.deepEqual(
    rowsForRange(hunk, { start: 11, end: 12, side: "additions" }, "split"),
    [2, 3, 4, 5],
  );
  assert.deepEqual(
    rowsForRange(hunk, { start: 13, end: 13, side: "additions" }, "split"),
    [6],
  );
  assert.deepEqual(
    rowsForRange(
      hunk,
      { start: 12, side: "deletions", end: 13, endSide: "additions" },
      "split",
    ),
    [3, 5, 6],
  );
});
test("highlight addresses preserve source-side identity", () => {
  assert.equal(rangeForRows(hunk, []), null);
  assert.deepEqual(rangeForRows(hunk, [5]), {
    start: 12,
    end: 12,
    side: "additions",
    endSide: "additions",
  });
  assert.deepEqual(
    rangeForRows(
      hunk,
      changed(hunk).map((r) => r.index),
    ),
    { start: 11, side: "deletions", end: 15, endSide: "additions" },
  );
});

test("display-only framing gives tool previews clean filenames without rename badges", async () => {
  const { displayPatch } = await import("../src/patch-display.ts");
  const { parsePatchFiles } = await import("@pierre/diffs");
  const raw =
    "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const file = parsePatchFiles(displayPatch(raw))[0].files[0];
  assert.equal(file.name, "src/app.ts");
  assert.equal(file.type, "change");
  assert.equal(displayPatch(displayPatch(raw)), displayPatch(raw));
});
