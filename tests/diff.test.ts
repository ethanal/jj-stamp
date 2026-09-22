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
  await writeFile(path.join(repoPath, "no-newline.txt"), "unsupported");
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
  assert.equal(supported.length, 3);
  assert.equal(state.files.filter((file) => file.unsupported).length, 3);
  const ids = supported.flatMap((file) => file.hunks.map((hunk) => hunk.id));
  assert.equal(ids.length, 6);
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
        args.includes(state.source.commitId),
    ),
  );
});
