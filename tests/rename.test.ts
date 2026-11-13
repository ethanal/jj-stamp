import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import { jj } from "../server/process.ts";
import { materializeSelection } from "../server/selection.ts";
import { ApiError, ReviewService, type ReviewHunk } from "../server/service.ts";

const renamePatch = (
  from = "old/file.txt",
  to = "new/file.txt",
  body = "--- a/old/file.txt\n+++ b/new/file.txt\n@@ -1 +1 @@\n-old\n+new\n",
) =>
  `diff --git a/${from} b/${to}\nrename from ${from}\nrename to ${to}\n${body}`;
const changes = (hunk: ReviewHunk) =>
  hunk.rows.filter((row) => /^[+-]/.test(row.raw)).map((row) => row.index);
const code = (value: string) => (error: unknown) =>
  error instanceof ApiError && error.code === value;

test("rename envelopes validate every path claim and retain ordinary exact rows", () => {
  const parsed = parseFile(renamePatch(), "new/file.txt");
  assert.equal(parsed.path, "new/file.txt");
  assert.equal(parsed.oldPath, "old/file.txt");
  assert.deepEqual(parsed.hunks[0].rows, [
    { raw: "-old", oldLine: 1, hunk: 0, index: 1 },
    { raw: "+new", newLine: 1, hunk: 0, index: 2 },
  ]);
  const pure = renamePatch("old/file.txt", "new/file.txt", "");
  assert.deepEqual(parseFile(pure, "new/file.txt"), {
    path: "new/file.txt",
    oldPath: "old/file.txt",
    hunks: [],
  });
  assert.deepEqual(
    parseFile(pure + "similarity index 100%\n", "new/file.txt"),
    parseFile(pure, "new/file.txt"),
  );
  assert.equal(
    parseFile(
      renamePatch().replace("rename from", "similarity index 90%\nrename from"),
      "new/file.txt",
    ).hunks.length,
    1,
  );
  for (const broken of [
    renamePatch().replace("rename from old/file.txt\n", ""),
    renamePatch().replace("rename to new/file.txt\n", ""),
    renamePatch().replace("rename from old/file.txt", "rename from wrong.txt"),
    renamePatch().replace("rename to new/file.txt", "rename to wrong.txt"),
    renamePatch().replace("--- a/old/file.txt", "--- a/wrong.txt"),
    renamePatch().replace("+++ b/new/file.txt", "+++ b/wrong.txt"),
    renamePatch().replace(
      "diff --git a/old/file.txt",
      "diff --git a/wrong.txt",
    ),
    renamePatch().replace("b/new/file.txt\n", "b/wrong.txt\n"),
    renamePatch().replace(
      "rename from",
      "rename from old/file.txt\nrename from",
    ),
    renamePatch().replace("rename to", "rename to new/file.txt\nrename to"),
    renamePatch().replace("--- a/", "--- a/old/file.txt\n--- a/"),
    renamePatch().replace("+++ b/", "+++ b/new/file.txt\n+++ b/"),
    renamePatch().replace("--- a/old/file.txt", "--- /dev/null"),
    renamePatch().replace("+++ b/new/file.txt", "+++ /dev/null"),
    renamePatch().replace("--- a/", "new file mode 100644\n--- a/"),
    renamePatch().replace("--- a/", "deleted file mode 100644\n--- a/"),
    renamePatch().replace("--- a/", "old mode 100644\nnew mode 100755\n--- a/"),
    renamePatch().replace("--- a/", "index abc..def 100755\n--- a/"),
    renamePatch().replace("--- a/", "index abc..def 120000\n--- a/"),
    renamePatch().replace(
      "--- a/",
      "Binary files a/old and b/new differ\n--- a/",
    ),
    renamePatch().replaceAll("rename", "copy"),
    pure + "similarity index 101%\n",
    pure + "similarity index 90%\n",
    pure + "index abc..def 100644\n",
    pure + "similarity index 100%\nsimilarity index 100%\n",
    pure + "dissimilarity index 10%\n",
    pure + "unknown metadata\n",
    pure.replaceAll("new/file.txt", "old/file.txt"),
    pure + "--- a/old/file.txt\n+++ b/new/file.txt\n",
    pure + "@@ -1 +1 @@\n-old\n+new\n",
    pure + "\\ No newline at end of file\n",
  ])
    assert.throws(() => parseFile(broken, "new/file.txt"), broken);
  for (const unsafe of [
    "../outside",
    "/absolute",
    "dir/../file",
    "dir//file",
    "./file",
    "with space",
    "with\ttab",
    "with\rCR",
    'quoted"file',
    "back\\slash",
    "",
  ]) {
    assert.throws(() =>
      parseFile(renamePatch(unsafe, "new/file.txt", ""), "new/file.txt"),
    );
    assert.throws(() =>
      parseFile(renamePatch("old/file.txt", unsafe, ""), unsafe),
    );
  }
  assert.throws(() => parseFile(pure, "old/file.txt"));
});

test("native single-path materialization never silently discards a valid rename", () => {
  for (const selections of [[], [{ hunk: 0, lines: [1, 2] }]])
    assert.throws(
      () =>
        materializeSelection(
          { path: "new/file.txt", patch: renamePatch(), selections },
          Buffer.from("old\n"),
          Buffer.from("new\n"),
        ),
      /rename/i,
    );
});

async function fixture(t: test.TestContext) {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-rename-"));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  await jj(repoPath, ["git", "init", "--no-colocate", "."]);
  await jj(repoPath, ["config", "set", "--repo", "user.name", "Rename Test"]);
  await jj(repoPath, [
    "config",
    "set",
    "--repo",
    "user.email",
    "rename@example.com",
  ]);
  await jj(repoPath, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await mkdir(path.join(repoPath, "old"));
  await mkdir(path.join(repoPath, "new"));
  // Distinct multi-line content makes jj's native copy detection unambiguous.
  const base = Array.from(
    { length: 24 },
    (_, i) => `original line ${i}\n`,
  ).join("");
  const source = base.replace("original line 10\n", "modified line 10\n");
  const pure = Array.from({ length: 20 }, (_, i) => `pure move ${i}\n`).join(
    "",
  );
  const oldPath = "old/draft[1]:notes.txt";
  const newPath = "new/draft[1]:notes.txt";
  await writeFile(path.join(repoPath, oldPath), base);
  await writeFile(path.join(repoPath, "old/pure.txt"), pure);
  await writeFile(path.join(repoPath, "regular.txt"), "regular old\n");
  await jj(repoPath, ["commit", "-m", "Before renames"]);
  await rename(path.join(repoPath, oldPath), path.join(repoPath, newPath));
  await writeFile(path.join(repoPath, newPath), source);
  await rename(
    path.join(repoPath, "old/pure.txt"),
    path.join(repoPath, "new/pure.txt"),
  );
  await writeFile(path.join(repoPath, "regular.txt"), "regular new\n");
  await jj(repoPath, ["describe", "-m", "Renamed and modified"]);
  return { repoPath, oldPath, newPath, base, source, pure };
}

test("real jj renames support live and immutable review, literal old/new side reads, pure moves and watch scopes", async (t) => {
  const { repoPath, oldPath, newPath, base, source, pure } = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath,
    jjRunner: (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const state = await service.getState();
  const file = state.files.find((file) => file.path === newPath)!;
  assert.ok(file, "fixture must exercise actual jj rename detection");
  assert.equal(file.oldPath, oldPath);
  assert.equal(file.unsupported, undefined);
  assert.match(file.squashUnsupported!, /rename/i);
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  assert.equal(file.hunks.length, 1);
  const moved = state.files.find((file) => file.path === "new/pure.txt")!;
  assert.equal(moved.oldPath, "old/pure.txt");
  assert.equal(moved.unsupported, undefined);
  assert.match(moved.squashUnsupported!, /rename/i);
  assert.deepEqual(moved.hunks, []);
  assert.equal(moved.additions, 0);
  assert.equal(moved.deletions, 0);
  assert.deepEqual(
    service.getWatchPaths(),
    [newPath, "new/pure.txt", oldPath, "old/pure.txt", "regular.txt"].sort(),
  );
  const expected = {
    oldFile: { name: oldPath, contents: base },
    newFile: { name: newPath, contents: source },
  };
  assert.deepEqual(
    await service.getFile({ version: state.version, path: newPath }),
    expected,
  );
  const liveReads = calls.filter(
    (args) => args[0] === "file" && args[1] === "show",
  );
  assert.equal(liveReads.length, 2);
  for (const [index, name] of [oldPath, newPath].entries()) {
    const args = liveReads[index];
    assert.equal(args.at(-1), `root-file:${JSON.stringify(name)}`);
    assert.ok(args.indexOf("--ignore-working-copy") < args.indexOf("--"));
    assert.equal(
      args[args.indexOf("-r") + 1],
      index ? state.source.commitId : state.parent!.commitId,
    );
  }
  const commitId = state.source.commitId;
  const content = await service.getCommit({ commitId });
  assert.deepEqual(
    content.files,
    state.files,
    "immutable and live hunk IDs/metadata match",
  );
  calls.length = 0;
  assert.deepEqual(
    await service.getCommitFile({ commitId, path: newPath }),
    expected,
  );
  assert.equal(
    calls.length,
    2,
    "warm immutable descriptor only reads the two sides",
  );
  assert.equal(calls[0].at(-1), `root-file:${JSON.stringify(oldPath)}`);
  assert.equal(calls[1].at(-1), `root-file:${JSON.stringify(newPath)}`);
  assert.equal(
    calls[0][calls[0].indexOf("-r") + 1],
    `commit_id("${content.baseCommitId}")`,
  );
  assert.equal(
    calls[1][calls[1].indexOf("-r") + 1],
    `commit_id("${commitId}")`,
  );
  assert.ok(calls.every((args) => args.includes("--ignore-working-copy")));
  for (const read of [
    () => service.getFile({ version: state.version, path: "new/pure.txt" }),
    () => service.getCommitFile({ commitId, path: "new/pure.txt" }),
  ])
    assert.deepEqual(await read(), {
      oldFile: { name: "old/pure.txt", contents: pure },
      newFile: { name: "new/pure.txt", contents: pure },
    });
  // API lookup remains destination-only, and caller mutation cannot poison a cache.
  content.files[0].oldPath = "../outside";
  assert.deepEqual((await service.getCommit({ commitId })).files, state.files);
  await assert.rejects(
    service.getFile({ version: state.version, path: oldPath }),
    code("INVALID_PATH"),
  );
  await assert.rejects(
    service.getCommitFile({ commitId, path: oldPath }),
    code("INVALID_PATH"),
  );
  await assert.rejects(
    service.getCommitFile({ commitId, path: "../outside" }),
    code("INVALID_PATH"),
  );
  // Unsnapshotted edits and subsequently hidden rewrites never alter immutable sides.
  await writeFile(path.join(repoPath, newPath), "unsnapshotted replacement\n");
  assert.deepEqual(
    await service.getCommitFile({ commitId, path: newPath }),
    expected,
  );
  await jj(repoPath, ["describe", "-m", "Rewritten rename"]);
  assert.deepEqual(
    await service.getCommitFile({ commitId, path: newPath }),
    expected,
  );
  assert.deepEqual(
    await new ReviewService({ repoPath }).getCommitFile({
      commitId,
      path: newPath,
    }),
    expected,
  );
  await assert.rejects(
    service.getFile({ version: state.version, path: newPath }),
    code("STALE_STATE"),
  );
});

test("rename selections fail explicitly before preparation or mutation; unrelated file squash preserves renames", async (t) => {
  const { repoPath, oldPath, newPath, source } = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath,
    jjRunner: (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const state = await service.getState();
  const renamed = state.files.find((file) => file.path === newPath)!.hunks[0];
  const regular = state.files.find((file) => file.path === "regular.txt")!
    .hunks[0];
  const renameSelection = { id: renamed.id, lines: changes(renamed) };
  const regularSelection = { id: regular.id, lines: changes(regular) };
  calls.length = 0;
  for (const selections of [
    [renameSelection],
    [regularSelection, renameSelection],
  ]) {
    for (const attempt of [
      () => service.squashLines({ version: state.version, selections }),
      () =>
        service.preview({
          version: state.version,
          target: state.parent!.changeId,
          selections,
        }),
    ])
      await assert.rejects(
        attempt(),
        (error: unknown) =>
          error instanceof ApiError &&
          error.code === "SQUASH_UNSUPPORTED" &&
          error.status === 422 &&
          /preserve the rename/.test(error.message),
      );
  }
  assert.ok(
    !calls.some((args) => ["squash", "file"].includes(args[0])),
    "denied selection never prepares files or mutates",
  );
  assert.deepEqual(await service.getState(), state);
  const after = await service.squashLines({
    version: state.version,
    selections: [regularSelection],
  });
  assert.equal(after.state.canUndo, true);
  const retained = after.state.files.find((file) => file.path === newPath)!;
  assert.equal(retained.oldPath, oldPath);
  assert.equal(retained.unsupported, undefined);
  assert.deepEqual(
    retained.hunks,
    state.files.find((file) => file.path === newPath)!.hunks,
  );
  assert.equal(await readFile(path.join(repoPath, newPath), "utf8"), source);
  assert.equal(
    await readFile(path.join(repoPath, "regular.txt"), "utf8"),
    "regular new\n",
  );
  assert.equal(
    (
      await jj(repoPath, [
        "file",
        "show",
        "-r",
        after.state.parent!.commitId,
        "--ignore-working-copy",
        "--",
        'root-file:"regular.txt"',
      ])
    ).stdout,
    "regular new\n",
  );
  assert.deepEqual(
    (await service.undo(after.state.version)).state.files,
    state.files,
  );
});

test("live renamed file context still rejects intervening working-copy edits", async (t) => {
  const { repoPath, oldPath, newPath } = await fixture(t);
  let race = false;
  const service = new ReviewService({
    repoPath,
    jjRunner: async (cwd, args, limits) => {
      const result = await jj(cwd, args, limits);
      if (
        race &&
        args[0] === "file" &&
        args.at(-1) === `root-file:${JSON.stringify(oldPath)}`
      ) {
        race = false;
        await writeFile(path.join(repoPath, newPath), "raced edit\n");
      }
      return result;
    },
  });
  const state = await service.getState();
  race = true;
  await assert.rejects(
    service.getFile({ version: state.version, path: newPath }),
    code("STALE_STATE"),
  );
});

test("pure rename metadata never bypasses the lossless text boundary for file reads", async (t) => {
  const { repoPath } = await fixture(t);
  await writeFile(
    path.join(repoPath, "binary-old.dat"),
    Buffer.from([0, 1, 2]),
  );
  await writeFile(
    path.join(repoPath, "invalid-old.dat"),
    Buffer.from([0xff, 10]),
  );
  await jj(repoPath, ["commit", "-m", "Binary rename base"]);
  await rename(
    path.join(repoPath, "binary-old.dat"),
    path.join(repoPath, "binary-new.dat"),
  );
  await rename(
    path.join(repoPath, "invalid-old.dat"),
    path.join(repoPath, "invalid-new.dat"),
  );
  const service = new ReviewService({ repoPath });
  const state = await service.getState();
  for (const name of ["binary-new.dat", "invalid-new.dat"]) {
    const file = state.files.find((file) => file.path === name)!;
    assert.equal(file.unsupported, undefined, "metadata-only review is safe");
    assert.ok(file.oldPath);
    assert.deepEqual(file.hunks, []);
    await assert.rejects(
      service.getFile({ version: state.version, path: name }),
      code("UNSUPPORTED_DIFF"),
    );
    await assert.rejects(
      service.getCommitFile({ commitId: state.source.commitId, path: name }),
      code("UNSUPPORTED_DIFF"),
    );
  }
});
