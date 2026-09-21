import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  parseFile,
  parseListing,
  parseRevisionListing,
  reconcileListing,
} from "../server/diff.ts";
import { jj, run } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

function entry(id: string, file: string, rows: string[], context = ""): string {
  const additions = rows.filter((row) => row.startsWith("+")).length;
  const deletions = rows.filter((row) => row.startsWith("-")).length;
  return `${id} ${file}${context ? ` ${context}` : ""} (+${additions} -${deletions})\n${rows.map((row, i) => `${String(i + 1).padStart(2)}:${row}`).join("\n")}\n\n`;
}

const rows = [" context", "-before", "+after", " ", " trailing  "];
const patch = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,4 +1,4 @@ function example()
 context
-before
+after
 
 trailing  
`;

test("whole-revision listing groups exact paths and preserves order, suffixes and row whitespace", () => {
  const output =
    entry("abcdef0", "a.ts", rows, "function example() (+9 -8)") +
    entry("1234567", "a.tsx", ["+other"]) +
    entry("abcdef0-2", "a.ts", ["+second"]) +
    entry("fedcba9", "__proto__", ["+safe map key"]);
  const listing = parseRevisionListing(output, ["a.ts", "a.tsx", "__proto__"]);
  assert.deepEqual(listing.get("a.ts"), [
    { id: "abcdef0", rows },
    { id: "abcdef0-2", rows: ["+second"] },
  ]);
  assert.deepEqual(listing.get("a.tsx"), [{ id: "1234567", rows: ["+other"] }]);
  assert.deepEqual(listing.get("__proto__"), [
    { id: "fedcba9", rows: ["+safe map key"] },
  ]);
});

test("compatibility parser supports context and rejects other files", () => {
  assert.deepEqual(
    parseListing(entry("abcdef0", "a.ts", rows, "function example()"), "a.ts"),
    [{ id: "abcdef0", rows }],
  );
  assert.deepEqual(parseListing("\n", "a.ts"), []);
  assert.throws(
    () => parseListing(entry("abcdef0", "a.tsx", rows), "a.ts"),
    /Unexpected file/,
  );
});

test("all paths are considered: whitespace paths cannot impersonate a supported prefix", () => {
  assert.throws(
    () =>
      parseRevisionListing(entry("abcdef0", "a.ts extra", rows), [
        "a.ts",
        "a.ts extra",
      ]),
    /Ambiguous file/,
  );
  assert.throws(
    () =>
      parseRevisionListing(entry("abcdef0", "a.ts", rows, "extra function()"), [
        "a.ts",
        "a.ts extra",
      ]),
    /Ambiguous file/,
  );
  assert.deepEqual(
    parseRevisionListing(entry("abcdef0", "odd name.ts", rows), [
      "odd name.ts",
    ]).get("odd name.ts"),
    [{ id: "abcdef0", rows }],
  );
});

test("unknown paths, duplicate source paths, and unattached body rows fail closed", () => {
  assert.throws(
    () => parseRevisionListing(entry("abcdef0", "unknown", rows), ["known"]),
    /Unexpected file/,
  );
  assert.throws(
    () => parseRevisionListing("", ["a", "a"]),
    /duplicate file path/,
  );
  assert.throws(() => parseRevisionListing("", [""]), /Empty/);
  assert.throws(
    () => parseRevisionListing("1:+orphan\n", ["a"]),
    /Unrecognized/,
  );
});

test("IDs must be unique across the entire listing, even in malformed files", () => {
  for (const first of [
    entry("abcdef0", "a", ["+one"]),
    "abcdef0 a (+1 -0)\n1:!invalid\n",
  ]) {
    assert.throws(
      () =>
        parseRevisionListing(first + entry("abcdef0", "b", ["+two"]), [
          "a",
          "b",
        ]),
      /Duplicate hunk ID/,
    );
  }
});

const malformed = [
  "abcdef0-0 a.ts (+1 -0)\n1:+bad suffix\n",
  "abcdef0-1 a.ts (+1 -0)\n1:+bad suffix\n",
  "abcdef0-02 a.ts (+1 -0)\n1:+bad suffix\n",
  "abcdef0-9007199254740992 a.ts (+1 -0)\n1:+unsafe suffix\n",
  "abcdef0 a.ts (+1 -0)\n", // Truncated body.
  "abcdef0 a.ts (+2 -0)\n1:+only one\n",
  "abcdef0 a.ts (+0 -1)\n1:+wrong sign\n",
  "abcdef0 a.ts (+1 -0)\n2:+out of sequence\n",
  "abcdef0 a.ts (+1 -0)\n0:+zero\n",
  "abcdef0 a.ts (+1 -0)\n9007199254740993:+unsafe index\n",
  "abcdef0 a.ts (+1 -0)\n1:+ok\n1: duplicate\n",
  "abcdef0 a.ts (+1 -0)\n1:+ok\n3: skipped\n",
  "abcdef0 a.ts (+1 -0)\n1:!unknown marker\n",
  "abcdef0 a.ts (+1 -0)\n  +compact output\n",
  "abcdef0 a.ts (+1 -0)\n1:+no newline\n2:\\ No newline at end of file\n",
  "abcdef0 a.ts (+1 -0)\n1:+ok\nwarning: unexpected stdout\n",
  "abcdef0 a.ts (+9007199254740992 -0)\n1:+unsafe count\n",
  "abcdef0 a.ts (+0 -0)\n1: context only\n",
];
for (const [i, output] of malformed.entries()) {
  test(`malformed listing ${i + 1} quarantines its whole file, preserving other files`, () => {
    const listing = parseRevisionListing(
      output +
        entry("1234567", "good.ts", ["+good"]) +
        entry("abcdef0-2", "a.ts", ["+later valid hunk"]),
      ["a.ts", "good.ts"],
    );
    assert.ok(listing.get("a.ts") instanceof Error);
    assert.throws(() => reconcileListing(parseFile(patch, "a.ts"), listing));
    assert.deepEqual(listing.get("good.ts"), [
      { id: "1234567", rows: ["+good"] },
    ]);
    assert.throws(() => parseListing(output, "a.ts"));
  });
}

test("reconciliation rejects absent, extra, reordered, and altered hunks or rows", () => {
  const file = parseFile(patch, "a.ts");
  const good = entry("abcdef0", "a.ts", rows);
  assert.deepEqual(
    reconcileListing(file, parseRevisionListing(good, ["a.ts"])),
    [{ id: "abcdef0", rows }],
  );
  for (const output of [
    "",
    good + entry("abcdef0-2", "a.ts", rows),
    entry("abcdef0", "a.ts", [...rows].reverse()),
    entry(
      "abcdef0",
      "a.ts",
      rows.map((row) => row.replace("after", "wrong")),
    ),
    entry("abcdef0", "a.ts", rows.slice(0, -1)),
    entry("abcdef0", "a.ts", [...rows, " extra context"]),
  ]) {
    assert.throws(
      () => reconcileListing(file, parseRevisionListing(output, ["a.ts"])),
      /disagree/,
    );
  }
  const twoHunks = {
    ...file,
    hunks: [
      ...file.hunks,
      {
        header: "@@ -10 +10 @@",
        rows: [{ raw: "+second", hunk: 1, index: 1 }],
      },
    ],
  };
  assert.throws(
    () =>
      reconcileListing(
        twoHunks,
        parseRevisionListing(entry("abcdef0-2", "a.ts", ["+second"]) + good, [
          "a.ts",
        ]),
      ),
    /disagree/,
  );
});

test("one real CLI listing reconciles all supported files despite mixed unsupported files", async (t) => {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-listing-test-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = await createDemo(dataDir);
  await writeFile(path.join(root, "no-newline.txt"), "unsupported");
  await writeFile(path.join(root, "odd name.txt"), "unsupported\n");
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 1, 2]));
  const source = (
    await jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  ).stdout.trim();
  const diff = (await jj(root, ["diff", "--git", "-r", source])).stdout;
  const output = (await run("jj-hunk-tool", ["hunks", "-r", source], root))
    .stdout;
  const listing = parseRevisionListing(output, [
    "src/notifications.ts",
    "src/preferences.ts",
    "tests/notifications.test.ts",
    "no-newline.txt",
    "odd name.txt",
    "binary.dat",
  ]);
  assert.ok(listing.get("no-newline.txt") instanceof Error);
  assert.equal(listing.has("binary.dat"), false);
  let reconciled = 0;
  for (const section of diff.split(/(?=^diff --git )/m).filter(Boolean)) {
    const name = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1];
    if (!name || !/^(src|tests)\//.test(name)) continue;
    const file = parseFile(section, name);
    const hunks = reconcileListing(file, listing);
    assert.equal(hunks.length, 2);
    // The tool assigns IDs before --file filtering; batching must preserve them.
    const filtered = (
      await run("jj-hunk-tool", ["hunks", "-r", source, "--file", name], root)
    ).stdout;
    assert.deepEqual(hunks, parseListing(filtered, name));
    reconciled++;
  }
  assert.equal(reconciled, 3);
});
