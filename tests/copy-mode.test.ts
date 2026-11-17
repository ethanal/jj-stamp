import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseFile } from "../server/diff.ts";
import { jj } from "../server/process.ts";
import { materializeSelection } from "../server/selection.ts";
import {
  ReviewService,
  type ReviewHunk,
  type Selection,
  type State,
} from "../server/service.ts";
import { metadataSelectionId } from "../src/file-selection.ts";

type Mode = "100644" | "100755";
const copyFrom = "original/source[1]:notes.sh";
const copyTo = "copies/destination[1]:notes.sh";
const body = `--- a/${copyFrom}\n+++ b/${copyTo}\n@@ -2 +2 @@\n-old\n+new\n@@ -5 +5 @@\n-last\n+final\n`;
const copyPatch = (text = body, modes = "") =>
  `diff --git a/${copyFrom} b/${copyTo}\ncopy from ${copyFrom}\ncopy to ${copyTo}\n${modes}${text}`;
const modePatch = (oldMode: Mode, newMode: Mode, text = "") =>
  `diff --git a/script.sh b/script.sh\nold mode ${oldMode}\nnew mode ${newMode}\n${text}`;
const changes = (hunk: ReviewHunk) =>
  hunk.rows.filter((row) => /^[+-]/.test(row.raw)).map((row) => row.index);

test("copy and executable metadata parse without conflating copies, renames or unchanged modes", () => {
  const copied = parseFile(copyPatch(), copyTo);
  assert.equal(copied.copyFrom, copyFrom);
  assert.equal(copied.oldPath, undefined);
  assert.equal(copied.oldMode, undefined);
  assert.equal(copied.newMode, undefined);
  assert.equal(copied.hunks.length, 2);
  assert.deepEqual(copied.hunks[0].rows, [
    { raw: "-old", oldLine: 2, hunk: 0, index: 1 },
    { raw: "+new", newLine: 2, hunk: 0, index: 2 },
  ]);
  const pure = { path: copyTo, copyFrom, hunks: [] };
  assert.deepEqual(parseFile(copyPatch(""), copyTo), pure);
  assert.deepEqual(
    parseFile(copyPatch("similarity index 100%\n"), copyTo),
    pure,
  );
  for (const [oldMode, newMode] of [
    ["100644", "100755"],
    ["100755", "100644"],
  ] as const) {
    const modes = `old mode ${oldMode}\nnew mode ${newMode}\n`;
    assert.deepEqual(parseFile(modePatch(oldMode, newMode), "script.sh"), {
      path: "script.sh",
      oldMode,
      newMode,
      hunks: [],
    });
    assert.deepEqual(parseFile(copyPatch("", modes), copyTo), {
      ...pure,
      oldMode,
      newMode,
    });
    assert.deepEqual(parseFile(copyPatch(body, modes), copyTo), {
      ...copied,
      oldMode,
      newMode,
    });
    const renamed = parseFile(
      copyPatch("", modes).replaceAll("copy ", "rename "),
      copyTo,
    );
    assert.deepEqual(renamed, {
      path: copyTo,
      oldPath: copyFrom,
      oldMode,
      newMode,
      hunks: [],
    });
    assert.deepEqual(
      parseFile(copyPatch(body, `index abc..def ${oldMode}\n`), copyTo),
      copied,
      "an unchanged index mode is not a mode transition",
    );
  }
  assert.equal(
    metadataSelectionId(pure),
    `copy:${JSON.stringify([copyFrom, copyTo])}`,
  );
  assert.equal(
    metadataSelectionId({ ...pure, oldMode: "100644", newMode: "100755" }),
    `copy:${JSON.stringify([copyFrom, copyTo])}`,
  );
  assert.equal(
    metadataSelectionId({
      path: "script.sh",
      oldMode: "100755",
      newMode: "100644",
      hunks: [],
    }),
    'mode:["script.sh","100755","100644"]',
  );
  assert.equal(
    metadataSelectionId(copied),
    undefined,
    "text changes use real row selections",
  );
});

test("copy and mode envelopes reject duplicate, conflicting and unsafe metadata claims", () => {
  const pure = copyPatch("");
  const mode = modePatch("100644", "100755");
  const invalidCopies = [
    pure.replace(`copy from ${copyFrom}\n`, ""),
    pure.replace(`copy to ${copyTo}\n`, ""),
    pure.replace(`copy from ${copyFrom}`, "copy from wrong.sh"),
    pure.replace(`copy to ${copyTo}`, "copy to wrong.sh"),
    pure.replace(`a/${copyFrom}`, "a/wrong.sh"),
    pure.replace(`b/${copyTo}`, "b/wrong.sh"),
    pure + `copy from ${copyFrom}\n`,
    pure + `copy to ${copyTo}\n`,
    pure + `rename from ${copyFrom}\nrename to ${copyTo}\n`,
    pure.replace(`copy to ${copyTo}`, `rename to ${copyTo}`),
    pure.replaceAll(copyTo, copyFrom),
    copyPatch(body.replace(`--- a/${copyFrom}`, "--- a/wrong.sh")),
    copyPatch(body.replace(`+++ b/${copyTo}`, "+++ b/wrong.sh")),
    copyPatch(body.replace(`--- a/${copyFrom}`, "--- /dev/null")),
    copyPatch(body.replace(`+++ b/${copyTo}`, "+++ /dev/null")),
    copyPatch(body, "new file mode 100644\n"),
    copyPatch(body, "deleted file mode 100755\n"),
    pure + "similarity index 90%\n",
    pure + "similarity index 101%\n",
    pure + "similarity index 100%\nsimilarity index 100%\n",
    pure + "index abc..def 100644\n",
    pure + "unknown metadata\n",
    pure + `--- a/${copyFrom}\n+++ b/${copyTo}\n`,
    pure + "@@ -1 +1 @@\n-old\n+new\n",
    pure + "\\ No newline at end of file\n",
  ];
  for (const patch of invalidCopies)
    assert.throws(() => parseFile(patch, copyTo), patch);
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
    assert.throws(() => parseFile(pure.replaceAll(copyFrom, unsafe), copyTo));
    assert.throws(() => parseFile(pure.replaceAll(copyTo, unsafe), unsafe));
  }
  assert.throws(() => parseFile(pure, copyFrom));
  const invalidModes = [
    mode.replace("old mode 100644\n", ""),
    mode.replace("new mode 100755\n", ""),
    mode.replace("new mode 100755", "new mode 100644"),
    mode + "old mode 100644\n",
    mode + "new mode 100755\n",
    mode + "index abc..abc 100644\n",
    mode + "new file mode 100755\n",
    mode + "deleted file mode 100644\n",
    mode.replace("b/script.sh", "b/wrong.sh"),
    mode.replace("diff --git a/script.sh b/script.sh\n", ""),
    mode + "index abc..def\n",
    mode + "--- a/script.sh\n+++ b/script.sh\n",
  ];
  for (const unsupported of ["120000", "160000", "100600", "040000"]) {
    invalidModes.push(
      mode.replace("old mode 100644", `old mode ${unsupported}`),
    );
    invalidModes.push(
      mode.replace("new mode 100755", `new mode ${unsupported}`),
    );
    invalidCopies.push(copyPatch(body, `index abc..def ${unsupported}\n`));
  }
  for (const patch of invalidModes)
    assert.throws(() => parseFile(patch, "script.sh"), patch);
  for (const patch of invalidCopies)
    assert.throws(() => parseFile(patch, copyTo), patch);
});

test("metadata-only copy and mode materialization requires identical pinned lossless bytes and no fake rows", () => {
  for (const [name, patch] of [
    [copyTo, copyPatch("")],
    [copyTo, copyPatch("", "old mode 100644\nnew mode 100755\n")],
    ["script.sh", modePatch("100644", "100755")],
    ["script.sh", modePatch("100755", "100644")],
  ]) {
    const input = { path: name, patch, selections: [] };
    for (const contents of [
      "",
      "same\n",
      "same\r\nnext\r\n",
      "雪\r\nlast",
      "last\r",
    ]) {
      const base = Buffer.from(contents);
      const source = Buffer.from(contents);
      const original = structuredClone(input);
      const result = materializeSelection(input, base, source);
      assert.deepEqual(result.result, source);
      assert.notEqual(
        result.result,
        source,
        "output does not alias pinned bytes",
      );
      assert.equal(result.preview, patch);
      assert.deepEqual(parseFile(result.preview, name).hunks, []);
      assert.deepEqual(input, original);
      assert.deepEqual(base, Buffer.from(contents));
      assert.deepEqual(source, Buffer.from(contents));
    }
    for (const [base, source] of [
      [null, Buffer.from("same\n")],
      [Buffer.from("same\n"), null],
      [null, null],
      [Buffer.alloc(0), null],
      [null, Buffer.alloc(0)],
      [Buffer.from("same\n"), Buffer.from("different\n")],
      [Buffer.from("same\n"), Buffer.from("same\r\n")],
      [Buffer.from([0xff, 10]), Buffer.from([0xff, 10])],
      [Buffer.from("binary\0"), Buffer.from("binary\0")],
    ] as Array<[Buffer | null, Buffer | null]>)
      assert.throws(() => materializeSelection(input, base, source));
    for (const lines of [[], [1]])
      assert.throws(() =>
        materializeSelection(
          { ...input, selections: [{ hunk: 0, lines }] },
          Buffer.from("same\n"),
          Buffer.from("same\n"),
        ),
      );
  }
});

test("copied row selections carry the baseline and mode but only selected edits, with exact CRLF/EOF safety", () => {
  const base = "same\nold\ngap\ngap\nlast\ntail\n";
  const source = "same\nnew\ngap\ngap\nfinal\ntail\n";
  const patch = copyPatch(body, "old mode 100644\nnew mode 100755\n");
  for (const [selections, expected] of [
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
  ] as Array<[Array<{ hunk: number; lines: number[] }>, string]>) {
    const input = { path: copyTo, patch, selections };
    const original = structuredClone(input);
    const result = materializeSelection(
      input,
      Buffer.from(base),
      Buffer.from(source),
    );
    assert.deepEqual(result.result, Buffer.from(expected));
    assert.deepEqual(input, original);
    const preview = parseFile(result.preview, copyTo);
    assert.equal(preview.copyFrom, copyFrom);
    assert.equal(preview.oldPath, undefined);
    assert.equal(preview.oldMode, "100644");
    assert.equal(preview.newMode, "100755");
    assert.deepEqual(
      materializeSelection(
        {
          path: copyTo,
          patch: result.preview,
          selections: preview.hunks.map((hunk, index) => ({
            hunk: index,
            lines: hunk.rows
              .filter((row) => /^[+-]/.test(row.raw))
              .map((row) => row.index),
          })),
        },
        Buffer.from(base),
        result.result,
      ).result,
      result.result,
    );
  }
  for (const badSource of [
    source.replace("tail", "raced"),
    source.replace("final", "wrong"),
  ])
    assert.throws(
      () =>
        materializeSelection(
          { path: copyTo, patch, selections: [{ hunk: 0, lines: [1, 2] }] },
          Buffer.from(base),
          Buffer.from(badSource),
        ),
      /reconstruct/i,
    );
  for (const [oldBytes, newBytes] of [
    [null, Buffer.from(source)],
    [Buffer.from(base), null],
  ] as Array<[Buffer | null, Buffer | null]>)
    assert.throws(() =>
      materializeSelection(
        { path: copyTo, patch, selections: [{ hunk: 0, lines: [1] }] },
        oldBytes,
        newBytes,
      ),
    );
  const eofPatch = copyPatch(
    `--- a/${copyFrom}\n+++ b/${copyTo}\n@@ -1,3 +1,3 @@\n-old\r\n+new\r\n keep\r\n-before\n\\ No newline at end of file\n+after\n\\ No newline at end of file\n`,
  );
  const oldEOF = Buffer.from("old\r\nkeep\r\nbefore");
  const newEOF = Buffer.from("new\r\nkeep\r\nafter");
  assert.deepEqual(
    materializeSelection(
      {
        path: copyTo,
        patch: eofPatch,
        selections: [{ hunk: 0, lines: [1, 2] }],
      },
      oldEOF,
      newEOF,
    ).result,
    Buffer.from("new\r\nkeep\r\nbefore"),
  );
  assert.deepEqual(
    materializeSelection(
      {
        path: copyTo,
        patch: eofPatch,
        selections: [{ hunk: 0, lines: [4, 5] }],
      },
      oldEOF,
      newEOF,
    ).result,
    Buffer.from("old\r\nkeep\r\nafter"),
  );
  assert.throws(
    () =>
      materializeSelection(
        {
          path: copyTo,
          patch: eofPatch,
          selections: [{ hunk: 0, lines: [5] }],
        },
        oldEOF,
        newEOF,
      ),
    /unterminated/i,
  );
});

interface Entry {
  bytes: Buffer;
  executable: boolean;
}
type Tree = Record<string, Entry>;
async function treeAt(repoPath: string, revision: string): Promise<Tree> {
  const listed = await jj(repoPath, [
    "file",
    "list",
    "-r",
    revision,
    "--ignore-working-copy",
    "-T",
    'path ++ "\\t" ++ executable ++ "\\n"',
  ]);
  const tree: Tree = {};
  for (const line of listed.stdout.trimEnd().split("\n").filter(Boolean)) {
    const [name, executable] = line.split("\t");
    const result = await jj(repoPath, [
      "file",
      "show",
      "-r",
      revision,
      "--ignore-working-copy",
      "--",
      `root-file:${JSON.stringify(name)}`,
    ]);
    tree[name] = {
      bytes: result.stdoutBytes ?? Buffer.from(result.stdout),
      executable: executable === "true",
    };
  }
  return tree;
}
async function workspaceAt(repoPath: string): Promise<Tree> {
  const tree: Tree = {};
  const visit = async (directory = "") => {
    for (const entry of await readdir(path.join(repoPath, directory), {
      withFileTypes: true,
    })) {
      if (entry.name === ".jj" || entry.name === ".git") continue;
      const name = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await visit(name);
      else
        tree[name] = {
          bytes: await readFile(path.join(repoPath, name)),
          executable: Boolean(
            (await stat(path.join(repoPath, name))).mode & 0o111,
          ),
        };
    }
  };
  await visit();
  return tree;
}
async function initRepo(t: test.TestContext) {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-copy-mode-"));
  t.after(() => rm(repoPath, { recursive: true, force: true }));
  await jj(repoPath, ["git", "init", "--no-colocate", "."]);
  await jj(repoPath, [
    "config",
    "set",
    "--repo",
    "user.name",
    "Copy Mode Test",
  ]);
  await jj(repoPath, [
    "config",
    "set",
    "--repo",
    "user.email",
    "copy-mode@example.com",
  ]);
  await jj(repoPath, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  return repoPath;
}
async function put(
  repoPath: string,
  name: string,
  contents: string,
  executable = false,
) {
  await mkdir(path.dirname(path.join(repoPath, name)), { recursive: true });
  await writeFile(path.join(repoPath, name), contents);
  await chmod(path.join(repoPath, name), executable ? 0o755 : 0o644);
}
async function copyFixture(
  t: test.TestContext,
  pure = false,
  nonWorkingCopy = false,
  executable = true,
) {
  const repoPath = await initRepo(t);
  const base = Array.from(
    { length: 36 },
    (_, i) => `copy baseline line ${i}\r\n`,
  )
    .join("")
    .slice(0, -2);
  const source = pure
    ? base
    : base
        .replace("baseline line 10", "edited line 10")
        .replace("baseline line 25", "edited line 25");
  await put(repoPath, copyFrom, base);
  await put(repoPath, "untouched.txt", "unrelated\n");
  await jj(repoPath, ["commit", "-m", "Before copy"]);
  // jj detects copies from modified/deleted candidates, not arbitrary unchanged
  // source files. Keep this independent edit unselected throughout the tests.
  await put(
    repoPath,
    copyFrom,
    base.replace("baseline line 32", "concurrent source line 32"),
  );
  await put(repoPath, copyTo, source, executable);
  await jj(repoPath, ["describe", "-m", "Copy with concurrent source edit"]);
  if (nonWorkingCopy) {
    await jj(repoPath, ["new", "-m", "Workspace descendant"]);
    await put(repoPath, "workspace-only.txt", "descendant stays here\n");
    await jj(repoPath, ["describe", "-m", "Workspace descendant"]);
  }
  const service = new ReviewService({
    repoPath,
    ...(nonWorkingCopy ? { revision: "@-" } : {}),
  });
  return { repoPath, service, base, source };
}
async function squash(
  service: ReviewService,
  state: State,
  selections: Selection[],
  api: "direct" | "legacy",
  verifyPreview?: (patch: string) => void,
) {
  if (api === "direct")
    return service.squashLines({ version: state.version, selections });
  const preview = await service.preview({
    version: state.version,
    target: state.parent!.changeId,
    selections,
  });
  verifyPreview?.(preview.patch);
  assert.equal(
    (await service.getState()).operation,
    state.operation,
    "preview never mutates history",
  );
  return service.squash(preview.token);
}
async function assertUndone(
  service: ReviewService,
  initial: State,
  result: Awaited<ReturnType<typeof squash>>,
  repoPath: string,
  parent: Tree,
  source: Tree,
  workspace: Tree,
) {
  const undone = await service.undo(result.state.version);
  assert.equal(undone.state.canUndo, false);
  assert.equal(undone.state.source.commitId, initial.source.commitId);
  assert.equal(undone.state.parent!.commitId, initial.parent!.commitId);
  assert.deepEqual(undone.state.files, initial.files);
  assert.deepEqual(
    await treeAt(repoPath, undone.state.parent!.commitId),
    parent,
  );
  assert.deepEqual(
    await treeAt(repoPath, undone.state.source.commitId),
    source,
  );
  assert.deepEqual(await workspaceAt(repoPath), workspace);
}

test("native jj copy review exposes original baseline, executable transition and pinned literal side reads", async (t) => {
  const { repoPath, service, base, source } = await copyFixture(t);
  const state = await service.getState();
  const file = state.files.find((file) => file.path === copyTo)!;
  assert.ok(file, "fixture must exercise jj's actual native copy detection");
  assert.equal(file.copyFrom, copyFrom);
  assert.equal(file.oldPath, undefined);
  assert.equal(file.oldMode, "100644");
  assert.equal(file.newMode, "100755");
  assert.equal(file.unsupported, undefined);
  assert.equal(file.squashUnsupported, undefined);
  assert.equal(file.hunks.length, 2);
  assert.equal(file.additions, 2);
  assert.equal(file.deletions, 2);
  assert.deepEqual(service.getWatchPaths(), [copyFrom, copyTo].sort());
  const expected = {
    oldFile: { name: copyFrom, contents: base },
    newFile: { name: copyTo, contents: source },
  };
  assert.deepEqual(
    await service.getFile({ version: state.version, path: copyTo }),
    expected,
  );
  assert.deepEqual(
    (await service.getCommit({ commitId: state.source.commitId })).files,
    state.files,
  );
  assert.deepEqual(
    await service.getCommitFile({
      commitId: state.source.commitId,
      path: copyTo,
    }),
    expected,
  );
  await put(repoPath, copyTo, "unsnapshotted replacement\n", true);
  assert.deepEqual(
    await service.getCommitFile({
      commitId: state.source.commitId,
      path: copyTo,
    }),
    expected,
    "immutable copy sides ignore subsequent workspace bytes",
  );
});

for (const api of ["direct", "legacy"] as const) {
  for (const scope of ["partial", "all"] as const) {
    test(`${api} native copy ${scope} squash retains original path/edit, carries executable mode and undoes exactly`, async (t) => {
      const { repoPath, service, base, source } = await copyFixture(t);
      const initial = await service.getState();
      const parent = await treeAt(repoPath, initial.parent!.commitId);
      const originalSource = await treeAt(repoPath, initial.source.commitId);
      const workspace = await workspaceAt(repoPath);
      const file = initial.files.find((file) => file.path === copyTo)!;
      assert.equal(file.copyFrom, copyFrom);
      assert.equal(file.unsupported, undefined);
      assert.equal(file.squashUnsupported, undefined);
      const selections =
        scope === "all"
          ? file.hunks.map((hunk) => ({ id: hunk.id, lines: changes(hunk) }))
          : [
              {
                id: file.hunks[0].id,
                lines: file.hunks[0].rows
                  .filter((row) => row.raw.startsWith("-"))
                  .map((row) => row.index),
              },
            ];
      const expectedBytes =
        scope === "all"
          ? source
          : base.replace("copy baseline line 10\r\n", "");
      const result = await squash(
        service,
        initial,
        selections,
        api,
        (patch) => {
          const parsed = parseFile(patch, copyTo);
          assert.equal(parsed.copyFrom, copyFrom);
          assert.equal(parsed.oldMode, "100644");
          assert.equal(parsed.newMode, "100755");
          if (scope === "partial") {
            assert.ok(!patch.includes("+copy edited line 10"));
            assert.ok(!patch.includes("edited line 25"));
          }
        },
      );
      assert.equal(result.warning, undefined);
      assert.equal(result.state.canUndo, true);
      assert.equal(result.state.source.changeId, initial.source.changeId);
      assert.deepEqual(
        await treeAt(repoPath, result.state.parent!.commitId),
        {
          ...parent,
          [copyTo]: { bytes: Buffer.from(expectedBytes), executable: true },
        },
        "copy must not delete, rewrite or chmod its original path in the parent",
      );
      assert.deepEqual(
        await treeAt(repoPath, result.state.source.commitId),
        originalSource,
        "source tree including concurrent original-path edit remains exact",
      );
      assert.deepEqual(await workspaceAt(repoPath), workspace);
      const remaining = result.state.files.find((file) => file.path === copyTo);
      if (scope === "all") assert.equal(remaining, undefined);
      else {
        assert.ok(remaining);
        assert.equal(remaining.copyFrom, undefined);
        assert.equal(remaining.oldPath, undefined);
        assert.equal(remaining.oldMode, undefined);
        assert.equal(remaining.newMode, undefined);
        assert.deepEqual(
          await service.getFile({
            version: result.state.version,
            path: copyTo,
          }),
          {
            oldFile: { name: copyTo, contents: expectedBytes },
            newFile: { name: copyTo, contents: source },
          },
        );
      }
      assert.ok(
        result.state.files.some((file) => file.path === copyFrom),
        "unselected original-path edit remains in the source diff",
      );
      await assertUndone(
        service,
        initial,
        result,
        repoPath,
        parent,
        originalSource,
        workspace,
      );
    });
  }
  for (const nonWorkingCopy of [false, true]) {
    test(`${api} pure native copy ${nonWorkingCopy ? "plus mode outside @" : "at @"} preserves bytes, descendant workspace and exact undo`, async (t) => {
      const { repoPath, service, base } = await copyFixture(
        t,
        true,
        nonWorkingCopy,
        nonWorkingCopy,
      );
      const initial = await service.getState();
      const parent = await treeAt(repoPath, initial.parent!.commitId);
      const source = await treeAt(repoPath, initial.source.commitId);
      const workspace = await workspaceAt(repoPath);
      const file = initial.files.find((file) => file.path === copyTo)!;
      assert.equal(file.copyFrom, copyFrom);
      assert.equal(file.oldMode, nonWorkingCopy ? "100644" : undefined);
      assert.equal(file.newMode, nonWorkingCopy ? "100755" : undefined);
      assert.equal(file.unsupported, undefined);
      assert.equal(file.squashUnsupported, undefined);
      assert.deepEqual(file.hunks, []);
      assert.equal(file.additions, 0);
      assert.equal(file.deletions, 0);
      const id = metadataSelectionId(file)!;
      assert.equal(id, `copy:${JSON.stringify([copyFrom, copyTo])}`);
      const expectedSides = {
        oldFile: { name: copyFrom, contents: base },
        newFile: { name: copyTo, contents: base },
      };
      assert.deepEqual(
        await service.getFile({ version: initial.version, path: copyTo }),
        expectedSides,
      );
      assert.deepEqual(
        await service.getCommitFile({
          commitId: initial.source.commitId,
          path: copyTo,
        }),
        expectedSides,
      );
      const result = await squash(
        service,
        initial,
        [{ id, lines: [] }],
        api,
        (patch) => {
          assert.deepEqual(parseFile(patch, copyTo), {
            path: copyTo,
            copyFrom,
            ...(nonWorkingCopy ? { oldMode: "100644", newMode: "100755" } : {}),
            hunks: [],
          });
          assert.ok(!patch.includes("@@"));
        },
      );
      assert.equal(result.warning, undefined);
      assert.deepEqual(await treeAt(repoPath, result.state.parent!.commitId), {
        ...parent,
        [copyTo]: { bytes: Buffer.from(base), executable: nonWorkingCopy },
      });
      assert.deepEqual(
        await treeAt(repoPath, result.state.source.commitId),
        source,
      );
      assert.deepEqual(await workspaceAt(repoPath), workspace);
      assert.equal(
        result.state.files.find((file) => file.path === copyTo),
        undefined,
      );
      assert.ok(result.state.files.some((file) => file.path === copyFrom));
      await assertUndone(
        service,
        initial,
        result,
        repoPath,
        parent,
        source,
        workspace,
      );
    });
  }
}

for (const api of ["direct", "legacy"] as const) {
  for (const executable of [false, true]) {
    for (const scope of ["mode-only", "partial", "all"] as const) {
      test(`${api} ${executable ? "100644→100755" : "100755→100644"} ${scope} selection moves mode once and undoes exact trees`, async (t) => {
        const repoPath = await initRepo(t);
        const base = Array.from(
          { length: 30 },
          (_, i) => `script line ${i}\r\n`,
        )
          .join("")
          .slice(0, -2);
        const source =
          scope === "mode-only"
            ? base
            : base
                .replace("script line 10", "updated line 10")
                .replace("script line 24", "updated line 24");
        await put(repoPath, "script.sh", base, !executable);
        await put(repoPath, "untouched.txt", "unrelated\n");
        await jj(repoPath, ["commit", "-m", "Before mode change"]);
        await put(repoPath, "script.sh", source, executable);
        const service = new ReviewService({ repoPath });
        const initial = await service.getState();
        const parent = await treeAt(repoPath, initial.parent!.commitId);
        const originalSource = await treeAt(repoPath, initial.source.commitId);
        const workspace = await workspaceAt(repoPath);
        const file = initial.files.find((file) => file.path === "script.sh")!;
        const oldMode = executable ? "100644" : "100755";
        const newMode = executable ? "100755" : "100644";
        assert.equal(file.oldMode, oldMode);
        assert.equal(file.newMode, newMode);
        assert.equal(file.copyFrom, undefined);
        assert.equal(file.oldPath, undefined);
        assert.equal(file.unsupported, undefined);
        assert.equal(file.squashUnsupported, undefined);
        const expectedSides = {
          oldFile: { name: "script.sh", contents: base },
          newFile: { name: "script.sh", contents: source },
        };
        assert.deepEqual(
          await service.getFile({
            version: initial.version,
            path: "script.sh",
          }),
          expectedSides,
        );
        assert.deepEqual(
          await service.getCommitFile({
            commitId: initial.source.commitId,
            path: "script.sh",
          }),
          expectedSides,
        );
        assert.deepEqual(
          (await service.getCommit({ commitId: initial.source.commitId }))
            .files,
          initial.files,
        );
        const selections =
          scope === "mode-only"
            ? [{ id: metadataSelectionId(file)!, lines: [] }]
            : (scope === "all" ? file.hunks : file.hunks.slice(0, 1)).map(
                (hunk) => ({ id: hunk.id, lines: changes(hunk) }),
              );
        if (scope === "mode-only") {
          assert.deepEqual(file.hunks, []);
          assert.equal(
            selections[0].id,
            `mode:${JSON.stringify(["script.sh", oldMode, newMode])}`,
          );
        }
        const expectedBytes =
          scope === "partial"
            ? base.replace("script line 10", "updated line 10")
            : source;
        const result = await squash(
          service,
          initial,
          selections,
          api,
          (patch) => {
            const parsed = parseFile(patch, "script.sh");
            assert.equal(parsed.oldMode, oldMode);
            assert.equal(parsed.newMode, newMode);
            assert.equal(
              parsed.hunks.length,
              scope === "mode-only" ? 0 : scope === "partial" ? 1 : 2,
            );
          },
        );
        assert.equal(result.warning, undefined);
        assert.deepEqual(
          await treeAt(repoPath, result.state.parent!.commitId),
          {
            ...parent,
            "script.sh": { bytes: Buffer.from(expectedBytes), executable },
          },
        );
        assert.deepEqual(
          await treeAt(repoPath, result.state.source.commitId),
          originalSource,
        );
        assert.deepEqual(await workspaceAt(repoPath), workspace);
        const remaining = result.state.files.find(
          (file) => file.path === "script.sh",
        );
        if (scope !== "partial") assert.equal(remaining, undefined);
        else {
          assert.ok(remaining);
          assert.equal(remaining.hunks.length, 1);
          assert.equal(remaining.oldMode, undefined);
          assert.equal(remaining.newMode, undefined);
          assert.ok(!remaining.patch.includes("old mode"));
        }
        await assertUndone(
          service,
          initial,
          result,
          repoPath,
          parent,
          originalSource,
          workspace,
        );
      });
    }
  }
}

for (const api of ["direct", "legacy"] as const) {
  test(`${api} mixed original-path and native copy selections share one scratch entry and undo exactly`, async (t) => {
    const { repoPath, service, base } = await copyFixture(t);
    const initial = await service.getState();
    const parent = await treeAt(repoPath, initial.parent!.commitId);
    const source = await treeAt(repoPath, initial.source.commitId);
    const workspace = await workspaceAt(repoPath);
    const original = initial.files.find((file) => file.path === copyFrom)!;
    const copied = initial.files.find((file) => file.path === copyTo)!;
    assert.equal(copied.copyFrom, copyFrom);
    assert.equal(original.unsupported, undefined);
    assert.equal(original.squashUnsupported, undefined);
    assert.equal(copied.unsupported, undefined);
    assert.equal(copied.squashUnsupported, undefined);
    assert.equal(original.hunks.length, 1);
    assert.equal(copied.hunks.length, 2);
    const selections = [
      ...original.hunks.map((hunk) => ({ id: hunk.id, lines: changes(hunk) })),
      { id: copied.hunks[0].id, lines: changes(copied.hunks[0]) },
    ];
    const expectedCopy = base.replace("baseline line 10", "edited line 10");
    const result = await squash(service, initial, selections, api, (patch) => {
      assert.ok(patch.includes(`copy from ${copyFrom}\n`));
      assert.ok(patch.includes(`copy to ${copyTo}\n`));
      assert.ok(patch.includes("+copy edited line 10\r\n"));
      assert.ok(patch.includes("+copy concurrent source line 32\r\n"));
      assert.ok(!patch.includes("edited line 25"));
    });
    assert.equal(result.warning, undefined);
    assert.deepEqual(
      await treeAt(repoPath, result.state.parent!.commitId),
      {
        ...parent,
        [copyFrom]: source[copyFrom],
        [copyTo]: { bytes: Buffer.from(expectedCopy), executable: true },
      },
      "the original gets its independent edit while the copy uses the pinned old source baseline",
    );
    assert.deepEqual(
      await treeAt(repoPath, result.state.source.commitId),
      source,
    );
    assert.deepEqual(await workspaceAt(repoPath), workspace);
    assert.equal(
      result.state.files.find((file) => file.path === copyFrom),
      undefined,
    );
    const remaining = result.state.files.find((file) => file.path === copyTo)!;
    assert.ok(remaining);
    assert.equal(remaining.hunks.length, 1);
    assert.equal(remaining.copyFrom, undefined);
    assert.equal(remaining.oldMode, undefined);
    assert.equal(remaining.newMode, undefined);
    await assertUndone(
      service,
      initial,
      result,
      repoPath,
      parent,
      source,
      workspace,
    );
  });
}
