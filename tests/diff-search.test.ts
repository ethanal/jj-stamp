import assert from "node:assert/strict";
import test from "node:test";
import { searchDiffRows } from "../src/diff-search";
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

test("searchDiffRows searches every patch row case-insensitively", () => {
  assert.deepEqual(searchDiffRows([file], "SHARED", false).matches, [
    {
      path: file.path,
      hunkId: "hunk-1",
      rowIndex: 1,
      line: 4,
      side: "additions",
    },
  ]);
});

test("searchDiffRows preserves the old and new side for navigation", () => {
  assert.equal(
    searchDiffRows([file], "old", false).matches[0]?.side,
    "deletions",
  );
  assert.equal(
    searchDiffRows([file], "new", false).matches[0]?.side,
    "additions",
  );
});

test("searchDiffRows ignores empty queries and unsupported files", () => {
  assert.deepEqual(searchDiffRows([file], "", false), {
    matches: [],
    error: "",
  });
  assert.deepEqual(
    searchDiffRows([{ ...file, unsupported: "binary" }], "value", false)
      .matches,
    [],
  );
});

test("searchDiffRows supports case-insensitive regular expressions", () => {
  assert.deepEqual(
    searchDiffRows([file], "^shared\\s+shared\\s+value$", true).matches.map(
      (match) => match.rowIndex,
    ),
    [1],
  );
  assert.deepEqual(searchDiffRows([file], "^(old|new) value$", true).matches, [
    {
      path: file.path,
      hunkId: "hunk-1",
      rowIndex: 2,
      line: 5,
      side: "deletions",
    },
    {
      path: file.path,
      hunkId: "hunk-1",
      rowIndex: 3,
      line: 5,
      side: "additions",
    },
  ]);
});

test("searchDiffRows reports invalid regular expressions", () => {
  assert.deepEqual(searchDiffRows([file], "[", true), {
    matches: [],
    error: "Invalid regex",
  });
});
