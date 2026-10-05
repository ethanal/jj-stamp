import assert from "node:assert/strict";
import test from "node:test";
import { findDiffMatches } from "../src/diff-search";
import type { DiffFile } from "../src/types";

const file: DiffFile = {
  path: "src/example.ts",
  additions: 1,
  deletions: 1,
  patch: "",
  hunks: [
    {
      id: "hunk-1",
      header: "@@ -4,3 +4,3 @@",
      rows: [
        {
          index: 1,
          raw: " Shared shared value",
          oldLine: 4,
          newLine: 4,
        },
        { index: 2, raw: "-Old value", oldLine: 5 },
        { index: 3, raw: "+New value", newLine: 5 },
      ],
    },
  ],
};

test("findDiffMatches searches every patch row case-insensitively", () => {
  assert.deepEqual(findDiffMatches([file], "SHARED"), [
    {
      path: file.path,
      hunkId: "hunk-1",
      rowIndex: 1,
      line: 4,
      side: "additions",
    },
  ]);
});

test("findDiffMatches preserves the old and new side for navigation", () => {
  assert.equal(findDiffMatches([file], "old")[0]?.side, "deletions");
  assert.equal(findDiffMatches([file], "new")[0]?.side, "additions");
});

test("findDiffMatches ignores empty queries and unsupported files", () => {
  assert.deepEqual(findDiffMatches([file], ""), []);
  assert.deepEqual(
    findDiffMatches([{ ...file, unsupported: "binary" }], "value"),
    [],
  );
});
