import assert from "node:assert/strict";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import type { LinePoint } from "../src/selection.ts";
import type { DiffFile } from "../src/types.ts";
import { remapVimCursor } from "../src/vim-refresh.ts";

function file(path: string, body: string, idPrefix = path): DiffFile {
  const patch = `diff --git a/${path} b/${path}\nindex aaaaaaa..bbbbbbb 100644\n--- a/${path}\n+++ b/${path}\n${body}\n`;
  const parsed = parseFile(patch, path);
  return {
    path,
    patch,
    additions: (body.match(/^\+/gm) ?? []).length,
    deletions: (body.match(/^-/gm) ?? []).length,
    hunks: parsed.hunks.map((hunk, index) => ({
      ...hunk,
      id: `${idPrefix}-${index}`,
    })),
  };
}

const point = (
  line: number,
  side: LinePoint["side"] = "additions",
): LinePoint => ({ line, side });

test("unchanged hunk bodies retain their row offset after preceding changes", () => {
  const before = file(
    "a",
    "@@ -20,4 +20,4 @@\n repeated\n repeated\n-old\n+new\n tail",
    "old",
  );
  const after = file(
    "a",
    "@@ -5,1 +5,3 @@\n near\n+insert one\n+insert two\n@@ -20,4 +22,4 @@\n repeated\n repeated\n-old\n+new\n tail",
    "new",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(21), "unified"),
    point(23),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(22), "unified"),
    point(24),
  );
});

test("duplicate unchanged hunk bodies choose the nearest occurrence", () => {
  const body =
    "@@ -10,2 +10,2 @@\n-old\n+new\n tail\n@@ -50,2 +50,2 @@\n-old\n+new\n tail";
  const before = file("a", body, "before");
  const after = file(
    "a",
    "@@ -2,1 +2,2 @@\n start\n+extra\n@@ -10,2 +11,2 @@\n-old\n+new\n tail\n@@ -50,2 +51,2 @@\n-old\n+new\n tail",
    "after",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(50, "deletions"), "unified"),
    point(50, "deletions"),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(50), "unified"),
    point(51),
  );
});

test("an edited row is recovered from its local surrounding context", () => {
  const before = file(
    "a",
    "@@ -10,4 +10,4 @@\n alpha\n-old value\n+new value\n omega\n end",
  );
  const after = file(
    "a",
    "@@ -10,4 +10,4 @@\n alpha\n-old value edited\n+new value edited\n omega\n end",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(11, "deletions"), "unified"),
    point(11, "deletions"),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(11), "unified"),
    point(11),
  );
});

test("local context disambiguates identical content in distant hunks", () => {
  const before = file(
    "a",
    "@@ -10,3 +10,4 @@\n local before\n+same\n local after\n end\n@@ -100,3 +101,4 @@\n far before\n+same\n far after\n end",
  );
  const after = file(
    "a",
    "@@ -10,3 +10,5 @@\n local before\n+inserted\n+same\n local after\n end\n@@ -100,3 +102,4 @@\n far before\n+same\n far after\n end",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(11), "unified"),
    point(12),
  );
});

test("a removed deletion falls back to the nearest surviving displayed row", () => {
  const before = file(
    "a",
    "@@ -20,1 +20,0 @@\n-gone\n@@ -30,2 +29,2 @@\n nearby\n-old\n+new",
  );
  const after = file("a", "@@ -30,2 +30,2 @@\n nearby\n-old\n+new");

  assert.deepEqual(
    remapVimCursor(before, after, point(20, "deletions"), "unified"),
    point(30),
  );
});

test("split context preserves its side while unified context uses additions", () => {
  const before = file("a", "@@ -10,2 +20,2 @@\n context\n-old\n+new");
  const after = file("a", "@@ -12,2 +25,2 @@\n context\n-old\n+new", "fresh");

  assert.deepEqual(
    remapVimCursor(before, after, point(10, "deletions"), "split"),
    point(12, "deletions"),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(20), "unified"),
    point(25),
  );
});

test("contracted expanded context clamps to the nearest patch row", () => {
  const before = file(
    "a",
    "@@ -10,1 +10,1 @@\n-old first\n+new first\n@@ -30,1 +30,1 @@\n-old second\n+new second",
  );
  const after = file(
    "a",
    "@@ -10,1 +10,1 @@\n-old first\n+new first\n@@ -30,1 +30,1 @@\n-old second\n+new second",
    "refresh",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(20), "unified"),
    point(10),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(20, "deletions"), "split"),
    point(10, "deletions"),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(1), "unified"),
    point(10),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(100, "deletions"), "split"),
    point(30, "deletions"),
  );
});

test("empty files, path changes, and invalid cursors return null", () => {
  const before = file("a", "@@ -10,1 +10,1 @@\n-old\n+new");
  const after = file("a", "@@ -10,1 +10,1 @@\n-old\n+new", "after");
  const empty: DiffFile = {
    path: "a",
    patch: "",
    additions: 0,
    deletions: 0,
    hunks: [],
  };

  assert.equal(remapVimCursor(before, empty, point(10), "unified"), null);
  assert.equal(
    remapVimCursor(before, { ...after, path: "b" }, point(10), "unified"),
    null,
  );
  assert.equal(remapVimCursor(before, after, point(0), "unified"), null);
  assert.deepEqual(
    remapVimCursor(before, after, point(999), "unified"),
    point(10),
  );
  assert.deepEqual(
    remapVimCursor(before, after, point(9, "deletions"), "unified"),
    point(10, "deletions"),
  );
});

test("an edited row inside repeated content stays at its nearby coordinate", () => {
  const rows = Array.from({ length: 300 }, () => "+repeated");
  const edited = [...rows];
  edited[50] = "+edited";
  const before = file(
    "a",
    `@@ -1,2 +1,302 @@\n begin\n${rows.join("\n")}\n end`,
  );
  const after = file(
    "a",
    `@@ -1,2 +1,302 @@\n begin\n${edited.join("\n")}\n end`,
    "edited",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(52), "unified"),
    point(52),
  );
});

test("an inserted duplicate cursor line does not steal the original", () => {
  const before = file("a", "@@ -10,3 +10,4 @@\n before\n+same\n after\n end");
  const after = file(
    "a",
    "@@ -10,3 +10,5 @@\n before\n+same\n+same\n after\n end",
    "inserted",
  );

  assert.deepEqual(
    remapVimCursor(before, after, point(11), "unified"),
    point(12),
  );
});
