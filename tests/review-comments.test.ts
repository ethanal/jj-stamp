import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewService, ApiError, type State } from "../server/service.ts";
import { jj, run, ProcessError } from "../server/process.ts";
import { startLocalServer } from "../server/http.ts";
import {
  validateCommentsLayer,
  type CommentsLayerConfig,
} from "../server/comments-layer.ts";
import {
  parseReviewComments,
  type ReviewCommentMutation,
} from "../src/review-comments.ts";
import { withDiffEditor } from "../server/diff-editor.ts";

const filename = "src/main.ts";
const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const working = original.replace("b = 2", "b = 20");
async function fixture(
  t: TestContext,
  crlf = false,
  code = { old: original, new: working },
  pathname = filename,
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-branches-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await jj(root, ["git", "init", "--no-colocate", "."]);
  await jj(root, ["config", "set", "--repo", "user.name", "Review Tester"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "review@example.test",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await mkdir(path.join(root, "src"));
  const file = path.join(root, pathname);
  await mkdir(path.dirname(file), { recursive: true });
  const encode = (text: string) =>
    crlf ? text.replaceAll("\n", "\r\n") : text;
  await writeFile(file, encode(code.old));
  await jj(root, ["commit", "-m", "Reviewed"]);
  await writeFile(file, encode(code.new));
  await jj(root, ["describe", "-m", "Remaining"]);
  const id = async (rev: string) =>
    (
      await jj(root, ["log", "--no-graph", "-r", rev, "-T", "change_id"])
    ).stdout.trim();
  const sourceChangeId = await id("@");
  const reviewedChangeId = await id("@-");
  const branches = [];
  for (const [name, codeChangeId] of [
    ["Reviewed", reviewedChangeId],
    ["Remaining", sourceChangeId],
  ]) {
    await jj(root, [
      "new",
      "--no-edit",
      "-r",
      `change_id("${codeChangeId}")`,
      "-m",
      `COMMENTS ${name}`,
    ]);
    branches.push({
      codeChangeId,
      commentsChangeId: await id(`description(substring:"COMMENTS ${name}")`),
    });
  }
  const comments: CommentsLayerConfig = {
    sourceChangeId,
    reviewedChangeId,
    branches,
  };
  const service = new ReviewService({ repoPath: root, comments });
  const state = await service.getState();
  assert.equal(state.canEditComments, true, state.commentUnavailable);
  return { root, file, comments, service, state, source: encode(code.new) };
}
const add = (state: State, extra = {}): ReviewCommentMutation => ({
  version: state.version,
  path: filename,
  action: "add",
  line: 2,
  body: "Please simplify",
  ...extra,
});
const overlay = (service: ReviewService, state: State, pathname = filename) =>
  service.getComments({ version: state.version, path: pathname });
const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
const selections = (state: State, pathname = filename) => {
  const hunk = state.files.find((file) => file.path === pathname)!.hunks[0];
  return [
    {
      id: hunk.id,
      lines: hunk.rows
        .filter((row) => /^[+-]/.test(row.raw))
        .map((row) => row.index),
    },
  ];
};
async function branchFile(
  root: string,
  config: CommentsLayerConfig,
  code = config.sourceChangeId,
  pathname = filename,
) {
  const branch = config.branches.find(
    (branch) => branch.codeChangeId === code,
  )!;
  return revisionFile(
    root,
    `change_id("${branch.commentsChangeId}")`,
    pathname,
  );
}
async function revisionFile(
  root: string,
  revision: string,
  pathname = filename,
) {
  return (
    await jj(root, [
      "file",
      "show",
      "--ignore-working-copy",
      "-r",
      revision,
      "--",
      `root-file:${JSON.stringify(pathname)}`,
    ])
  ).stdout;
}

test("real-jj branch CRUD/restart preserves both clean code revisions and main @ with LF/CRLF", async (t) => {
  for (const crlf of [false, true]) {
    const { root, file, comments, service, state, source } = await fixture(
      t,
      crlf,
    );
    const initial = await validateCommentsLayer(root, comments);
    const preview = await service.preview({
      version: state.version,
      target: state.parent!.changeId,
      selections: selections(state),
    });
    const added = (
      await service.comment(add(state, { endLine: 3, body: "First\nSecond" }))
    ).state;
    assert.equal(added.source.commitId, state.source.commitId);
    assert.notEqual(added.version, state.version);
    assert.equal(await readFile(file, "utf8"), source);
    const text = await branchFile(root, comments);
    const parsed = parseReviewComments(filename, text).comments[0];
    assert.equal(parsed.body, "First\nSecond");
    if (crlf) assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
    const projected = await overlay(service, added);
    assert.deepEqual(
      projected.comments.map(({ id, body, startLine, endLine }) => ({
        id,
        body,
        startLine,
        endLine,
      })),
      [{ id: parsed.id, body: "First\nSecond", startLine: 2, endLine: 3 }],
    );
    const clean = await service.getFile({
      version: added.version,
      path: filename,
    });
    assert.equal(clean.newFile!.contents, source);
    assert.doesNotMatch(clean.newFile!.contents, /JJ-STAMP/);
    await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
    await rejectsCode(service.comment(add(state)), "STALE_STATE");
    const restarted = new ReviewService({ repoPath: root, comments });
    const fresh = await restarted.getState();
    assert.deepEqual(fresh, added);
    const edited = (
      await restarted.comment({
        version: fresh.version,
        path: filename,
        action: "edit",
        id: parsed.id,
        body: "Changed",
      })
    ).state;
    assert.equal((await overlay(restarted, edited)).comments[0].id, parsed.id);
    assert.equal(
      (await overlay(restarted, edited)).comments[0].body,
      "Changed",
    );
    const removed = (
      await restarted.comment({
        version: edited.version,
        path: filename,
        action: "remove",
        id: parsed.id,
      })
    ).state;
    assert.equal((await overlay(restarted, removed)).comments.length, 0);
    assert.equal(await branchFile(root, comments), source);
    const final = await validateCommentsLayer(root, comments);
    assert.equal(final.source.commitId, initial.source.commitId);
    assert.equal(final.reviewed.commitId, initial.reviewed.commitId);
    assert.equal(await readFile(file, "utf8"), source);
  }
});

test("ordinary review comments are read-only; managed Reviewed has its own editable side branch", async (t) => {
  const { root, comments, service, state } = await fixture(t);
  const ordinary = new ReviewService({ repoPath: root });
  const plain = await ordinary.getState();
  assert.equal(plain.canEditComments, false);
  assert.equal(plain.commentsEnabled, undefined);
  await rejectsCode(ordinary.comment(add(plain)), "COMMENTS_UNAVAILABLE");
  const first = (await service.comment(add(state))).state;
  const reviewed = (
    await service.selectRevision({
      version: first.version,
      changeId: comments.reviewedChangeId,
    })
  ).state;
  assert.equal(reviewed.canEditComments, true);
  const before = await overlay(service, reviewed);
  assert.equal(before.unmapped.length, 1);
  assert.equal(before.unmapped[0].body, "Please simplify");
  const own = (
    await service.comment(add(reviewed, { line: 1, body: "Reviewed note" }))
  ).state;
  assert.equal((await overlay(service, own)).comments[0].body, "Reviewed note");
  assert.match(
    await branchFile(root, comments, comments.reviewedChangeId),
    /Reviewed note/,
  );
  assert.doesNotMatch(
    await branchFile(root, comments, comments.sourceChangeId),
    /Reviewed note/,
  );
});

test("duplicate cross-branch anchors stay unmapped unless complete code trees are identical", async (t) => {
  const { service, state, comments } = await fixture(t, false, {
    old: "same();\noldCode();\nsame();\n",
    new: "same();\nnewCode();\nsame();\n",
  });
  const added = (
    await service.comment(add(state, { line: 1, body: "Duplicate anchor" }))
  ).state;
  const id = (await overlay(service, added)).comments[0].id;
  const reviewed = (
    await service.selectRevision({
      version: added.version,
      changeId: comments.reviewedChangeId,
    })
  ).state;
  const projected = await overlay(service, reviewed);
  assert.equal(projected.comments.length, 0);
  assert.equal(projected.unmapped[0].id, id);
  assert.equal(projected.unmapped[0].body, "Duplicate anchor");
  const remaining = (
    await service.selectRevision({
      version: reviewed.version,
      changeId: comments.sourceChangeId,
    })
  ).state;
  assert.equal((await overlay(service, remaining)).comments[0].id, id);
  const moved = await service.squashLines({
    version: remaining.version,
    selections: selections(remaining),
  });
  const selected = (
    await service.selectRevision({
      version: moved.state.version,
      changeId: comments.reviewedChangeId,
    })
  ).state;
  assert.equal((await overlay(service, selected)).comments[0].id, id);
});

test("comment commit IDs cannot be shadowed by same-named bookmarks", async (t) => {
  const { root, comments } = await fixture(t);
  const initial = await validateCommentsLayer(root, comments);
  const branch = initial.branches.find(
    (branch) => branch.code.changeId === comments.sourceChangeId,
  )!;
  await jj(root, [
    "bookmark",
    "create",
    branch.comments.commitId,
    "-r",
    `commit_id("${initial.reviewed.commitId}")`,
  ]);
  const service = new ReviewService({ repoPath: root, comments });
  const state = await service.getState();
  const added = (await service.comment(add(state, { body: "Correct branch" })))
    .state;
  assert.equal(
    (await overlay(service, added)).comments[0].body,
    "Correct branch",
  );
  const after = await validateCommentsLayer(root, comments);
  assert.equal(after.reviewed.commitId, initial.reviewed.commitId);
  assert.equal(after.source.commitId, initial.source.commitId);
  assert.match(await branchFile(root, comments), /Correct branch/);
});

test("code edits in a branch fail closed while retaining previously validated bodies for diagnosis", async (t) => {
  const { root, comments, service, state } = await fixture(t);
  const added = (
    await service.comment(add(state, { body: "Do not lose this body" }))
  ).state;
  const id = (await overlay(service, added)).comments[0].id;
  const layer = await validateCommentsLayer(root, comments);
  const branch = layer.branches.find(
    (branch) => branch.code.changeId === comments.sourceChangeId,
  )!;
  const source = branch.files.get(filename)!.annotated;
  const result = Buffer.concat([
    source,
    Buffer.from("const unexpected = 1;\n"),
  ]);
  await withDiffEditor(
    {
      version: 1,
      repository: root,
      files: [
        {
          path: filename,
          base: null,
          source: source.toString("base64"),
          result: result.toString("base64"),
        },
      ],
    },
    (config) =>
      run(
        "jj",
        [
          "diffedit",
          "--from",
          "root()",
          "--to",
          `commit_id("${branch.comments.commitId}")`,
          "--tool",
          "jj-stamp",
          "--ignore-working-copy",
          ...config,
          "--",
          `root-file:${JSON.stringify(filename)}`,
        ],
        root,
      ),
  );
  await rejectsCode(
    validateCommentsLayer(root, comments),
    "COMMENTS_LAYER_INVALID",
  );
  const invalid = await service.getState();
  assert.equal(invalid.canEditComments, false);
  assert.match(invalid.commentUnavailable!, /actual code edits/);
  const diagnosed = await overlay(service, invalid);
  assert.equal(diagnosed.unmapped[0].id, id);
  assert.equal(diagnosed.unmapped[0].body, "Do not lose this body");
  assert.match(await branchFile(root, comments), /Do not lose this body/);
});

test("template source remains editable without interpreting its lexical syntax", async (t) => {
  const { service, state } = await fixture(t, false, {
    old: "const template = `old`;\n",
    new: "const template = `new`;\n",
  });
  const projected = await overlay(service, state);
  assert.equal(projected.editable, true);
  const added = (
    await service.comment(add(state, { line: 1, body: "Template note" }))
  ).state;
  assert.equal(
    (await overlay(service, added)).comments[0].body,
    "Template note",
  );
});

test("real-jj comment branches support Rust constructs and arbitrary text formats without changing code", async (t) => {
  const cases = [
    {
      name: "Rust lifetimes",
      path: "src/borrow.rs",
      old: "fn borrow<'a>(value: &'a str) -> &'a str {\n    value.trim_start_matches(\"20\")\n}\n",
    },
    {
      name: "inside a Rust raw string",
      path: "src/raw.rs",
      old: 'fn main() { let raw = r###"\n    20 café\n"###; }\n',
      squash: true,
    },
    {
      name: "inside nested Rust block comments",
      path: "src/nested.rs",
      old: "/* outer\n    /* nested 20 */\n*/\n",
    },
    {
      name: "Rust division",
      path: "src/division.rs",
      old: "fn ratio() -> i32 {\n    20 / 2\n}\n",
    },
    {
      name: "inside a Python multiline string",
      path: "src/message.py",
      old: 'message = """\n    20 café\n"""\n',
      squash: true,
    },
    {
      name: "JSON",
      path: "settings.json",
      old: '{\n  "value": 20\n}\n',
    },
    {
      name: "inside a Markdown code fence with CRLF",
      path: "README.md",
      old: '```json\n  {"value": 20}\n```\n',
      crlf: true,
    },
    {
      name: "extensionless text",
      path: "settings",
      old: "settings:\n\tvalue: 20\n",
    },
  ];
  for (const example of cases) {
    await t.test(example.name, async (t) => {
      const code = { old: example.old, new: example.old.replace("20", "21") };
      const { root, file, comments, service, state, source } = await fixture(
        t,
        example.crlf,
        code,
        example.path,
      );
      const oldSource = example.crlf
        ? code.old.replaceAll("\n", "\r\n")
        : code.old;
      const assertClean = async (current: State) => {
        assert.equal(current.source.commitId, state.source.commitId);
        assert.equal(current.parent!.commitId, state.parent!.commitId);
        assert.equal(
          (
            await jj(root, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])
          ).stdout.trim(),
          state.source.commitId,
        );
        assert.deepEqual(await readFile(file), Buffer.from(source));
        const clean = await service.getFile({
          version: current.version,
          path: example.path,
        });
        assert.equal(clean.oldFile!.contents, oldSource);
        assert.equal(clean.newFile!.contents, source);
        for (const contents of [
          clean.oldFile!.contents,
          clean.newFile!.contents,
        ])
          assert.doesNotMatch(contents, /JJ-STAMP/);
      };
      assert.equal(
        (await overlay(service, state, example.path)).editable,
        true,
      );
      const body = "Please check café\nKeep this draft 🦀";
      const added = (
        await service.comment(add(state, { path: example.path, line: 2, body }))
      ).state;
      const projected = await overlay(service, added, example.path);
      assert.equal(projected.editable, true);
      assert.deepEqual(projected.issues, []);
      assert.deepEqual(projected.unmapped, []);
      assert.equal(projected.comments.length, 1);
      const { id } = projected.comments[0];
      assert.deepEqual(
        projected.comments.map(({ id, body, startLine, endLine }) => ({
          id,
          body,
          startLine,
          endLine,
        })),
        [{ id, body, startLine: 2, endLine: 2 }],
      );
      const annotated = await branchFile(
        root,
        comments,
        comments.sourceChangeId,
        example.path,
      );
      const indent = /^[ \t]*/.exec(code.new.split("\n")[1])![0];
      assert.ok(
        annotated.includes(`${indent}// JJ-STAMP(${id}): Please check café`),
      );
      const validated = await validateCommentsLayer(root, comments);
      const branch = validated.branches.find(
        (branch) => branch.code.changeId === comments.sourceChangeId,
      )!;
      assert.deepEqual(
        branch.files.get(example.path)!.clean,
        Buffer.from(source),
      );
      await assertClean(added);

      const editedBody = "Edited café\nStill kept 🦀";
      let current = (
        await service.comment({
          version: added.version,
          path: example.path,
          action: "edit",
          id,
          body: editedBody,
        })
      ).state;
      assert.equal(
        (await overlay(service, current, example.path)).comments[0].body,
        editedBody,
      );
      await assertClean(current);

      if (example.squash) {
        const beforeSquash = await branchFile(
          root,
          comments,
          comments.sourceChangeId,
          example.path,
        );
        const moved = await service.squashLines({
          version: current.version,
          selections: selections(current, example.path),
        });
        assert.equal(moved.state.canUndo, true);
        assert.deepEqual(await readFile(file), Buffer.from(source));
        assert.doesNotMatch(
          moved.state.files.map((file) => file.patch).join(""),
          /JJ-STAMP/,
        );
        for (const revision of [
          `change_id("${comments.sourceChangeId}")`,
          `change_id("${comments.reviewedChangeId}")`,
          "@",
        ]) {
          const contents = await revisionFile(root, revision, example.path);
          assert.equal(contents, source);
          assert.doesNotMatch(contents, /JJ-STAMP/);
        }
        const reviewed = (
          await service.selectRevision({
            version: moved.state.version,
            changeId: comments.reviewedChangeId,
          })
        ).state;
        const onReviewed = await overlay(service, reviewed, example.path);
        assert.deepEqual(onReviewed.unmapped, []);
        assert.ok(
          onReviewed.comments.some(
            (comment) =>
              comment.id === id &&
              comment.body === editedBody &&
              comment.startLine === 2 &&
              comment.endLine === 2,
          ),
        );
        const remaining = (
          await service.selectRevision({
            version: reviewed.version,
            changeId: comments.sourceChangeId,
          })
        ).state;
        current = (await service.undo(remaining.version)).state;
        await assertClean(current);
        assert.equal(
          await branchFile(
            root,
            comments,
            comments.sourceChangeId,
            example.path,
          ),
          beforeSquash,
        );
        assert.ok(
          (await overlay(service, current, example.path)).comments.some(
            (comment) => comment.id === id && comment.body === editedBody,
          ),
        );
      }

      const removed = (
        await service.comment({
          version: current.version,
          path: example.path,
          action: "remove",
          id,
        })
      ).state;
      assert.deepEqual(
        (await overlay(service, removed, example.path)).comments,
        [],
      );
      assert.equal(
        await branchFile(root, comments, comments.sourceChangeId, example.path),
        source,
      );
      await assertClean(removed);
      const final = await validateCommentsLayer(root, comments);
      assert.equal(final.source.commitId, state.source.commitId);
      assert.equal(final.reviewed.commitId, state.parent!.commitId);
    });
  }
});

test("annotated code squashes normally, projects across branches onto Reviewed, edits UUID owner, and undoes safely", async (t) => {
  const { root, file, comments, service, state, source } = await fixture(t);
  const added = (
    await service.comment(add(state, { body: "Follows this line" }))
  ).state;
  const id = (await overlay(service, added)).comments[0].id;
  const squashed = await service.squashLines({
    version: added.version,
    selections: selections(added),
  });
  assert.equal(squashed.state.canUndo, true);
  assert.equal(await readFile(file, "utf8"), source);
  assert.doesNotMatch(
    squashed.state.files.map((file) => file.patch).join(""),
    /JJ-STAMP/,
  );
  const reviewed = (
    await service.selectRevision({
      version: squashed.state.version,
      changeId: comments.reviewedChangeId,
    })
  ).state;
  const projected = await overlay(service, reviewed);
  assert.ok(
    projected.comments.some(
      (comment) => comment.id === id && comment.startLine === 2,
    ),
  );
  assert.equal(projected.unmapped.length, 0);
  const edited = (
    await service.comment({
      version: reviewed.version,
      path: filename,
      action: "edit",
      id,
      body: "Edited across branch",
    })
  ).state;
  assert.equal(edited.canUndo, false);
  assert.match(await branchFile(root, comments), /Edited across branch/);
  assert.doesNotMatch(
    await branchFile(root, comments, comments.reviewedChangeId),
    /Edited across branch/,
  );
  // A separate fixture exercises exact undo without the intervening edit.
  const other = await fixture(t);
  const annotated = (await other.service.comment(add(other.state))).state;
  const moved = await other.service.squashLines({
    version: annotated.version,
    selections: selections(annotated),
  });
  const undone = await other.service.undo(moved.state.version);
  assert.equal((await overlay(other.service, undone.state)).comments.length, 1);
  assert.equal(await readFile(other.file, "utf8"), other.source);
});

test("serialized duplicates and unsnapshotted code edits reject stale requests without extra comments", async (t) => {
  const { service, state, file } = await fixture(t);
  const results = await Promise.allSettled([
    service.comment(add(state)),
    service.comment(add(state)),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const fresh = await service.getState();
  assert.equal((await overlay(service, fresh)).comments.length, 1);
  await writeFile(file, working + "const external = 1;\n");
  await rejectsCode(service.comment(add(fresh)), "STALE_STATE");
});

test("external code in a comment branch, working-copy movement and unexpected descendants fail closed", async (t) => {
  const { root, comments, service, state } = await fixture(t);
  const branch = comments.branches.find(
    (branch) => branch.codeChangeId === comments.sourceChangeId,
  )!;
  await jj(root, [
    "new",
    "--no-edit",
    "-r",
    `change_id("${branch.commentsChangeId}")`,
    "-m",
    "Unexpected descendant",
  ]);
  const invalid = await service.getState();
  assert.equal(invalid.commentsEnabled, true);
  assert.equal(invalid.canEditComments, false);
  assert.match(invalid.commentUnavailable!, /leaf/);
  await rejectsCode(service.comment(add(invalid)), "COMMENTS_UNAVAILABLE");
  await rejectsCode(
    validateCommentsLayer(root, comments),
    "COMMENTS_LAYER_INVALID",
  );
  await rejectsCode(
    service.squashLines({
      version: invalid.version,
      selections: selections(state),
    }),
    "SQUASH_UNAVAILABLE",
  );
  const other = await fixture(t);
  await jj(other.root, ["new", "-m", "Moved workspace"]);
  const moved = await other.service.getState();
  assert.equal(moved.canEditComments, false);
  assert.match(moved.commentUnavailable!, /working copy/);
});

test("nonzero or unattributed diffedit installs a nonreplayable in-memory recovery guard", async (t) => {
  for (const mode of ["exit", "attribution"] as const) {
    const { root, comments } = await fixture(t);
    let calls = 0;
    let breakAttribution = false;
    const service = new ReviewService({
      repoPath: root,
      comments,
      toolRunner: async (command, args, cwd) => {
        calls++;
        const result = await run(command, args, cwd);
        if (mode === "exit")
          throw new ProcessError(
            command,
            args,
            { ...result, stderr: "post-write failure" },
            1,
            cwd,
          );
        breakAttribution = true;
        return result;
      },
      jjRunner: async (cwd, args) => {
        if (breakAttribution && args[0] === "op") {
          breakAttribution = false;
          throw new Error("unreadable attribution");
        }
        return jj(cwd, args);
      },
    });
    const state = await service.getState();
    await rejectsCode(
      service.comment(add(state)),
      mode === "exit" ? "PARTIAL_FAILURE" : "HISTORY_CHANGED",
    );
    assert.match(await branchFile(root, comments), /JJ-STAMP/);
    const current = await service.getState();
    await rejectsCode(service.comment(add(current)), "RECOVERY_REQUIRED");
    await rejectsCode(
      service.selectRevision({
        version: current.version,
        changeId: comments.reviewedChangeId,
      }),
      "RECOVERY_REQUIRED",
    );
    assert.equal(calls, 1);
    assert.equal(
      (await new ReviewService({ repoPath: root, comments }).getState())
        .canUndo,
      false,
    );
  }
});

test("post-attribution refresh failure reports completed revision edit without false pending guard", async (t) => {
  const { root, comments } = await fixture(t);
  let fail = false;
  let written = false;
  const service = new ReviewService({
    repoPath: root,
    comments,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      written = true;
      return result;
    },
    jjRunner: async (cwd, args) => {
      if (fail && written && args[0] === "log") {
        fail = false;
        throw new Error("refresh failed");
      }
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  fail = true;
  await assert.rejects(
    service.comment(add(state)),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "HISTORY_CHANGED" &&
      Boolean(error.details?.completedOperation) &&
      !error.details?.pending,
  );
  const fresh = await service.getState();
  assert.equal((await overlay(service, fresh)).comments.length, 1);
  await service.selectRevision({
    version: fresh.version,
    changeId: comments.reviewedChangeId,
  });
});

test("HTTP validation and loopback protection; separate overlay never contaminates immutable code bytes", async (t) => {
  const { service, state, root } = await fixture(t);
  const server = await startLocalServer({ service, assetsDir: root, port: 0 });
  t.after(() => server.close());
  const request = (body: unknown, headers = {}, route = "comments") =>
    fetch(new URL(`api/${route}`, server.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fold-Request": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  for (const bad of [
    { ...add(state), line: 0 },
    { ...add(state), body: "" },
    { ...add(state), body: "unsafe\r\ntext" },
    { ...add(state), body: "unsafe\ud800text" },
    { ...add(state), unknown: true },
    { version: state.version, path: filename, action: "remove", id: "bad" },
  ])
    assert.equal((await request(bad)).status, 400);
  assert.equal(
    (await request(add(state), { "X-Fold-Request": "0" })).status,
    403,
  );
  assert.equal(
    (await request(add(state), { Origin: "https://evil.example" })).status,
    403,
  );
  const body = "Please\u2028check\u2029this\tvalue";
  const saved = await request(add(state, { body }));
  assert.equal(saved.status, 200);
  const next = (await saved.json()).state;
  const projected = await request(
    { version: next.version, path: filename },
    {},
    "comments/file",
  );
  assert.equal(projected.status, 200);
  const card = (await projected.json()).comments[0];
  assert.equal(card.startLine, 2);
  assert.equal(card.body, body);
  const immutable = await request(
    { commitId: state.source.commitId, path: filename },
    {},
    "commit-file",
  );
  assert.equal(immutable.status, 200);
  assert.equal((await immutable.json()).newFile.contents, working);
  const context = await fetch(new URL("api/pr/context", server.url));
  assert.equal(await context.json(), null);
});
