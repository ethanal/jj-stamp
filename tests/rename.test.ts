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
import { jj, run } from "../server/process.ts";
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

function checkMaterializedRename(
  patch: string,
  base: string,
  source: string,
  selections: Array<{ hunk: number; lines: number[] }>,
  expected: string,
) {
  const input = { path: "new/file.txt", patch, selections };
  const original = structuredClone(input);
  const baseBytes = Buffer.from(base);
  const sourceBytes = Buffer.from(source);
  const actual = materializeSelection(input, baseBytes, sourceBytes);
  assert.deepEqual(actual.result, Buffer.from(expected));
  assert.deepEqual(input, original);
  assert.deepEqual(baseBytes, Buffer.from(base));
  assert.deepEqual(sourceBytes, Buffer.from(source));
  if (actual.preview) {
    assert.match(
      actual.preview,
      /^diff --git a\/old\/file.txt b\/new\/file.txt\n/,
    );
    assert.ok(actual.preview.includes("rename from old/file.txt\n"));
    assert.ok(actual.preview.includes("rename to new/file.txt\n"));
    const parsed = parseFile(actual.preview, "new/file.txt");
    assert.equal(parsed.oldPath, "old/file.txt");
    assert.equal(
      parsed.hunks.length,
      selections.filter((selection) => selection.lines.length).length,
    );
    assert.deepEqual(
      materializeSelection(
        {
          path: "new/file.txt",
          patch: actual.preview,
          selections: parsed.hunks.map((hunk, index) => ({
            hunk: index,
            lines: hunk.rows
              .filter((row) => /^[+-]/.test(row.raw))
              .map((row) => row.index),
          })),
        },
        baseBytes,
        actual.result,
      ).result,
      actual.result,
    );
  } else assert.equal(expected, base);
  return actual;
}

test("rename materialization previews the move together with exactly the selected edits", () => {
  const patch = renamePatch(
    "old/file.txt",
    "new/file.txt",
    "--- a/old/file.txt\n+++ b/new/file.txt\n@@ -2 +2 @@\n-old\n+new\n@@ -5 +5 @@\n-last\n+final\n",
  );
  const base = "same\nold\ngap\ngap\nlast\ntail\n";
  const source = "same\nnew\ngap\ngap\nfinal\ntail\n";
  for (const [selections, expected] of [
    [[], base],
    [[{ hunk: 0, lines: [1] }], base.replace("old\n", "")],
    [[{ hunk: 0, lines: [2] }], base.replace("old\n", "old\nnew\n")],
    [[{ hunk: 1, lines: [1, 2] }], base.replace("last\n", "final\n")],
    [
      [
        { hunk: 0, lines: [1, 2] },
        { hunk: 1, lines: [1, 2] },
      ],
      source,
    ],
  ] as const)
    checkMaterializedRename(
      patch,
      base,
      source,
      selections.map(({ hunk, lines }) => ({ hunk, lines: [...lines] })),
      expected,
    );
  for (const badSource of [
    source.replace("tail", "raced"),
    source.replace("final", "wrong"),
  ])
    assert.throws(
      () =>
        checkMaterializedRename(
          patch,
          base,
          badSource,
          [{ hunk: 0, lines: [1, 2] }],
          source,
        ),
      /reconstruct/i,
    );
  for (const missingSide of ["base", "source"])
    assert.throws(() =>
      materializeSelection(
        {
          path: "new/file.txt",
          patch,
          selections: [{ hunk: 0, lines: [1, 2] }],
        },
        missingSide === "base" ? null : Buffer.from(base),
        missingSide === "source" ? null : Buffer.from(source),
      ),
    );
});

test("renamed EOF and CRLF edits preserve exact terminators and reject unsafe partial EOF", () => {
  const patch = renamePatch(
    "old/file.txt",
    "new/file.txt",
    "--- a/old/file.txt\n+++ b/new/file.txt\n@@ -1,3 +1,3 @@\n-old\r\n+new\r\n keep\r\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n",
  );
  const base = "old\r\nkeep\r\nbefore";
  const source = "new\r\nkeep\r\nafter";
  checkMaterializedRename(
    patch,
    base,
    source,
    [{ hunk: 0, lines: [1, 2] }],
    "new\r\nkeep\r\nbefore",
  );
  checkMaterializedRename(
    patch,
    base,
    source,
    [{ hunk: 0, lines: [4, 5] }],
    "old\r\nkeep\r\nafter",
  );
  checkMaterializedRename(
    patch,
    base,
    source,
    [{ hunk: 0, lines: [1, 2, 4, 5] }],
    source,
  );
  assert.throws(
    () =>
      materializeSelection(
        { path: "new/file.txt", patch, selections: [{ hunk: 0, lines: [5] }] },
        Buffer.from(base),
        Buffer.from(source),
      ),
    /unterminated/i,
  );
});

async function fixture(t: test.TestContext, crlfEof = false) {
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
  let base = Array.from({ length: 24 }, (_, i) => `original line ${i}\n`).join(
    "",
  );
  let source = base
    .replace("original line 10\n", "modified line 10\n")
    .replace(
      `original line ${crlfEof ? 23 : 20}\n`,
      `modified line ${crlfEof ? 23 : 20}\n`,
    );
  if (crlfEof) {
    base = base.replaceAll("\n", "\r\n").slice(0, -2);
    source = source.replaceAll("\n", "\r\n").slice(0, -2);
  }
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
    toolRunner: (command, args, cwd) => {
      calls.push(args);
      return run(command, args, cwd);
    },
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
  assert.equal(file.squashUnsupported, undefined);
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
  assert.equal(file.hunks.length, 2);
  const moved = state.files.find((file) => file.path === "new/pure.txt")!;
  assert.equal(moved.oldPath, "old/pure.txt");
  assert.equal(moved.unsupported, undefined);
  assert.equal(moved.squashUnsupported, undefined);
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

async function treeAt(repoPath: string, revision: string) {
  const listed = await jj(repoPath, [
    "file",
    "list",
    "-r",
    revision,
    "--ignore-working-copy",
  ]);
  const tree: Record<string, Buffer> = {};
  for (const name of listed.stdout.trimEnd().split("\n").filter(Boolean)) {
    const file = await jj(repoPath, [
      "file",
      "show",
      "-r",
      revision,
      "--ignore-working-copy",
      "--",
      `root-file:${JSON.stringify(name)}`,
    ]);
    tree[name] = file.stdoutBytes ?? Buffer.from(file.stdout);
  }
  return tree;
}

function withRenamedFile(
  tree: Record<string, Buffer>,
  oldPath: string,
  newPath: string,
  contents: string,
) {
  const result = { ...tree, [newPath]: Buffer.from(contents) };
  delete result[oldPath];
  return result;
}

async function assertWorkspace(
  repoPath: string,
  oldPath: string,
  expected: Record<string, Buffer>,
) {
  for (const [name, bytes] of Object.entries(expected))
    assert.deepEqual(await readFile(path.join(repoPath, name)), bytes, name);
  for (const name of [oldPath, "old/pure.txt"])
    await assert.rejects(readFile(path.join(repoPath, name)), {
      code: "ENOENT",
    });
}

test("direct and legacy rename squash move the rename and selected text into the parent and undo exactly", async (t) => {
  for (const api of ["direct", "legacy"] as const)
    for (const scope of ["partial", "all"] as const)
      for (const mixed of [false, true])
        await t.test(
          `${api}, ${scope}, ${mixed ? "mixed regular selection" : "rename only"}`,
          async (t) => {
            const { repoPath, oldPath, newPath, base, source } =
              await fixture(t);
            const calls: string[][] = [];
            const service = new ReviewService({
              repoPath,
              toolRunner: (command, args, cwd) => {
                calls.push(args);
                return run(command, args, cwd);
              },
              jjRunner: (cwd, args, limits) => {
                calls.push(args);
                return jj(cwd, args, limits);
              },
            });
            const state = await service.getState();
            const originalParent = await treeAt(
              repoPath,
              state.parent!.commitId,
            );
            const originalSource = await treeAt(
              repoPath,
              state.source.commitId,
            );
            const renamed = state.files.find((file) => file.path === newPath)!;
            assert.equal(renamed.oldPath, oldPath);
            assert.equal(renamed.squashUnsupported, undefined);
            assert.equal(renamed.hunks.length, 2);
            // A partial line selection deliberately takes only the deletion half
            // of one replacement, leaving its addition and another entire hunk.
            const selections =
              scope === "all"
                ? renamed.hunks.map((hunk) => ({
                    id: hunk.id,
                    lines: changes(hunk),
                  }))
                : [
                    {
                      id: renamed.hunks[0].id,
                      lines: renamed.hunks[0].rows
                        .filter((row) => row.raw.startsWith("-"))
                        .map((row) => row.index),
                    },
                  ];
            if (mixed) {
              const regular = state.files.find(
                (file) => file.path === "regular.txt",
              )!.hunks[0];
              selections.push({ id: regular.id, lines: changes(regular) });
            }
            const expectedParent =
              scope === "all" ? source : base.replace("original line 10\n", "");
            calls.length = 0;
            const result =
              api === "direct"
                ? await service.squashLines({
                    version: state.version,
                    selections,
                  })
                : await (async () => {
                    const preview = await service.preview({
                      version: state.version,
                      target: state.parent!.changeId,
                      selections,
                    });
                    assert.ok(
                      preview.patch.includes(
                        `diff --git a/${oldPath} b/${newPath}\n`,
                      ),
                    );
                    assert.ok(
                      preview.patch.includes(`rename from ${oldPath}\n`),
                    );
                    assert.ok(preview.patch.includes(`rename to ${newPath}\n`));
                    if (scope === "partial") {
                      assert.ok(!preview.patch.includes("+modified line 10"));
                      assert.ok(!preview.patch.includes("modified line 20"));
                    }
                    assert.equal(
                      (await service.getState()).operation,
                      state.operation,
                    );
                    return service.squash(preview.token);
                  })();
            assert.equal(result.warning, undefined);
            assert.equal(result.state.canUndo, true);
            assert.equal(result.state.source.changeId, state.source.changeId);
            assert.equal(result.state.parent!.changeId, state.parent!.changeId);
            assert.equal(
              calls.filter((args) => args[0] === "squash").length,
              1,
            );
            const mutation = calls.find((args) => args[0] === "squash")!;
            for (const name of [oldPath, newPath])
              assert.ok(
                mutation.includes(`root-file:${JSON.stringify(name)}`),
                `literal scratch scope includes ${name}`,
              );
            assert.deepEqual(
              await treeAt(repoPath, result.state.parent!.commitId),
              {
                ...withRenamedFile(
                  originalParent,
                  oldPath,
                  newPath,
                  expectedParent,
                ),
                ...(mixed
                  ? { "regular.txt": Buffer.from("regular new\n") }
                  : {}),
              },
            );
            assert.deepEqual(
              await treeAt(repoPath, result.state.source.commitId),
              originalSource,
            );
            const retained = result.state.files.find(
              (file) => file.path === newPath,
            );
            if (scope === "all") {
              assert.equal(
                retained,
                undefined,
                "all selected text and the rename leave the source diff",
              );
              await assert.rejects(
                service.getFile({
                  version: result.state.version,
                  path: newPath,
                }),
                code("INVALID_PATH"),
              );
            } else {
              assert.ok(retained);
              assert.equal(
                retained.oldPath,
                undefined,
                "remaining edits are an ordinary modification at the new path",
              );
              assert.equal(retained.unsupported, undefined);
              assert.equal(retained.squashUnsupported, undefined);
              assert.equal(retained.additions, 2);
              assert.equal(retained.deletions, 1);
              assert.ok(!retained.patch.includes("rename from"));
              assert.deepEqual(
                await service.getFile({
                  version: result.state.version,
                  path: newPath,
                }),
                {
                  oldFile: { name: newPath, contents: expectedParent },
                  newFile: { name: newPath, contents: source },
                },
              );
            }
            assert.equal(
              result.state.files.some((file) => file.path === "regular.txt"),
              !mixed,
            );
            await assertWorkspace(repoPath, oldPath, originalSource);
            const undone = await service.undo(result.state.version);
            assert.equal(undone.state.canUndo, false);
            assert.equal(undone.state.source.commitId, state.source.commitId);
            assert.equal(undone.state.parent!.commitId, state.parent!.commitId);
            assert.deepEqual(undone.state.files, state.files);
            assert.deepEqual(
              await treeAt(repoPath, undone.state.parent!.commitId),
              originalParent,
            );
            assert.deepEqual(
              await treeAt(repoPath, undone.state.source.commitId),
              originalSource,
            );
            await assertWorkspace(repoPath, oldPath, originalSource);
          },
        );
});

test("first squash carries the rename and a second batch squashes ordinary remaining edits, with exact latest-batch undo", async (t) => {
  for (const api of ["direct", "legacy"] as const)
    await t.test(api, async (t) => {
      const { repoPath, oldPath, newPath, base, source } = await fixture(t);
      const service = new ReviewService({ repoPath });
      const initial = await service.getState();
      const originalParent = await treeAt(repoPath, initial.parent!.commitId);
      const originalSource = await treeAt(repoPath, initial.source.commitId);
      const squash = async (
        state: typeof initial,
        selections: Array<{ id: string; lines: number[] }>,
      ) =>
        api === "direct"
          ? service.squashLines({ version: state.version, selections })
          : service.squash(
              (
                await service.preview({
                  version: state.version,
                  target: state.parent!.changeId,
                  selections,
                })
              ).token,
            );
      const firstHunk = initial.files.find((file) => file.path === newPath)!
        .hunks[0];
      const first = await squash(initial, [
        {
          id: firstHunk.id,
          lines: changes(firstHunk),
        },
      ]);
      const partialParent = withRenamedFile(
        originalParent,
        oldPath,
        newPath,
        base.replace("original line 10\n", "modified line 10\n"),
      );
      assert.deepEqual(
        await treeAt(repoPath, first.state.parent!.commitId),
        partialParent,
      );
      const remaining = first.state.files.find(
        (file) => file.path === newPath,
      )!;
      assert.equal(remaining.oldPath, undefined);
      assert.ok(!remaining.patch.includes("rename from"));
      assert.equal(remaining.hunks.length, 1);
      assert.equal(remaining.additions, 1);
      assert.equal(remaining.deletions, 1);
      const second = await squash(
        first.state,
        remaining.hunks.map((hunk) => ({ id: hunk.id, lines: changes(hunk) })),
      );
      assert.equal(second.warning, undefined);
      assert.equal(
        second.state.files.find((file) => file.path === newPath),
        undefined,
      );
      await assert.rejects(
        service.getFile({ version: second.state.version, path: newPath }),
        code("INVALID_PATH"),
      );
      assert.deepEqual(
        await treeAt(repoPath, second.state.parent!.commitId),
        withRenamedFile(originalParent, oldPath, newPath, source),
      );
      assert.deepEqual(
        await treeAt(repoPath, second.state.source.commitId),
        originalSource,
      );
      await assertWorkspace(repoPath, oldPath, originalSource);
      const undone = await service.undo(second.state.version);
      assert.equal(undone.state.canUndo, false);
      assert.equal(undone.state.source.commitId, first.state.source.commitId);
      assert.equal(undone.state.parent!.commitId, first.state.parent!.commitId);
      assert.deepEqual(undone.state.files, first.state.files);
      assert.deepEqual(
        await treeAt(repoPath, undone.state.parent!.commitId),
        partialParent,
      );
      assert.deepEqual(
        await treeAt(repoPath, undone.state.source.commitId),
        originalSource,
      );
      await assertWorkspace(repoPath, oldPath, originalSource);
    });
});

test("pure renames have no selectable rows and unrelated squash preserves every rename", async (t) => {
  const { repoPath, oldPath, newPath } = await fixture(t);
  const service = new ReviewService({ repoPath });
  const state = await service.getState();
  const pure = state.files.find((file) => file.path === "new/pure.txt")!;
  assert.deepEqual(pure.hunks, []);
  for (const attempt of [
    () =>
      service.squashLines({
        version: state.version,
        selections: [{ id: "pure-rename", lines: [1] }],
      }),
    () =>
      service.preview({
        version: state.version,
        target: state.parent!.changeId,
        selections: [{ id: "pure-rename", lines: [1] }],
      }),
  ])
    await assert.rejects(attempt(), code("INVALID_SELECTION"));
  assert.deepEqual(await service.getState(), state);
  const originalSource = await treeAt(repoPath, state.source.commitId);
  const originalParent = await treeAt(repoPath, state.parent!.commitId);
  const regular = state.files.find((file) => file.path === "regular.txt")!
    .hunks[0];
  const result = await service.squashLines({
    version: state.version,
    selections: [{ id: regular.id, lines: changes(regular) }],
  });
  assert.deepEqual(
    result.state.files.find((file) => file.path === newPath),
    state.files.find((file) => file.path === newPath),
  );
  assert.deepEqual(
    result.state.files.find((file) => file.path === pure.path),
    pure,
  );
  assert.deepEqual(await treeAt(repoPath, result.state.parent!.commitId), {
    ...originalParent,
    "regular.txt": Buffer.from("regular new\n"),
  });
  assert.deepEqual(
    await treeAt(repoPath, result.state.source.commitId),
    originalSource,
  );
  await assertWorkspace(repoPath, oldPath, originalSource);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.files, state.files);
  assert.equal(undone.state.source.commitId, state.source.commitId);
  assert.equal(undone.state.parent!.commitId, state.parent!.commitId);
});

test("real renamed CRLF and unterminated EOF selections retain byte-exact parent, source and workspace", async (t) => {
  for (const api of ["direct", "legacy"] as const)
    await t.test(api, async (t) => {
      const { repoPath, oldPath, newPath, base, source } = await fixture(
        t,
        true,
      );
      const service = new ReviewService({ repoPath });
      const state = await service.getState();
      const originalParent = await treeAt(repoPath, state.parent!.commitId);
      const originalSource = await treeAt(repoPath, state.source.commitId);
      const renamed = state.files.find((file) => file.path === newPath)!;
      assert.equal(renamed.oldPath, oldPath);
      assert.equal(renamed.hunks.length, 2);
      const eofHunk = renamed.hunks[1];
      assert.ok(eofHunk.rows.some((row) => row.noNewline));
      const selections = [{ id: eofHunk.id, lines: changes(eofHunk) }];
      const expected = base.replace("original line 23", "modified line 23");
      const result =
        api === "direct"
          ? await service.squashLines({ version: state.version, selections })
          : await service.squash(
              (
                await service.preview({
                  version: state.version,
                  target: state.parent!.changeId,
                  selections,
                })
              ).token,
            );
      assert.equal(result.warning, undefined);
      assert.deepEqual(
        await treeAt(repoPath, result.state.parent!.commitId),
        withRenamedFile(originalParent, oldPath, newPath, expected),
      );
      assert.deepEqual(
        await treeAt(repoPath, result.state.source.commitId),
        originalSource,
      );
      assert.deepEqual(
        await service.getFile({ version: result.state.version, path: newPath }),
        {
          oldFile: { name: newPath, contents: expected },
          newFile: { name: newPath, contents: source },
        },
      );
      const remaining = result.state.files.find(
        (file) => file.path === newPath,
      )!;
      assert.equal(remaining.oldPath, undefined);
      assert.ok(!remaining.patch.includes("rename from"));
      assert.equal(remaining.additions, 1);
      assert.equal(remaining.deletions, 1);
      await assertWorkspace(repoPath, oldPath, originalSource);
      const undone = await service.undo(result.state.version);
      assert.equal(undone.state.parent!.commitId, state.parent!.commitId);
      assert.equal(undone.state.source.commitId, state.source.commitId);
      assert.deepEqual(undone.state.files, state.files);
      await assertWorkspace(repoPath, oldPath, originalSource);
    });
});

test("rename preparation revalidates working-copy edits racing the pinned old-path read before any mutation", async (t) => {
  for (const api of ["direct", "legacy"] as const)
    await t.test(api, async (t) => {
      const { repoPath, oldPath, newPath } = await fixture(t);
      let race = false;
      const calls: string[][] = [];
      const service = new ReviewService({
        repoPath,
        toolRunner: (command, args, cwd) => {
          calls.push(args);
          return run(command, args, cwd);
        },
        jjRunner: async (cwd, args, limits) => {
          calls.push(args);
          const result = await jj(cwd, args, limits);
          if (
            race &&
            args[0] === "file" &&
            args[1] === "show" &&
            args.at(-1) === `root-file:${JSON.stringify(oldPath)}`
          ) {
            race = false;
            await writeFile(
              path.join(repoPath, newPath),
              "raced squash edit\n",
            );
          }
          return result;
        },
      });
      const state = await service.getState();
      const originalParent = await treeAt(repoPath, state.parent!.commitId);
      const hunk = state.files.find((file) => file.path === newPath)!.hunks[0];
      const selections = [{ id: hunk.id, lines: changes(hunk) }];
      calls.length = 0;
      race = true;
      await assert.rejects(
        api === "direct"
          ? service.squashLines({ version: state.version, selections })
          : service.preview({
              version: state.version,
              target: state.parent!.changeId,
              selections,
            }),
        code("STALE_STATE"),
      );
      assert.equal(race, false, "preparation read the original parent path");
      assert.ok(!calls.some((args) => args[0] === "squash"));
      assert.deepEqual(
        await treeAt(repoPath, state.parent!.commitId),
        originalParent,
      );
      assert.equal(
        await readFile(path.join(repoPath, newPath), "utf8"),
        "raced squash edit\n",
      );
      assert.equal((await service.getState()).canUndo, false);
    });
});

test("renames with file/directory-overlapping names fail preparation without a mutation or pending guard", async (t) => {
  const { repoPath, oldPath, newPath } = await fixture(t);
  const nestedPath = `${oldPath}/renamed.txt`;
  await mkdir(path.join(repoPath, oldPath));
  await rename(path.join(repoPath, newPath), path.join(repoPath, nestedPath));
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath,
    toolRunner: (command, args, cwd) => {
      calls.push(args);
      return run(command, args, cwd);
    },
    jjRunner: (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const state = await service.getState();
  const renamed = state.files.find((file) => file.path === nestedPath)!;
  assert.equal(
    renamed.oldPath,
    oldPath,
    "fixture exercises a real prefix-overlapping rename",
  );
  const hunk = renamed.hunks[0];
  const selections = [{ id: hunk.id, lines: changes(hunk) }];
  calls.length = 0;
  for (const attempt of [
    () => service.squashLines({ version: state.version, selections }),
    () =>
      service.preview({
        version: state.version,
        target: state.parent!.changeId,
        selections,
      }),
  ])
    await assert.rejects(attempt(), code("UNSAFE_PREVIEW"));
  assert.ok(!calls.some((args) => args[0] === "squash"));
  assert.deepEqual(await service.getState(), state);
  // Rejection must not install a pending recovery guard: ordinary squash works.
  const regular = state.files.find((file) => file.path === "regular.txt")!
    .hunks[0];
  const result = await service.squashLines({
    version: state.version,
    selections: [{ id: regular.id, lines: changes(regular) }],
  });
  assert.equal(result.state.canUndo, true);
  assert.deepEqual(
    (await service.undo(result.state.version)).state.files,
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
