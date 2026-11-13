import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFile, ranges } from "../server/diff.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,4 +1,4 @@ function example()",
  " context",
  "-before",
  "+after",
  " ",
  " trailing  ",
  "",
].join("\n");

test("native diff parser preserves exact rows, coordinates and whitespace", () => {
  const file = parseFile(patch, "a.ts");
  assert.equal(file.hunks.length, 1);
  assert.deepEqual(file.hunks[0].rows, [
    { raw: " context", oldLine: 1, newLine: 1, hunk: 0, index: 1 },
    { raw: "-before", oldLine: 2, hunk: 0, index: 2 },
    { raw: "+after", newLine: 2, hunk: 0, index: 3 },
    { raw: " ", oldLine: 3, newLine: 3, hunk: 0, index: 4 },
    { raw: " trailing  ", oldLine: 4, newLine: 4, hunk: 0, index: 5 },
  ]);
  assert.equal(ranges([1, 2, 4, 6, 7, 8]), "1-2,4,6-8");
});

test("native diff parser refuses malformed counts, unsafe coordinates and mismatched paths", () => {
  for (const broken of [
    patch.replace("-1,4", "-1,3"),
    patch.replace("+1,4", "+1,5"),
    patch.replace("-1,4", "-0,4"),
    patch.replace("+1,4", "+9007199254740991,4"),
    patch.replace("+++ b/a.ts", "+++ b/other.ts"),
    patch.replace("--- a/a.ts", "--- a/renamed.ts"),
    patch.replace(" trailing  \n", ""),
  ])
    assert.throws(() => parseFile(broken, "a.ts"));
  for (const name of [
    "odd name.ts",
    "../outside",
    "dir/../file",
    "/absolute",
    "dir//file",
    "./file",
    'quoted"file',
  ])
    assert.throws(() => parseFile(patch.replaceAll("a.ts", name), name));
});

test("pinned native hunk IDs are stable and mixed unsupported files do not require any hunk tool", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-native-hunks-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repoPath = await createDemo(directory);
  await writeFile(path.join(repoPath, "no-newline.txt"), "supported");
  await writeFile(path.join(repoPath, "odd name.txt"), "unsupported\n");
  await writeFile(path.join(repoPath, "binary.dat"), Buffer.from([0, 1, 2]));
  const diffCalls: string[][] = [];
  const options = {
    repoPath,
    toolRunner: async () => {
      throw new Error("State must not run an external hunk tool");
    },
    jjRunner: (cwd: string, args: string[]) => {
      if (args[0] === "diff") diffCalls.push(args);
      return jj(cwd, args);
    },
  };
  const service = new ReviewService(options);
  const state = await service.getState();
  const supported = state.files.filter((file) => !file.unsupported);
  assert.equal(supported.length, 4);
  assert.equal(state.files.filter((file) => file.unsupported).length, 2);
  const ids = supported.flatMap((file) => file.hunks.map((hunk) => hunk.id));
  assert.equal(ids.length, 7);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[0-9a-f]{7}(?:-\d+)?$/);
  for (const file of supported) {
    const parsed = parseFile(file.patch, file.path);
    assert.deepEqual(
      file.hunks.map(({ id: _id, ...hunk }) => hunk),
      parsed.hunks,
    );
  }
  assert.deepEqual(await service.getState(), state);
  assert.deepEqual(await new ReviewService(options).getState(), state);
  assert.ok(
    diffCalls.every(
      (args) =>
        args.includes("--ignore-working-copy") &&
        args.includes(`commit_id("${state.source.commitId}")`),
    ),
  );
});

const eofMarker = "\\ No newline at end of file";
const eofPatch = (body: string) => `--- a/eof\n+++ b/eof\n${body}`;

test("EOF markers annotate actual rows without consuming selectable indices", () => {
  const parsed = parseFile(
    eofPatch(
      `@@ -1,2 +1,2 @@\n context\n-old\n${eofMarker}\n+new\n${eofMarker}\n`,
    ),
    "eof",
  );
  assert.deepEqual(parsed.hunks[0].rows, [
    { raw: " context", oldLine: 1, newLine: 1, hunk: 0, index: 1 },
    { raw: "-old", oldLine: 2, hunk: 0, index: 2, noNewline: true },
    { raw: "+new", newLine: 2, hunk: 0, index: 3, noNewline: true },
  ]);
  const context = parseFile(
    eofPatch(`@@ -1,2 +1,2 @@\n-old\n+new\n tail\r\n${eofMarker}`),
    "eof",
  );
  assert.equal(context.hunks[0].rows.at(-1)!.raw, " tail\r");
  assert.equal(context.hunks[0].rows.at(-1)!.noNewline, true);
});

test("patch-envelope LF is independent of file-line LF", () => {
  for (const body of [
    "@@ -1 +1 @@\n-old\n+new",
    `@@ -1 +1 @@\n-old\n+new\n${eofMarker}`,
  ]) {
    assert.deepEqual(
      parseFile(eofPatch(body), "eof"),
      parseFile(eofPatch(body + "\n"), "eof"),
    );
    assert.equal(
      parseFile(eofPatch(body), "eof").hunks[0].rows[1].noNewline,
      body.endsWith(eofMarker) ? true : undefined,
    );
  }
});

test("malformed, duplicate, orphaned and non-EOF markers fail closed", () => {
  for (const body of [
    `${eofMarker}\n@@ -1 +1 @@\n-old\n+new\n`,
    `@@ -1 +1 @@\n${eofMarker}\n-old\n+new\n`,
    `@@ -1 +1 @@\n-old\n+new\n${eofMarker}\n${eofMarker}\n`,
    `@@ -1 +1 @@\n-old\n+new\n${eofMarker} extra\n`,
    `@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of fil\n`,
    `@@ -1 +1 @@\n-old\n+\n${eofMarker}\n`,
    `@@ -1,2 +1 @@\n-old\n${eofMarker}\n-more\n+new\n`,
    `@@ -1 +1,2 @@\n-old\n+new\n${eofMarker}\n+more\n`,
    `@@ -1,2 +1,2 @@\n context\n${eofMarker}\n-old\n+new\n`,
    `@@ -1 +1 @@\n-old\n${eofMarker}\n+new\n@@ -2 +2 @@\n-more\n+MORE\n`,
    `@@ -1 +1 @@\n-old\n+new\n${eofMarker}\n@@ -2 +2 @@\n-more\n+MORE\n`,
    `@@ -1 +1 @@\n-old\n${eofMarker}\n+new\n@@ -2,0 +2 @@\n+more\n`,
  ])
    assert.throws(() => parseFile(eofPatch(body), "eof"), body);
});

test("native hunk identity includes EOF marker metadata, not just raw row text", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-eof-ids-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repoPath = await createDemo(directory);
  const name = "eof-id.txt";
  await writeFile(path.join(repoPath, name), "old\n");
  await jj(repoPath, ["commit", "-m", "EOF base"]);
  await writeFile(path.join(repoPath, name), "new\n");
  const service = new ReviewService({ repoPath });
  const before = (await service.getState()).files.find(
    (file) => file.path === name,
  )!.hunks[0];
  await writeFile(path.join(repoPath, name), "new");
  const after = (await service.getState()).files.find(
    (file) => file.path === name,
  )!.hunks[0];
  assert.equal(before.header, after.header);
  assert.deepEqual(
    before.rows.map((row) => row.raw),
    after.rows.map((row) => row.raw),
  );
  assert.notEqual(before.id, after.id);
  assert.equal(after.rows.at(-1)!.noNewline, true);
});
