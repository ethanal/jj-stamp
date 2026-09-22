import assert from "node:assert/strict";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import {
  changeSignature,
  combineSquashRefs,
  projectSquash,
  refsFromSelection,
  specsForRefs,
  type RowRef,
} from "../src/optimistic.ts";
import type { DiffFile, RepoState } from "../src/types.ts";

function file(
  path: string,
  body: string,
  mode: "normal" | "new" | "deleted" = "normal",
): DiffFile {
  const patch = `diff --git a/${path} b/${path}\nindex aaaaaaa..bbbbbbb 100644\n${mode === "new" ? "new file mode 100644\n" : mode === "deleted" ? "deleted file mode 100644\n" : ""}--- ${mode === "new" ? "/dev/null" : `a/${path}`}\n+++ ${mode === "deleted" ? "/dev/null" : `b/${path}`}\n${body}\n`;
  const parsed = parseFile(patch, path);
  return {
    path,
    patch,
    additions: (body.match(/^\+/gm) ?? []).length,
    deletions: (body.match(/^-/gm) ?? []).length,
    hunks: parsed.hunks.map((hunk, i) => ({ ...hunk, id: `${path}-${i}` })),
  };
}
function state(...files: DiffFile[]): RepoState {
  return {
    repo: { name: "test", path: "/test" },
    version: "v0",
    source: { changeId: "source", commitId: "commit", description: "source" },
    parent: null,
    targets: [],
    files,
    operation: "op0",
    canUndo: false,
  };
}
function select(repo: RepoState, id: string, ...lines: number[]): RowRef[] {
  return refsFromSelection(repo, { [id]: lines });
}
function validatePatches(repo: RepoState): void {
  for (const current of repo.files) {
    if (current.unsupported) continue;
    const parsed = parseFile(current.patch, current.path);
    assert.deepEqual(
      parsed.hunks.map((h) => h.header),
      current.hunks.map((h) => h.header),
    );
    assert.deepEqual(
      parsed.hunks.map((h) => h.rows.map(({ hunk: _, ...row }) => row)),
      current.hunks.map((h) =>
        h.rows.map(({ index, raw, oldLine, newLine }) => ({
          index,
          raw,
          ...(oldLine === undefined ? {} : { oldLine }),
          ...(newLine === undefined ? {} : { newLine }),
        })),
      ),
    );
  }
}

test("exact row references reject context, stale indices, duplicates and wrong source coordinates", () => {
  const repo = state(file("a", "@@ -1,3 +1,3 @@\n same\n-old\n+new\n end"));
  const refs = select(repo, "a-0", 2, 3);
  assert.deepEqual(refs, [
    { path: "a", kind: "-", line: 2, text: "old" },
    { path: "a", kind: "+", line: 2, text: "new" },
  ]);
  assert.deepEqual(specsForRefs(repo, refs), [{ id: "a-0", lines: [2, 3] }]);
  for (const lines of [[1], [0], [5], [2, 2], [1.5]])
    assert.throws(() => select(repo, "a-0", ...lines));
  assert.throws(() => select(repo, "missing", 2));
  assert.throws(() => specsForRefs(repo, [refs[0], refs[0]]), /Duplicate/);
  for (const altered of [
    { ...refs[0], line: 3 },
    { ...refs[0], path: "other" },
    { ...refs[0], text: "new" },
    { ...refs[0], kind: "+" as const },
  ])
    assert.throws(() => specsForRefs(repo, [altered]), /no longer match/);

  for (const invalidIndex of [0, 1.5]) {
    const malformed = structuredClone(repo);
    malformed.files[0].hunks[0].rows[1].index = invalidIndex;
    assert.throws(
      () => specsForRefs(malformed, [refs[0]]),
      /invalid or ambiguous tool index/,
    );
  }
  const ambiguous = structuredClone(repo);
  ambiguous.files[0].hunks[0].rows[2].index = 2;
  assert.throws(
    () => specsForRefs(ambiguous, [refs[0]]),
    /invalid or ambiguous tool index/,
  );
});

test("projection removes selected deletions, contextualizes additions and renumbers all rows", () => {
  const repo = state(
    file(
      "a",
      "@@ -1,4 +1,4 @@ section\n before\n-first\n-second\n+one\n+two\n end",
    ),
  );
  const original = structuredClone(repo);
  const projected = projectSquash(repo, select(repo, "a-0", 2, 4));
  const hunk = projected.files[0].hunks[0];
  assert.equal(hunk.id, "a-0");
  assert.equal(hunk.header, "@@ -1,4 +1,4 @@ section");
  assert.deepEqual(hunk.rows, [
    { index: 1, raw: " before", oldLine: 1, newLine: 1 },
    { index: 2, raw: "-second", oldLine: 2 },
    { index: 3, raw: " one", oldLine: 3, newLine: 2 },
    { index: 4, raw: "+two", newLine: 3 },
    { index: 5, raw: " end", oldLine: 4, newLine: 4 },
  ]);
  assert.equal(projected.files[0].additions, 1);
  assert.equal(projected.files[0].deletions, 1);
  assert.ok(!projected.files[0].patch.includes("index "));
  assert.deepEqual(repo, original);
  assert.notEqual(projected.files[0], repo.files[0]);
  assert.notEqual(hunk.rows[0], repo.files[0].hunks[0].rows[0]);
  validatePatches(projected);
});

test("cumulative old-coordinate shifts include removed prior hunks; new coordinates never shift", () => {
  const repo = state(
    file(
      "a",
      "@@ -2,0 +3,2 @@\n+x\n+y\n@@ -10,2 +12,0 @@\n-d1\n-d2\n@@ -20,2 +20,2 @@\n-old\n+new\n end",
    ),
  );
  const projected = projectSquash(
    repo,
    refsFromSelection(repo, { "a-0": [1, 2], "a-1": [1] }),
  );
  assert.equal(projected.files[0].hunks.length, 2);
  assert.equal(projected.files[0].hunks[0].header, "@@ -12,1 +12,0 @@");
  assert.deepEqual(projected.files[0].hunks[0].rows, [
    { index: 1, raw: "-d2", oldLine: 12 },
  ]);
  assert.equal(projected.files[0].hunks[1].header, "@@ -21,2 +20,2 @@");
  assert.equal(projected.files[0].hunks[1].rows[0].oldLine, 21);
  assert.equal(projected.files[0].hunks[1].rows[1].newLine, 20);
  validatePatches(projected);
});

test("pure insertion at file start uses one-based rows, not zero-based old coordinates", () => {
  const repo = state(file("a", "@@ -0,0 +1,3 @@\n+first\n+second\n+third"));
  const projected = projectSquash(repo, select(repo, "a-0", 2));
  assert.equal(projected.files[0].hunks[0].header, "@@ -1,1 +1,3 @@");
  assert.deepEqual(projected.files[0].hunks[0].rows[1], {
    index: 2,
    raw: " second",
    oldLine: 1,
    newLine: 2,
  });
  validatePatches(projected);
});

test("deleting the last old row makes a zero-count header anchored at zero", () => {
  const repo = state(file("a", "@@ -1 +1,2 @@\n-old\n+first\n+second"));
  const projected = projectSquash(repo, select(repo, "a-0", 1));
  assert.equal(projected.files[0].hunks[0].header, "@@ -0,0 +1,2 @@");
  assert.deepEqual(projected.files[0].hunks[0].rows[0], {
    index: 1,
    raw: "+first",
    newLine: 1,
  });
  validatePatches(projected);
});

test("new files become ordinary changed files on partial squash and vanish when complete", () => {
  const repo = state(file("new.txt", "@@ -0,0 +1,3 @@\n+a\n+b\n+c", "new"));
  const projected = projectSquash(repo, select(repo, "new.txt-0", 2));
  const patch = projected.files[0].patch;
  assert.match(
    patch,
    /^diff --git a\/new.txt b\/new.txt\n--- a\/new.txt\n\+\+\+ b\/new.txt\n/,
  );
  assert.ok(!patch.includes("new file mode"));
  assert.ok(!patch.includes("/dev/null"));
  assert.equal(projected.files[0].hunks[0].header, "@@ -1,1 +1,3 @@");
  validatePatches(projected);
  const finished = projectSquash(
    projected,
    select(projected, "new.txt-0", 1, 3),
  );
  assert.deepEqual(finished.files, []);
});

test("deleted files retain /dev/null and a zero new header until all changes are moved", () => {
  const repo = state(file("gone", "@@ -1,3 +0,0 @@\n-a\n-b\n-c", "deleted"));
  const projected = projectSquash(repo, select(repo, "gone-0", 1, 3));
  assert.match(
    projected.files[0].patch,
    /deleted file mode 100644\n--- a\/gone\n\+\+\+ \/dev\/null\n/,
  );
  assert.equal(projected.files[0].hunks[0].header, "@@ -1,1 +0,0 @@");
  assert.deepEqual(projected.files[0].hunks[0].rows, [
    { index: 1, raw: "-b", oldLine: 1 },
  ]);
  validatePatches(projected);
  assert.deepEqual(
    projectSquash(projected, select(projected, "gone-0", 1)).files,
    [],
  );
});

test("multiple files project independently, retaining unaffected and unsupported file identity", () => {
  const first = file("a", "@@ -1 +1 @@\n-old\n+new");
  const second = file("b", "@@ -1 +1 @@\n-old\n+new");
  const unchanged = file("c", "@@ -1 +1 @@\n-old\n+new");
  const unsupported: DiffFile = {
    path: "binary",
    patch: "Binary files differ",
    additions: 0,
    deletions: 0,
    hunks: [],
    unsupported: "Binary file",
  };
  const repo = state(first, second, unchanged, unsupported);
  const projected = projectSquash(
    repo,
    refsFromSelection(repo, { "a-0": [1, 2], "b-0": [1] }),
  );
  assert.deepEqual(
    projected.files.map((f) => f.path),
    ["b", "c", "binary"],
  );
  assert.equal(projected.files[1], unchanged);
  assert.equal(projected.files[2], unsupported);
  assert.equal(projected.files[0].hunks[0].header, "@@ -0,0 +1,1 @@");
  validatePatches(projected);
});

test("signatures ignore context, ordering, IDs and grouping but not exact changes", () => {
  const repo = state(file("a", "@@ -1,3 +1,3 @@\n before\n-old\n+new\n after"));
  const regrouped = structuredClone(repo);
  regrouped.version = "different";
  const original = regrouped.files[0].hunks[0];
  regrouped.files[0].hunks = [
    {
      id: "deletion",
      header: "@@ -2 +1,0 @@",
      rows: [{ ...original.rows[1], index: 1 }],
    },
    {
      id: "addition",
      header: "@@ -2,0 +2 @@",
      rows: [{ ...original.rows[2], index: 1 }],
    },
  ].reverse();
  assert.equal(changeSignature(regrouped), changeSignature(repo));
  const refs = select(repo, "a-0", 2, 3);
  assert.deepEqual(specsForRefs(regrouped, refs), [
    { id: "addition", lines: [1] },
    { id: "deletion", lines: [1] },
  ]);
  regrouped.files[0].hunks[0].rows[0].newLine = 3;
  assert.notEqual(changeSignature(regrouped), changeSignature(repo));
});

test("duplicate exact source rows and unsupported selection fail closed", () => {
  const repo = state(file("a", "@@ -1 +1 @@\n-old\n+new"));
  const refs = select(repo, "a-0", 1);
  const duplicate = structuredClone(repo.files[0].hunks[0]);
  duplicate.id = "other";
  repo.files[0].hunks.push(duplicate);
  assert.throws(() => specsForRefs(repo, refs), /ambiguous/);
  repo.files[0].hunks.pop();
  repo.files[0].unsupported = "not safe";
  assert.throws(() => specsForRefs(repo, refs), /unsupported/);
  assert.throws(() => refsFromSelection(repo, { "a-0": [1] }), /unsupported/);
});

test("context contracts above and below the remaining replacement", () => {
  const body = Array.from({ length: 25 }, (_, index) => {
    const line = index + 1;
    return [1, 13, 25].includes(line)
      ? `-old ${line}\n+new ${line}`
      : ` line ${line}`;
  }).join("\n");
  const repo = state(file("a", `@@ -1,25 +1,25 @@ section\n${body}`));
  const refs = refsFromSelection(repo, {
    "a-0": repo.files[0].hunks[0].rows
      .filter((row) => /^[+-](?:old|new) (?:1|25)$/.test(row.raw))
      .map((row) => row.index),
  });
  const projected = projectSquash(repo, refs);
  const [hunk] = projected.files[0].hunks;
  assert.equal(hunk.header, "@@ -10,7 +10,7 @@ section");
  assert.deepEqual(
    hunk.rows.map((row) => row.raw),
    [
      " line 10",
      " line 11",
      " line 12",
      "-old 13",
      "+new 13",
      " line 14",
      " line 15",
      " line 16",
    ],
  );
  assert.deepEqual(
    specsForRefs(projected, [
      { path: "a", kind: "-", line: 13, text: "old 13" },
      { path: "a", kind: "+", line: 13, text: "new 13" },
    ]),
    [{ id: "a-0", lines: [4, 5] }],
  );
  validatePatches(projected);
});

test("seven contextualized rows split a hunk, preserving both coordinate systems and later shifts", () => {
  const before = Array.from({ length: 6 }, (_, i) => ` before ${i}`);
  const middle = Array.from({ length: 7 }, (_, i) => `+middle ${i}`);
  const after = Array.from({ length: 6 }, (_, i) => ` after ${i}`);
  const repo = state(
    file(
      "a",
      [
        "@@ -10,14 +30,21 @@ section",
        ...before,
        "-old",
        "+new",
        ...middle,
        "-old",
        "+new",
        ...after,
        "@@ -40,1 +67,1 @@ later",
        "-old",
        "+new",
      ].join("\n"),
    ),
  );
  const projected = projectSquash(
    repo,
    select(repo, "a-0", 9, 10, 11, 12, 13, 14, 15),
  );
  const hunks = projected.files[0].hunks;
  assert.deepEqual(
    hunks.map((h) => h.header),
    [
      "@@ -13,7 +33,7 @@ section",
      "@@ -21,7 +41,7 @@ section",
      "@@ -47,1 +67,1 @@ later",
    ],
  );
  assert.equal(hunks[0].id, "a-0");
  assert.equal(new Set(hunks.map((h) => h.id)).size, 3);
  assert.deepEqual(
    hunks.slice(0, 2).map((h) => h.rows.map((r) => r.index)),
    [
      [1, 2, 3, 4, 5, 6, 7, 8],
      [1, 2, 3, 4, 5, 6, 7, 8],
    ],
  );
  assert.ok(!projected.files[0].patch.includes("middle 3"));
  const remaining = refsFromSelection(projected, {
    [hunks[0].id]: [4, 5],
    [hunks[1].id]: [4, 5],
    "a-1": [1, 2],
  });
  assert.deepEqual(remaining, [
    { path: "a", kind: "-", line: 16, text: "old" },
    { path: "a", kind: "+", line: 36, text: "new" },
    { path: "a", kind: "-", line: 24, text: "old" },
    { path: "a", kind: "+", line: 44, text: "new" },
    { path: "a", kind: "-", line: 47, text: "old" },
    { path: "a", kind: "+", line: 67, text: "new" },
  ]);
  // Confirmed tool output can have unrelated IDs and body indices. Queue
  // dispatch must still match exact source coordinates, even with repeated text.
  const confirmed = structuredClone(projected);
  confirmed.files[0].hunks.forEach((h, i) => {
    h.id = `confirmed-${i}`;
    h.rows.forEach((row) => (row.index += 10));
  });
  assert.equal(changeSignature(confirmed), changeSignature(projected));
  assert.deepEqual(specsForRefs(confirmed, remaining.slice(2, 4)), [
    { id: "confirmed-1", lines: [14, 15] },
  ]);
  const next = projectSquash(projected, remaining.slice(0, 2));
  assert.equal(next.files[0].hunks.length, 2);
  assert.deepEqual(specsForRefs(next, remaining.slice(2, 4)), [
    { id: hunks[1].id, lines: [4, 5] },
  ]);
  validatePatches(projected);
  validatePatches(next);
});

test("six lines of context keep neighboring changes together; seven split", () => {
  for (const gap of [5, 6, 7]) {
    const repo = state(
      file(
        "a",
        `@@ -0,0 +1,${gap + 2} @@\n` +
          Array.from({ length: gap + 2 }, (_, i) => `+line ${i}`).join("\n"),
        "new",
      ),
    );
    const projected = projectSquash(
      repo,
      select(repo, "a-0", ...Array.from({ length: gap }, (_, i) => i + 2)),
    );
    assert.equal(projected.files[0].hunks.length, gap > 6 ? 2 : 1);
    assert.equal(projected.files[0].additions, 2);
    validatePatches(projected);
  }
});

test("new-file partial squashes trim contextualized edges without losing file existence or coordinates", () => {
  const repo = state(
    file(
      "new.txt",
      "@@ -0,0 +1,21 @@\n" +
        Array.from({ length: 21 }, (_, i) => `+line ${i + 1}`).join("\n"),
      "new",
    ),
  );
  const moved = Array.from({ length: 21 }, (_, i) => i + 1).filter(
    (i) => i !== 11,
  );
  const projected = projectSquash(repo, select(repo, "new.txt-0", ...moved));
  assert.equal(projected.files[0].hunks[0].header, "@@ -8,6 +8,7 @@");
  assert.deepEqual(
    projected.files[0].hunks[0].rows.map((r) => r.raw),
    [
      " line 8",
      " line 9",
      " line 10",
      "+line 11",
      " line 12",
      " line 13",
      " line 14",
    ],
  );
  assert.ok(!projected.files[0].patch.includes("/dev/null"));
  assert.ok(!projected.files[0].patch.includes("new file mode"));
  assert.deepEqual(select(projected, "new.txt-0", 4), [
    { path: "new.txt", kind: "+", line: 11, text: "line 11" },
  ]);
  validatePatches(projected);
  assert.deepEqual(
    projectSquash(projected, select(projected, "new.txt-0", 4)).files,
    [],
  );
});

test("deleted-file separated selections compact remaining deletions rather than inventing context", () => {
  const repo = state(
    file(
      "gone",
      "@@ -1,21 +0,0 @@\n" +
        Array.from({ length: 21 }, (_, i) => `-line ${i + 1}`).join("\n"),
      "deleted",
    ),
  );
  const moved = Array.from({ length: 21 }, (_, i) => i + 1).filter(
    (i) => ![5, 17].includes(i),
  );
  const projected = projectSquash(repo, select(repo, "gone-0", ...moved));
  assert.equal(projected.files[0].hunks[0].header, "@@ -1,2 +0,0 @@");
  assert.deepEqual(projected.files[0].hunks[0].rows, [
    { index: 1, raw: "-line 5", oldLine: 1 },
    { index: 2, raw: "-line 17", oldLine: 2 },
  ]);
  assert.match(projected.files[0].patch, /\+\+\+ \/dev\/null/);
  validatePatches(projected);
  const next = projectSquash(projected, select(projected, "gone-0", 1));
  assert.deepEqual(select(next, "gone-0", 1), [
    { path: "gone", kind: "-", line: 1, text: "line 17" },
  ]);
  validatePatches(next);
});

test("split hunk IDs avoid existing IDs across files and remain deterministic", () => {
  const first = file(
    "a",
    "@@ -0,0 +1,9 @@\n" +
      Array.from({ length: 9 }, (_, i) => `+line ${i}`).join("\n"),
    "new",
  );
  const other = file("b", "@@ -1 +1 @@\n-old\n+new");
  other.hunks[0].id = "a-0:optimistic:1";
  const repo = state(first, other);
  const refs = select(repo, "a-0", 2, 3, 4, 5, 6, 7, 8);
  const projected = projectSquash(repo, refs);
  assert.deepEqual(projectSquash(repo, refs), projected);
  const ids = projected.files.flatMap((f) => f.hunks.map((h) => h.id));
  assert.equal(new Set(ids).size, 3);
  assert.equal(projected.files[1], other);
  assert.doesNotThrow(() =>
    refsFromSelection(projected, {
      [projected.files[0].hunks[1].id]: [4],
      [other.hunks[0].id]: [1],
    }),
  );
  validatePatches(projected);
});

test("compaction preserves exact row identity across files, hunks, repeated text and selection orders", () => {
  const repo = state(
    file(
      "a",
      "@@ -2,0 +3,2 @@\n+same\n+same\n@@ -10,2 +12,0 @@\n-same\n-same\n@@ -20,2 +20,2 @@\n-same\n+same\n end",
    ),
    file("new", "@@ -0,0 +1,3 @@\n+same\n+same\n+same", "new"),
    file("gone", "@@ -1,3 +0,0 @@\n-same\n-same\n-same", "deleted"),
  );
  let seed = 12345;
  for (let run = 0; run < 50; run++) {
    let view = repo;
    let combined: RowRef[] = [];
    while (view.files.length) {
      const available = refsFromSelection(
        view,
        Object.fromEntries(
          view.files.flatMap((file) =>
            file.hunks.map((hunk) => [
              hunk.id,
              hunk.rows
                .filter((row) => /^[+-]/.test(row.raw))
                .map((row) => row.index),
            ]),
          ),
        ),
      );
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const next = [available[seed % available.length]];
      combined = combineSquashRefs(repo, combined, next);
      view = projectSquash(view, next);
      assert.equal(
        changeSignature(projectSquash(repo, combined)),
        changeSignature(view),
      );
    }
    assert.equal(combined.length, 12);
  }
});

test("compaction rejects duplicate, stale, and already-moved references", () => {
  const repo = state(file("a", "@@ -1,2 +1,2 @@\n-old\n-old\n+new\n+new"));
  const selected = select(repo, "a-0", 1);
  const next = select(projectSquash(repo, selected), "a-0", 1);
  assert.equal(next[0].line, 1);
  assert.equal(combineSquashRefs(repo, selected, next)[1].line, 2);
  assert.throws(
    () => combineSquashRefs(repo, selected, [next[0], next[0]]),
    /Duplicate/,
  );
  assert.throws(
    () => combineSquashRefs(repo, selected, [{ ...next[0], text: "stale" }]),
    /no longer match/,
  );
  const addition = select(repo, "a-0", 3);
  assert.throws(
    () => combineSquashRefs(repo, addition, addition),
    /no longer match/,
  );
});
