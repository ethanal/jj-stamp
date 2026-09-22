import assert from "node:assert/strict";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import {
  materializeSelection,
  type FileSelection,
} from "../server/selection.ts";

const path = "example.txt";
const bytes = (text: string | null) =>
  text === null ? null : Buffer.from(text);
const lines = (rows: string[]) => (rows.length ? `${rows.join("\n")}\n` : "");
function hunk(rows: string[], oldStart = 1, newStart = 1): string {
  const oldCount = rows.filter((row) => row[0] !== "+").length;
  const newCount = rows.filter((row) => row[0] !== "-").length;
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${lines(rows)}`;
}
function patch(body: string, kind: "edit" | "new" | "delete" = "edit"): string {
  return (
    `diff --git a/${path} b/${path}\n` +
    (kind === "new"
      ? "new file mode 100644\n"
      : kind === "delete"
        ? "deleted file mode 100644\n"
        : "") +
    `--- ${kind === "new" ? "/dev/null" : `a/${path}`}\n` +
    `+++ ${kind === "delete" ? "/dev/null" : `b/${path}`}\n${body}`
  );
}
function input(
  patch: string,
  selections: FileSelection["selections"],
): FileSelection {
  return { path, patch, selections };
}
function all(patch: string): FileSelection["selections"] {
  return parseFile(patch, path).hunks.map((hunk, index) => ({
    hunk: index,
    lines: hunk.rows
      .filter((row) => row.raw[0] !== " ")
      .map((row) => row.index),
  }));
}
function check(
  original: string,
  base: string | null,
  source: string | null,
  selections: FileSelection["selections"],
  expected: string | null,
) {
  const request = input(original, selections);
  const before = JSON.stringify(request);
  const baseBytes = bytes(base);
  const sourceBytes = bytes(source);
  const actual = materializeSelection(request, baseBytes, sourceBytes);
  assert.deepEqual(actual.result, bytes(expected));
  assert.equal(JSON.stringify(request), before);
  assert.deepEqual(baseBytes, bytes(base));
  assert.deepEqual(sourceBytes, bytes(source));
  assert.deepEqual(
    materializeSelection(request, baseBytes, sourceBytes),
    actual,
  );
  if (actual.preview) {
    // A displayed preview must itself describe precisely base -> result, with
    // correct existence metadata, coordinates, counts, and CRLF bytes.
    assert.deepEqual(
      materializeSelection(
        input(actual.preview, all(actual.preview)),
        baseBytes,
        actual.result,
      ).result,
      actual.result,
    );
  } else {
    assert.deepEqual(actual.result, baseBytes);
  }
  return actual;
}

test("asymmetric neutralized deletion context never relocates a selected replacement", () => {
  for (const side of ["leading", "trailing", "both"]) {
    const before = ["before 1", "before 2", "before 3"];
    const after = ["after 1", "after 2", "after 3"];
    const removed = Array.from(
      { length: 13 },
      (_, index) => `unselected ${index}`,
    );
    const leading = side !== "trailing" ? removed : [];
    const trailing = side !== "leading" ? removed : [];
    const rows = [
      ...before.map((line) => ` ${line}`),
      ...leading.map((line) => `-${line}`),
      "-selected old",
      "+selected new",
      ...trailing.map((line) => `-${line}`),
      ...after.map((line) => ` ${line}`),
    ];
    const original = patch(hunk(rows, 3, 3));
    const base = lines([
      "outside 1",
      "outside 2",
      ...before,
      ...leading,
      "selected old",
      ...trailing,
      ...after,
      "outside end",
    ]);
    const source = lines([
      "outside 1",
      "outside 2",
      ...before,
      "selected new",
      ...after,
      "outside end",
    ]);
    const picks = rows.flatMap((row, index) =>
      row === "-selected old" || row === "+selected new" ? [index + 1] : [],
    );
    check(
      original,
      base,
      source,
      [{ hunk: 0, lines: picks }],
      base.replace("selected old\n", "selected new\n"),
    );
  }
});

test("repeated identical contents are addressed only at the pinned coordinate", () => {
  const original = patch(hunk(["-same", "+changed"], 4, 4));
  check(
    original,
    "same\nsame\nsame\nsame\nsame\n",
    "same\nsame\nsame\nchanged\nsame\n",
    all(original),
    "same\nsame\nsame\nchanged\nsame\n",
  );
  assert.throws(
    () =>
      materializeSelection(
        input(original.replace("-4,1 +4,1", "-2,1 +2,1"), all(original)),
        bytes("same\nsame\nsame\nsame\nsame\n"),
        bytes("same\nsame\nsame\nchanged\nsame\n"),
      ),
    /reconstruct/,
  );
});

test("disjoint hunks retain original base coordinates and accumulate only selected deltas", () => {
  const original = patch(
    hunk(["+before"], 0, 1) +
      hunk(["-b", "+B", "+extra"], 2, 3) +
      hunk(["-d"], 4, 5) +
      hunk(["+after"], 5, 7),
  );
  const base = "a\nb\nc\nd\ne\n";
  const source = "before\na\nB\nextra\nc\ne\nafter\n";
  check(
    original,
    base,
    source,
    [
      { hunk: 3, lines: [1] },
      { hunk: 1, lines: [1, 2] },
    ],
    "a\nB\nc\nd\ne\nafter\n",
  );
  check(
    original,
    base,
    source,
    [
      { hunk: 0, lines: [1] },
      { hunk: 2, lines: [1] },
    ],
    "before\na\nb\nc\ne\n",
  );
  check(original, base, source, all(original), source);
  check(original, base, source, [], base);
});

test("zero-count insertion/deletion anchors at BOF, middle and EOF", () => {
  for (const position of [0, 1, 3]) {
    const base = ["a", "b", "c"];
    const changed = [
      ...base.slice(0, position),
      "inserted",
      ...base.slice(position),
    ];
    const insertion = patch(hunk(["+inserted"], position, position + 1));
    check(
      insertion,
      lines(base),
      lines(changed),
      all(insertion),
      lines(changed),
    );
    const deletion = patch(hunk(["-inserted"], position + 1, position));
    check(deletion, lines(changed), lines(base), all(deletion), lines(base));
  }
});

test("partial replacements independently remove minus rows and include plus rows", () => {
  const original = patch(hunk(["-old", "+new"]));
  check(original, "old\n", "new\n", [{ hunk: 0, lines: [1] }], "");
  check(original, "old\n", "new\n", [{ hunk: 0, lines: [2] }], "old\nnew\n");
  check(original, "old\n", "new\n", all(original), "new\n");
  check(original, "old\n", "new\n", [{ hunk: 0, lines: [] }], "old\n");
});

test("new files: partial, full and no selected lines preserve existence semantics", () => {
  const original = patch(hunk(["+one", "+two", "+three"], 0, 1), "new");
  check(
    original,
    null,
    "one\ntwo\nthree\n",
    [{ hunk: 0, lines: [2] }],
    "two\n",
  );
  check(
    original,
    null,
    "one\ntwo\nthree\n",
    all(original),
    "one\ntwo\nthree\n",
  );
  check(original, null, "one\ntwo\nthree\n", [], null);
  check(original, null, "one\ntwo\nthree\n", [{ hunk: 0, lines: [] }], null);
  assert.throws(
    () =>
      materializeSelection(input(patch("", "new"), []), null, Buffer.alloc(0)),
    /No text hunks/,
  );
});

test("full deletion removes the file, but partial deletion rewrites ordinary file headers", () => {
  const original = patch(hunk(["-one", "-two", "-three"], 1, 0), "delete");
  const partial = check(
    original,
    "one\ntwo\nthree\n",
    null,
    [{ hunk: 0, lines: [2] }],
    "one\nthree\n",
  );
  assert.ok(partial.preview.includes(`+++ b/${path}\n`));
  assert.ok(!partial.preview.includes("deleted file mode"));
  check(original, "one\ntwo\nthree\n", null, all(original), null);
  check(original, "one\ntwo\nthree\n", null, [], "one\ntwo\nthree\n");
});

test("empty regular files are distinct from absent files", () => {
  const addition = patch(hunk(["+new"], 0, 1));
  const deletion = patch(hunk(["-old"], 1, 0));
  assert.ok(
    !check(addition, "", "new\n", all(addition), "new\n").preview.includes(
      "new file mode",
    ),
  );
  assert.ok(
    !check(deletion, "old\n", "", all(deletion), "").preview.includes(
      "deleted file mode",
    ),
  );
  check(addition, "", "new\n", [], "");
});

test("valid UTF-8, BOM, CRLF, mixed line endings and trailing whitespace remain byte-exact", () => {
  const original = patch(
    hunk([" \ufeffstart\r", "-é 👋  \r", "+中文 é\r", " end", "+last\r"]),
  );
  check(
    original,
    "\ufeffstart\r\né 👋  \r\nend\n",
    "\ufeffstart\r\n中文 é\r\nend\nlast\r\n",
    [{ hunk: 0, lines: [2, 3] }],
    "\ufeffstart\r\n中文 é\r\nend\n",
  );
});

test("invalid UTF-8 in either pinned side and lone patch surrogates fail closed", () => {
  const original = patch(hunk(["-old", "+new"]));
  for (const bad of [
    Buffer.from([0xff, 10]),
    Buffer.from([0xc0, 0xaf, 10]),
    Buffer.from([0xed, 0xa0, 0x80, 10]),
  ]) {
    assert.throws(
      () => materializeSelection(input(original, []), bad, bytes("new\n")),
      /UTF-8/,
    );
    assert.throws(
      () => materializeSelection(input(original, []), bytes("old\n"), bad),
      /UTF-8/,
    );
  }
  assert.throws(
    () =>
      materializeSelection(
        input(original.replace("+new", "+\ud800"), []),
        bytes("old\n"),
        bytes("new\n"),
      ),
    /UTF-8/,
  );
});

test("unsupported text formats remain fail closed even with no selected rows", () => {
  const original = patch(hunk(["-old", "+new"]));
  for (const modified of [
    original + "\\ No newline at end of file\n",
    original.replace("--- a/", "old mode 100644\nnew mode 100755\n--- a/"),
    original.replace(
      "--- a/",
      "rename from original\nrename to renamed\n--- a/",
    ),
    original.replace(
      "--- a/",
      "Binary files a/example.txt and b/example.txt differ\n--- a/",
    ),
    original.replace("-old", "--- header-like"),
    original.replaceAll(path, "with space.txt"),
  ])
    assert.throws(() =>
      materializeSelection(input(modified, []), bytes("old\n"), bytes("new\n")),
    );
  assert.throws(
    () =>
      materializeSelection(input(original, []), bytes("old"), bytes("new\n")),
    /final newline/,
  );
  assert.throws(
    () =>
      materializeSelection(input(original, []), bytes("old\n"), bytes("new")),
    /final newline/,
  );
  assert.throws(
    () =>
      materializeSelection(
        input(original, []),
        bytes("old\0\n"),
        bytes("new\n"),
      ),
    /NUL/,
  );
});

test("malformed coordinates, counts, source coordinates and hunk ordering are rejected", () => {
  for (const body of [
    hunk(["-b", "+B"], 1, 1), // Matching text exists, but not here.
    hunk(["-b", "+B"], 2, 3),
    hunk(["-b", "+B"], 0, 1),
    hunk(["-b", "+B"], 20, 20),
    hunk(["-b", "+B"], 2, 2).replace("-2,1", "-2,2"),
    hunk(["-b", "+B"], 2, 2).replace("-2,1", "-9007199254740992,1"),
    hunk(["-c", "+C"], 3, 3) + hunk(["-b", "+B"], 2, 2),
    hunk(["-b", "+B"], 2, 2) + hunk(["-b", "+B"], 2, 2),
    "@@ -0,0 +0,0 @@\n",
  ])
    assert.throws(() =>
      materializeSelection(
        input(patch(body), []),
        bytes("a\nb\nc\n"),
        bytes("a\nB\nc\n"),
      ),
    );
});

test("all unselected hunks, unchanged gaps and tails must reconstruct the exact source", () => {
  const original = patch(hunk(["-b", "+B"], 2, 2) + hunk(["-d", "+D"], 4, 4));
  const picks = [{ hunk: 0, lines: [1, 2] }];
  for (const source of [
    "a\nB\nc\nWRONG\ne\n",
    "WRONG\nB\nc\nD\ne\n",
    "a\nB\nWRONG\nD\ne\n",
    "a\nB\nc\nD\nWRONG\n",
    "a\nB\nc\nD\ne\nextra\n",
  ])
    assert.throws(
      () =>
        materializeSelection(
          input(original, picks),
          bytes("a\nb\nc\nd\ne\n"),
          bytes(source),
        ),
      /reconstruct/,
    );
  assert.throws(
    () =>
      materializeSelection(
        input(original, picks),
        bytes("a\nb\nc\nWRONG\ne\n"),
        bytes("a\nB\nc\nD\ne\n"),
      ),
    /exact coordinate/,
  );
});

test("missing sides, duplicate headers and contradictory existence metadata fail closed", () => {
  const original = patch(hunk(["-old", "+new"]));
  for (const [base, source] of [
    [null, "new\n"],
    ["old\n", null],
    [null, null],
  ] as const)
    assert.throws(
      () =>
        materializeSelection(input(original, []), bytes(base), bytes(source)),
      /existence/,
    );
  for (const altered of [
    original.replace("--- a/", "new file mode 100644\n--- a/"),
    original.replace("--- a/", "deleted file mode 100644\n--- a/"),
    original.replace("--- a/", `--- a/${path}\n--- a/`),
    original.replace("+++ b/", `+++ b/${path}\n+++ b/`),
  ])
    assert.throws(
      () =>
        materializeSelection(
          input(altered, []),
          bytes("old\n"),
          bytes("new\n"),
        ),
      /existence/,
    );
});

test("selection indices must be unique, safe integers identifying changed rows", () => {
  const original = patch(hunk([" context", "-old", "+new"]));
  const invalid: FileSelection["selections"][] = [
    [{ hunk: -1, lines: [2] }],
    [{ hunk: 1, lines: [2] }],
    [{ hunk: 0.5, lines: [2] }],
    [{ hunk: NaN, lines: [2] }],
    [{ hunk: 0, lines: [0] }],
    [{ hunk: 0, lines: [1] }],
    [{ hunk: 0, lines: [4] }],
    [{ hunk: 0, lines: [2.5] }],
    [{ hunk: 0, lines: [Infinity] }],
    [{ hunk: 0, lines: [2, 2] }],
    [
      { hunk: 0, lines: [2] },
      { hunk: 0, lines: [3] },
    ],
  ];
  for (const picks of invalid)
    assert.throws(
      () =>
        materializeSelection(
          input(original, picks),
          bytes("context\nold\n"),
          bytes("context\nnew\n"),
        ),
      /selected/,
    );
});

test("every subset of multiple replacement blocks has an accurate deterministic preview", () => {
  const rows = [
    " head",
    "-a",
    "-b",
    "+A",
    "+B",
    " middle",
    "-c",
    "+C",
    " tail",
  ];
  const original = patch(hunk(rows));
  const changed = rows.flatMap((row, index) =>
    row[0] === " " ? [] : [index + 1],
  );
  for (let mask = 0; mask < 1 << changed.length; mask++) {
    const selected = changed.filter((_, index) => mask & (1 << index));
    const expected = rows.flatMap((row, index) => {
      if (
        row[0] === " " ||
        (row[0] === "-" && !selected.includes(index + 1)) ||
        (row[0] === "+" && selected.includes(index + 1))
      )
        return [row.slice(1)];
      return [];
    });
    check(
      original,
      "head\na\nb\nmiddle\nc\ntail\n",
      "head\nA\nB\nmiddle\nC\ntail\n",
      [{ hunk: 0, lines: selected }],
      lines(expected),
    );
  }
});
