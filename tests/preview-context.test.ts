import assert from "node:assert/strict";
import test from "node:test";
import { assertExactPreview, parseFile } from "../server/diff.ts";

function patch(
  rows: string[],
  oldStart = 10,
  newStart = 40,
  path = "example.ts",
): string {
  const oldCount = rows.filter((row) => row[0] !== "+").length;
  const newCount = rows.filter((row) => row[0] !== "-").length;
  return `--- a/${path}\n+++ b/${path}\n@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n${rows.join("\n")}\n`;
}

function selection(source: string, selected: string[], path = "example.ts") {
  const hunk = parseFile(source, path).hunks[0];
  return {
    patch: source,
    path,
    hunk,
    lines: hunk.rows
      .filter((row) => selected.includes(row.raw))
      .map((row) => row.index),
  };
}

const before = [" before one", " before two", " before three"];
const after = [" after one", " after two", " after three"];
const deletions = Array.from({ length: 13 }, (_, i) => `-unselected ${i}`);
const retained = deletions.map((row) => ` ${row.slice(1)}`);
const changes = ["-selected old", "+selected new"];

for (const side of ["leading", "trailing", "both"] as const) {
  test(`accept exact three-row normalization of ${side} converted-deletion context`, () => {
    const leading = side !== "trailing";
    const trailing = side !== "leading";
    const source = patch([
      ...before,
      ...(leading ? deletions : []),
      ...changes,
      ...(trailing ? deletions : []),
      ...after,
    ]);
    const picks = [selection(source, changes)];
    const legacy = [
      ...before,
      ...(leading ? retained : []),
      ...changes,
      ...(trailing ? retained : []),
      ...after,
    ];
    const normalized = [
      ...(leading ? retained.slice(-3) : before),
      ...changes,
      ...(trailing ? retained.slice(0, 3) : after),
    ];
    const removed = leading ? 13 : 0;
    assert.doesNotThrow(() => assertExactPreview(patch(legacy), picks));
    assert.doesNotThrow(() =>
      assertExactPreview(patch(normalized, 10 + removed, 40 + removed), picks),
    );
    for (const [oldStart, newStart] of [
      [11 + removed, 40 + removed],
      [10 + removed, 41 + removed],
      [11 + removed, 41 + removed],
      [10, 40],
    ]) {
      if (oldStart === 10 + removed && newStart === 40 + removed) continue;
      assert.throws(() =>
        assertExactPreview(patch(normalized, oldStart, newStart), picks),
      );
    }
  });
}

test("internal converted deletions and original context remain byte-exact", () => {
  const middle = [" context with trailing spaces  ", ...deletions, " "];
  const second = ["-second old", "+second new"];
  const source = patch([
    ...before,
    ...deletions,
    ...changes,
    ...middle,
    ...second,
    ...after,
  ]);
  const picks = [selection(source, [...changes, ...second])];
  const normalized = [
    ...retained.slice(-3),
    ...changes,
    ...middle.map((row) => (row[0] === "-" ? ` ${row.slice(1)}` : row)),
    ...second,
    ...after,
  ];
  assertExactPreview(patch(normalized, 23, 53), picks);
  for (const altered of [
    normalized.filter((row) => row !== " unselected 4"),
    normalized.map((row) => row.trimEnd()),
    normalized.map((row) => (row === " unselected 4" ? " corrupted" : row)),
    normalized.map((row) => (row === " unselected 4" ? "-unselected 4" : row)),
    [...normalized.slice(0, 6), "+extra change", ...normalized.slice(6)],
    normalized.filter((row) => row !== "+second new"),
    normalized.map((row) => (row === "-selected old" ? "+selected old" : row)),
  ]) {
    assert.throws(() => assertExactPreview(patch(altered, 23, 53), picks));
  }
});

test("reject arbitrary context removal, extra context, and changed retained outer context", () => {
  const source = patch([...before, ...deletions, ...changes, ...after]);
  const picks = [selection(source, changes)];
  const normalized = [...retained.slice(-3), ...changes, ...after];
  for (const [rows, oldStart, newStart] of [
    [changes, 26, 56], // Zero context would preserve positions but weaken matching.
    [normalized.slice(1), 24, 54],
    [normalized.slice(0, -1), 23, 53],
    [[...retained.slice(-4), ...changes, ...after], 22, 52],
    [[" unrelated", ...normalized], 22, 52],
    [
      normalized.map((row) => (row === " after two" ? " altered" : row)),
      23,
      53,
    ],
  ] as const) {
    assert.throws(() =>
      assertExactPreview(patch([...rows], oldStart, newStart), picks),
    );
  }
});

test("malformed counts, wrong file, extra sections and hunk regrouping still fail closed", () => {
  const source = patch([...before, ...deletions, ...changes, ...after]);
  const picks = [selection(source, changes)];
  const normalized = patch(
    [...retained.slice(-3), ...changes, ...after],
    23,
    53,
  );
  for (const altered of [
    normalized.replace("-23,7", "-23,8"),
    normalized.replace("+53,7", "+53,6"),
    normalized.replaceAll("example.ts", "another.ts"),
    normalized + normalized,
    normalized + "@@ -30,1 +60,1 @@\n-old\n+new\n",
  ]) {
    assert.throws(() => assertExactPreview(altered, picks));
  }
});

test("ordinary boundary context and zero-count insertion/deletion hunks stay exact", () => {
  for (const [rows, oldStart, newStart] of [
    [[...changes, ...after], 1, 1],
    [[...before, ...changes], 8, 8],
    [["+insert"], 0, 1],
    [["-delete"], 1, 0],
    [["+insert"], 8, 9],
    [["-delete"], 9, 8],
  ] as const) {
    const source = patch([...rows], oldStart, newStart);
    const picks = [
      selection(
        source,
        rows.filter((row) => row[0] !== " "),
      ),
    ];
    assertExactPreview(source, picks);
    assert.throws(() =>
      assertExactPreview(patch([...rows], oldStart + 1, newStart + 1), picks),
    );
  }
});

test("multiple selected hunks retain order, identity, and independent locations", () => {
  const first = patch([...before, ...deletions, ...changes, ...after]);
  const second = patch(
    [...before, "+second insertion", ...after],
    80,
    100,
    "second.ts",
  );
  const picks = [
    selection(first, changes),
    selection(second, ["+second insertion"], "second.ts"),
  ];
  const normalized = patch(
    [...retained.slice(-3), ...changes, ...after],
    23,
    53,
  );
  assertExactPreview(normalized + second, picks);
  assert.throws(() => assertExactPreview(second + normalized, picks));
  assert.throws(() => assertExactPreview(normalized, picks));
});

for (const available of [0, 1, 2]) {
  test(`normalization retains exactly ${available} context rows on both sides`, () => {
    const tail = after.slice(0, available);
    const source = patch([...before, ...deletions, ...changes, ...tail]);
    const picks = [selection(source, changes)];
    const removed = 16 - available;
    const normalized = [
      ...(available ? retained.slice(-available) : []),
      ...changes,
      ...tail,
    ];
    assertExactPreview(patch(normalized, 10 + removed, 40 + removed), picks);
    assert.throws(() =>
      assertExactPreview(patch(normalized, 11 + removed, 41 + removed), picks),
    );
    // A generic cap-three algorithm does not match the packaged protocol.
    assert.throws(() =>
      assertExactPreview(
        patch([...retained.slice(-3), ...changes, ...tail], 23, 53),
        picks,
      ),
    );
    if (available > 0) {
      assert.throws(() => assertExactPreview(patch(changes, 26, 56), picks));
    }
  });
}

test("symmetric trimming converts empty-side anchors without shifting selected changes", () => {
  for (const [source, chosen, expected] of [
    [
      patch([...deletions, "+selected addition"]),
      ["+selected addition"],
      patch(["+selected addition"], 22, 53),
    ],
    [
      patch([...deletions, "-selected deletion", "+unselected addition"]),
      ["-selected deletion"],
      patch(["-selected deletion"], 23, 52),
    ],
    [
      patch([...deletions, "-selected deletion"], 1, 0),
      ["-selected deletion"],
      patch(["-selected deletion"], 14, 13),
    ],
    [
      patch(["-selected deletion", ...deletions], 1, 0),
      ["-selected deletion"],
      patch(["-selected deletion"], 1, 0),
    ],
    [
      patch(["+unselected addition", "+selected addition"], 0, 1),
      ["+selected addition"],
      patch(["+selected addition"], 0, 1),
    ],
  ] as const) {
    const picks = [selection(source, [...chosen])];
    assertExactPreview(expected, picks);
    const parsed = parseFile(expected, "example.ts").hunks[0];
    const header = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/.exec(parsed.header)!;
    for (const [oldOffset, newOffset] of [
      [1, 0],
      [0, 1],
      [1, 1],
    ]) {
      assert.throws(() =>
        assertExactPreview(
          patch(
            parsed.rows.map((row) => row.raw),
            Number(header[1]) + oldOffset,
            Number(header[2]) + newOffset,
          ),
          picks,
        ),
      );
    }
  }
});

test("partial file deletion restores a previously zero-length side's line position", () => {
  const rows = Array.from({ length: 9 }, (_, i) => `-line ${i + 1}`);
  const source = patch(rows, 1, 0).replace("+++ b/example.ts", "+++ /dev/null");
  const picks = [selection(source, ["-line 5"])];
  const normalized = patch(
    [
      " line 2",
      " line 3",
      " line 4",
      "-line 5",
      " line 6",
      " line 7",
      " line 8",
    ],
    2,
    2,
  ).replace("+++ b/example.ts", "+++ /dev/null");
  assertExactPreview(normalized, picks);
  assert.throws(() =>
    assertExactPreview(normalized.replace("+2,6", "+1,6"), picks),
  );
});

test("whole-hunk selections do not authorize any context trimming", () => {
  const source = patch([...before, ...changes]);
  const picks = [selection(source, changes)];
  assertExactPreview(source, picks);
  assert.throws(() => assertExactPreview(patch(changes, 13, 43), picks));
});

test("partial selections normalize legitimate short BOF/EOF context symmetrically", () => {
  for (const boundary of ["BOF", "EOF"] as const) {
    for (const available of [0, 1, 2]) {
      const leading = boundary === "BOF" ? before.slice(0, available) : before;
      const trailing = boundary === "EOF" ? after.slice(0, available) : after;
      const oldStart = boundary === "BOF" ? 1 : 10;
      const newStart = boundary === "BOF" ? 1 : 40;
      const source = patch(
        [...leading, ...changes, "+unselected addition", ...trailing],
        oldStart,
        newStart,
      );
      const picks = [selection(source, changes)];
      const removed = leading.length - available;
      const normalized = patch(
        [
          ...(available ? leading.slice(-available) : []),
          ...changes,
          ...trailing.slice(0, available),
        ],
        oldStart + removed,
        newStart + removed,
      );
      assertExactPreview(normalized, picks);
      assertExactPreview(
        patch([...leading, ...changes, ...trailing], oldStart, newStart),
        picks,
      );
      assert.throws(() =>
        assertExactPreview(
          normalized.replace("+selected new", "+altered"),
          picks,
        ),
      );
    }
  }
});
