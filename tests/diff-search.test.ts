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
      start: 0,
      end: 6,
    },
    {
      path: file.path,
      hunkId: "hunk-1",
      rowIndex: 1,
      line: 4,
      side: "additions",
      start: 7,
      end: 13,
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
      start: 0,
      end: 9,
    },
    {
      path: file.path,
      hunkId: "hunk-1",
      rowIndex: 3,
      line: 5,
      side: "additions",
      start: 0,
      end: 9,
    },
  ]);
});

test("searchDiffRows reports invalid regular expressions", () => {
  assert.deepEqual(searchDiffRows([file], "[", true), {
    matches: [],
    error: "Invalid regex",
  });
});

function matchesIn(text: string, query: string, regex: boolean) {
  const fixture: DiffFile = {
    ...file,
    hunks: [
      { ...file.hunks[0], rows: [{ index: 1, raw: `+${text}`, newLine: 1 }] },
    ],
  };
  return searchDiffRows([fixture], query, regex).matches.map(
    ({ start, end }) => ({
      start,
      end,
      text: text.slice(start, end),
    }),
  );
}

test("literal searches escape regex syntax and return each occurrence", () => {
  assert.deepEqual(matchesIn("a.b A.B axb", "a.b", false), [
    { start: 0, end: 3, text: "a.b" },
    { start: 4, end: 7, text: "A.B" },
  ]);
  for (const query of ["[", "\\", "$", "(x)", "a+b?", "{.*}"])
    assert.deepEqual(matchesIn(`before ${query} after`, query, false), [
      { start: 7, end: 7 + query.length, text: query },
    ]);
});

test("regex searches return precise ranges for every nonempty match", () => {
  assert.deepEqual(matchesIn("id:1 id:234", "(?<=id:)\\d+", true), [
    { start: 3, end: 4, text: "1" },
    { start: 8, end: 11, text: "234" },
  ]);
  assert.deepEqual(matchesIn("😀a😀", "^|$|(?=.)", true), []);
  assert.deepEqual(matchesIn("😀a😀", "a*", true), [
    { start: 2, end: 3, text: "a" },
  ]);
});

test("offsets stay aligned with original Unicode text", () => {
  assert.deepEqual(matchesIn("İ 😀Value VALUE", "value", false), [
    { start: 4, end: 9, text: "Value" },
    { start: 10, end: 15, text: "VALUE" },
  ]);
});
