import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ApiError,
  ReviewService,
  reviewLogRevset,
  type ServiceOptions,
  type State,
} from "../server/service.ts";
import { jj, run, ProcessError } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-revision-"));
  const repoPath = await createDemo(dataDir);
  return { dataDir, repoPath };
}
function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}
const revisionId = async (root: string, revision: string, kind = "change_id") =>
  (
    await jj(root, ["log", "--no-graph", "-r", revision, "-T", kind])
  ).stdout.trim();
const selections = (state: State) =>
  state.files.flatMap((file) =>
    file.hunks.map((hunk) => ({
      id: hunk.id,
      lines: hunk.rows
        .filter((row) => /^[+-]/.test(row.raw))
        .map((row) => row.index),
    })),
  );
const legacyJournalPath = (options: { dataDir: string; repoPath: string }) =>
  path.join(
    options.dataDir,
    `operations-${createHash("sha256").update(options.repoPath).digest("hex").slice(0, 20)}.json`,
  );

function postWriteFailureService(repoPath: string) {
  return new ReviewService({
    repoPath,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") {
        throw new ProcessError(
          command,
          args,
          {
            ...result,
            stderr: "Simulated failure after a real history rewrite",
          },
          23,
        );
      }
      return result;
    },
  });
}

// Run against actual jj and the native diff editor, including non-working-copy rewrites.
test("non-@ ancestor is resolved once and follows its change through full squash, process-local undo and workspace moves", async () => {
  const options = await fixture();
  const workingCopyId = await revisionId(options.repoPath, "@");
  const selectedId = await revisionId(options.repoPath, "@-");
  let resolutions = 0;
  const service = new ReviewService({
    repoPath: options.repoPath,
    revision: "@-",
    jjRunner: (cwd, args) => {
      if (args[0] === "log" && args[args.indexOf("-r") + 1] === "@-")
        resolutions++;
      return jj(cwd, args);
    },
  });
  const initial = await service.getState();
  assert.equal(initial.source.changeId, selectedId);
  assert.notEqual(initial.source.changeId, workingCopyId);
  assert.equal(initial.source.description, "Add notification preferences");
  assert.equal(
    initial.parent!.description,
    "Build notification delivery service",
  );
  assert.deepEqual(
    initial.files.map((file) => file.path),
    ["src/preferences.ts"],
  );
  const context = await service.getFile({
    version: initial.version,
    path: initial.files[0].path,
  });
  assert.match(context.oldFile!.contents, /digest: 'daily'/);
  assert.match(context.newFile!.contents, /digest: 'off'/);
  const result = await service.squashLines({
    version: initial.version,
    selections: selections(initial),
  });
  assert.equal(result.state.source.changeId, selectedId);
  assert.notEqual(result.state.source.commitId, initial.source.commitId);
  assert.deepEqual(
    result.state.files,
    [],
    "--keep-emptied retains selected ancestor identity",
  );
  assert.equal(result.state.canUndo, true);
  assert.equal(await revisionId(options.repoPath, "@"), workingCopyId);
  assert.equal(
    (await new ReviewService({ repoPath: options.repoPath }).getState())
      .canUndo,
    false,
    "another source cannot undo this review's squash",
  );
  const restarted = new ReviewService({
    repoPath: options.repoPath,
    revision: selectedId,
  });
  const reopened = await restarted.getState();
  assert.equal(reopened.canUndo, false);
  assert.equal(reopened.operation, result.state.operation);
  assert.deepEqual(reopened.source, result.state.source);
  await rejectsCode(restarted.undo(reopened.version), "UNDO_UNAVAILABLE");
  assert.equal((await restarted.getState()).operation, result.state.operation);
  const undone = await service.undo(result.state.version);
  assert.equal(undone.state.source.commitId, initial.source.commitId);
  assert.deepEqual(undone.state.files, initial.files);
  assert.deepEqual(undone.state.targets, initial.targets);
  await jj(options.repoPath, ["new", "-m", "Moved workspace"]);
  const moved = await service.getState();
  assert.equal(moved.source.changeId, selectedId);
  assert.equal(moved.source.commitId, initial.source.commitId);
  assert.equal(resolutions, 1);
  assert.notEqual(await revisionId(options.repoPath, "@-"), selectedId);
  assert.equal("demo" in moved.repo, false);
  assert.deepEqual(await readdir(options.dataDir), [
    path.basename(options.repoPath),
  ]);
});

test("default @ is a one-time choice, not a moving source", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  await jj(options.repoPath, ["new", "-m", "Unrelated workspace"]);
  const moved = await service.getState();
  // A new change can lengthen jj's distinguishing prefix without changing
  // the selected revision. Compare identity/content and check the LIVE prefix.
  assert.deepEqual(moved.source, {
    ...initial.source,
    changeIdPrefix: await revisionId(
      options.repoPath,
      initial.source.commitId,
      "change_id.shortest(8).prefix()",
    ),
  });
  const hunk = initial.files[0].hunks[0];
  await rejectsCode(
    service.squashLines({
      version: initial.version,
      selections: [
        {
          id: hunk.id,
          lines: [hunk.rows.find((row) => row.raw.startsWith("+"))!.index],
        },
      ],
    }),
    "STALE_STATE",
  );
  const result = await service.squashLines({
    version: moved.version,
    selections: [
      {
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      },
    ],
  });
  assert.equal(result.state.source.changeId, initial.source.changeId);
  assert.notEqual(result.state.source.commitId, initial.source.commitId);
  assert.equal(
    (await service.undo(result.state.version)).state.source.commitId,
    initial.source.commitId,
  );
});

test("bookmark expressions resolve once; later movement and change-ID-like bookmarks cannot retarget the review", async () => {
  const options = await fixture();
  await jj(options.repoPath, ["bookmark", "create", "review-me", "-r", "@-"]);
  const service = new ReviewService({
    repoPath: options.repoPath,
    revision: 'bookmarks("review-me")',
  });
  const initial = await service.getState();
  await jj(options.repoPath, ["bookmark", "set", "review-me", "-r", "@"]);
  await jj(options.repoPath, [
    "bookmark",
    "create",
    initial.source.changeId,
    "-r",
    "@",
  ]);
  const after = await service.getState();
  assert.deepEqual(after.source, initial.source);
  assert.deepEqual(after.parent, initial.parent);
  assert.deepEqual(after.files, initial.files);
});

test("empty, absent, invalid, option-like and multi-revision expressions are rejected without mutations", async () => {
  const options = await fixture();
  const before = (
    await jj(options.repoPath, [
      "op",
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      "self.id()",
    ])
  ).stdout;
  for (const revision of [
    "",
    " ",
    "none()",
    "missing-bookmark",
    "@ | @-",
    "all()",
    "--help",
    "@); shell()",
    'bookmarks("missing")',
  ]) {
    await rejectsCode(
      new ReviewService({ repoPath: options.repoPath, revision }).getState(),
      "INVALID_REVISION",
    );
  }
  const after = (
    await jj(options.repoPath, [
      "op",
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      "self.id()",
    ])
  ).stdout;
  assert.equal(after, before);
});

test("external abandonment refuses cached source, pending preview and hidden initial commit instead of falling back to @", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  const preview = await service.preview({
    version: initial.version,
    target: initial.parent!.changeId,
    selections: selections(initial),
  });
  await jj(options.repoPath, ["new", "-m", "Surviving workspace"]);
  await jj(options.repoPath, ["abandon", initial.source.commitId]);
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  await rejectsCode(service.squash(preview.token), "SOURCE_UNAVAILABLE");
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  await rejectsCode(
    new ReviewService({
      repoPath: options.repoPath,
      revision: initial.source.commitId,
    }).getState(),
    "INVALID_REVISION",
  );
  assert.notEqual(
    (await new ReviewService({ repoPath: options.repoPath }).getState()).source
      .changeId,
    initial.source.changeId,
  );
});

test("external divergence rejects cached source and even an explicitly selected divergent commit", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  await jj(options.repoPath, [
    "describe",
    initial.source.commitId,
    "-m",
    "First concurrent rewrite",
  ]);
  await jj(options.repoPath, [
    "--at-operation",
    initial.operation,
    "describe",
    initial.source.commitId,
    "-m",
    "Second concurrent rewrite",
  ]);
  await jj(options.repoPath, ["status"]); // Reconcile concurrent operations, preserving both versions.
  const commits = (
    await revisionId(
      options.repoPath,
      `change_id("${initial.source.changeId}")`,
      'commit_id ++ "\\n"',
    )
  ).split("\n");
  assert.equal(
    commits.length,
    2,
    "fixture must contain actual divergent versions",
  );
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  await rejectsCode(
    new ReviewService({
      repoPath: options.repoPath,
      revision: initial.source.changeId,
    }).getState(),
    "INVALID_REVISION",
  );
  await rejectsCode(
    new ReviewService({
      repoPath: options.repoPath,
      revision: commits[0],
    }).getState(),
    "INVALID_REVISION",
  );
});

test("initial read becoming stale does not re-resolve @ on re-entry", async () => {
  const options = await fixture();
  const original = await revisionId(options.repoPath, "@");
  let moved = false;
  const service = new ReviewService({
    repoPath: options.repoPath,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (args[0] === "diff" && !moved) {
        moved = true;
        await jj(cwd, ["new", "-m", "Moved during initial read"]);
      }
      return result;
    },
  });
  await rejectsCode(service.getState(), "STALE_STATE");
  assert.equal((await service.getState()).source.changeId, original);
  assert.notEqual(await revisionId(options.repoPath, "@"), original);
});

test("corrupt legacy journal is ignored on initialization and later reads", async () => {
  const options = await fixture();
  const legacyPath = legacyJournalPath(options);
  await writeFile(legacyPath, "{broken");
  const entries = (await readdir(options.dataDir)).sort();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  assert.equal(initial.canUndo, false);
  await service.preview({
    version: initial.version,
    target: initial.parent!.changeId,
    selections: [selections(initial)[0]],
  });
  assert.equal((await service.getState()).operation, initial.operation);
  const restarted = new ReviewService({ repoPath: options.repoPath });
  assert.deepEqual(await restarted.getState(), initial);
  assert.equal(await readFile(legacyPath, "utf8"), "{broken");
  await jj(options.repoPath, [
    "new",
    "-m",
    "Workspace moved after initialization",
  ]);
  // Creating another change can lengthen jj's distinguishing prefix, while
  // the selected change and immutable commit identity remain pinned.
  const { changeIdPrefix: _oldPrefix, ...initialIdentity } = initial.source;
  const { changeIdPrefix: _newPrefix, ...currentIdentity } = (
    await service.getState()
  ).source;
  assert.deepEqual(currentIdentity, initialIdentity);
  assert.equal(
    (await new ReviewService({ repoPath: options.repoPath }).getState()).source
      .description,
    "Workspace moved after initialization",
  );
  assert.deepEqual((await readdir(options.dataDir)).sort(), entries);
});

test("initial conflicts remain pinned and readable; legacy pending journals have no effect", async () => {
  const options = await fixture();
  const original = await revisionId(options.repoPath, "@");
  await jj(options.repoPath, ["new", "-m", "Left"]);
  await writeFile(path.join(options.repoPath, "conflict.txt"), "left\n");
  const left = await revisionId(options.repoPath, "@", "commit_id");
  await jj(options.repoPath, ["new", original, "-m", "Right"]);
  await writeFile(path.join(options.repoPath, "conflict.txt"), "right\n");
  await jj(options.repoPath, ["new", left, "@", "-m", "Conflict"]);
  const conflictId = await revisionId(options.repoPath, "@");
  const pending = {
    pending: {
      beforeOperation: "f".repeat(128),
      sourceCommit: left,
      kind: "squash",
    },
  };
  await writeFile(legacyJournalPath(options), JSON.stringify(pending));
  const service = new ReviewService({ repoPath: options.repoPath });
  const conflicted = await service.getState();
  assert.equal(conflicted.source.changeId, conflictId);
  assert.equal(conflicted.parent, null);
  assert.deepEqual(conflicted.targets, []);
  assert.match(conflicted.squashUnavailable!, /conflicts/);
  await jj(options.repoPath, ["edit", original]);
  const pinned = await service.getState();
  assert.equal(pinned.source.changeId, conflictId);
  assert.equal(pinned.parent, null);
  assert.deepEqual(pinned.targets, []);
  await jj(options.repoPath, ["abandon", conflictId]);
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  assert.deepEqual(
    JSON.parse(await readFile(legacyJournalPath(options), "utf8")),
    pending,
  );
  const restarted = new ReviewService({ repoPath: options.repoPath });
  const state = await restarted.getState();
  assert.equal(state.canUndo, false);
  await restarted.preview({
    version: state.version,
    target: state.parent!.changeId,
    selections: [selections(state)[0]],
  });
  assert.equal((await restarted.getState()).operation, state.operation);
  assert.deepEqual(
    JSON.parse(await readFile(legacyJournalPath(options), "utf8")),
    pending,
  );
});

test("service construction requires only an explicit repository, not a state directory", () => {
  assert.throws(
    () => new ReviewService({} as ServiceOptions),
    /explicit repoPath/,
  );
  assert.doesNotThrow(() => new ReviewService({ repoPath: process.cwd() }));
});

test("explicit selection switches to a mutable ancestor, invalidates previews and remains pinned through later rewrites", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const original = await service.getState();
  const preview = await service.preview({
    version: original.version,
    target: original.parent!.changeId,
    selections: selections(original),
  });
  const selected = (
    await service.selectRevision({
      version: original.version,
      changeId: original.parent!.changeId,
    })
  ).state;
  assert.deepEqual(selected.source, original.parent);
  assert.equal(
    selected.parent!.description,
    "Build notification delivery service",
  );
  assert.notEqual(selected.version, original.version);
  assert.equal(
    selected.operation,
    original.operation,
    "selection itself does not rewrite jj history",
  );
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  await rejectsCode(
    service.selectRevision({
      version: original.version,
      changeId: original.source.changeId,
    }),
    "STALE_STATE",
  );
  const result = await service.squashLines({
    version: selected.version,
    selections: selections(selected),
  });
  assert.equal(result.state.source.changeId, selected.source.changeId);
  assert.notEqual(result.state.source.commitId, selected.source.commitId);
  assert.deepEqual(result.state.files, []);
  const undone = await service.undo(result.state.version);
  assert.equal(undone.state.source.commitId, selected.source.commitId);
  await jj(options.repoPath, [
    "new",
    "-m",
    "Workspace moved after explicit selection",
  ]);
  assert.equal(
    (await service.getState()).source.changeId,
    selected.source.changeId,
  );
});

test("invalid choices retain source and previews; immutable choices are readable and source prefixes use identity", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const original = await service.getState();
  const preview = await service.preview({
    version: original.version,
    target: original.parent!.changeId,
    selections: selections(original),
  });
  for (const changeId of ["", "@", "@ | @-", "--help", "abc123"]) {
    await rejectsCode(
      service.selectRevision({ version: original.version, changeId }),
      "INVALID_REQUEST",
    );
    assert.deepEqual(await service.getState(), original);
  }
  await rejectsCode(
    service.selectRevision({
      version: original.version,
      changeId: "k".repeat(32),
    }),
    "INVALID_REVISION",
  );
  assert.deepEqual(await service.getState(), original);
  // Rejected selections did not consume an already validated preview.
  const squashed = await service.squash(preview.token);
  const rootId = await revisionId(options.repoPath, "root()");
  const immutable = (
    await service.selectRevision({
      version: squashed.state.version,
      changeId: rootId,
    })
  ).state;
  assert.equal(immutable.source.changeId, rootId);
  assert.equal(immutable.parent, null);
  assert.deepEqual(immutable.targets, []);
  assert.match(immutable.squashUnavailable!, /immutable/);
  const selected = (
    await service.selectRevision({
      version: immutable.version,
      changeId: original.parent!.changeId.slice(0, 12),
    })
  ).state;
  assert.equal(selected.source.changeId, original.parent!.changeId);
});

test("selection is serialized, and undo stays scoped to its exact selected source and repository operation", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  const result = await service.squashLines({
    version: initial.version,
    selections: [selections(initial)[0]],
  });
  assert.equal(result.state.canUndo, true);
  const entries = (await readdir(options.dataDir)).sort();
  const other = (
    await service.selectRevision({
      version: result.state.version,
      changeId: result.state.parent!.changeId,
    })
  ).state;
  assert.equal(other.canUndo, false);
  await rejectsCode(service.undo(other.version), "UNDO_UNAVAILABLE");
  assert.deepEqual((await readdir(options.dataDir)).sort(), entries);
  const responses = await Promise.allSettled([
    service.selectRevision({
      version: other.version,
      changeId: initial.source.changeId,
    }),
    service.selectRevision({
      version: other.version,
      changeId: other.parent!.changeId,
    }),
  ]);
  assert.equal(responses[0].status, "fulfilled");
  assert.equal(responses[1].status, "rejected");
  if (responses[1].status === "rejected")
    assert.equal(responses[1].reason.code, "STALE_STATE");
  const back = await service.getState();
  assert.equal(
    back.canUndo,
    true,
    "switching back preserves exact undo if history has not changed",
  );
  assert.equal(
    (await service.undo(back.version)).state.source.commitId,
    initial.source.commitId,
  );
});

test("in-process pending recovery prevents source switching, but restart forgets it without rewriting history", async () => {
  const options = await fixture();
  const service = postWriteFailureService(options.repoPath);
  const original = await service.getState();
  await rejectsCode(
    service.squashLines({
      version: original.version,
      selections: [selections(original)[0]],
    }),
    "PARTIAL_FAILURE",
  );
  const state = await service.getState();
  await rejectsCode(
    service.selectRevision({
      version: state.version,
      changeId: state.parent!.changeId,
    }),
    "RECOVERY_REQUIRED",
  );
  assert.deepEqual(await service.getState(), state);
  const restarted = new ReviewService({ repoPath: options.repoPath });
  assert.deepEqual(await restarted.getState(), state);
  assert.equal(state.canUndo, false);
  const switched = await restarted.selectRevision({
    version: state.version,
    changeId: state.parent!.changeId,
  });
  assert.equal(switched.state.operation, state.operation);
  assert.equal(switched.state.canUndo, false);
  assert.deepEqual(await readdir(options.dataDir), [
    path.basename(options.repoPath),
  ]);
});

test("selecting a mutable merge exposes no destination and refuses squash", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  await jj(options.repoPath, [
    "new",
    initial.source.commitId,
    "-m",
    "Left parent",
  ]);
  await writeFile(path.join(options.repoPath, "left-only.txt"), "left\n");
  const left = await revisionId(options.repoPath, "@", "commit_id");
  await jj(options.repoPath, [
    "new",
    initial.source.commitId,
    "-m",
    "Right parent",
  ]);
  await writeFile(path.join(options.repoPath, "right-only.txt"), "right\n");
  await jj(options.repoPath, ["new", left, "@", "-m", "Chosen merge"]);
  await writeFile(path.join(options.repoPath, "merge-only.txt"), "merge\n");
  const merge = await revisionId(options.repoPath, "@");
  const before = await service.getState();
  const selected = (
    await service.selectRevision({ version: before.version, changeId: merge })
  ).state;
  assert.equal(selected.source.changeId, merge);
  assert.equal(selected.parent, null);
  assert.match(selected.squashUnavailable!, /exactly one immediate parent/);
  await rejectsCode(
    service.squashLines({
      version: selected.version,
      selections: selections(selected),
    }),
    "SQUASH_UNAVAILABLE",
  );
});

test("selection becoming stale leaves the prior source active", async () => {
  const options = await fixture();
  const chosenId = await revisionId(options.repoPath, "@-");
  const chosenCommit = await revisionId(options.repoPath, "@-", "commit_id");
  let moved = false;
  const service = new ReviewService({
    repoPath: options.repoPath,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (args[0] === "diff" && args.includes(chosenCommit) && !moved) {
        moved = true;
        await jj(cwd, ["new", "-m", "Race while selecting"]);
      }
      return result;
    },
  });
  const initial = await service.getState();
  await rejectsCode(
    service.selectRevision({ version: initial.version, changeId: chosenId }),
    "STALE_STATE",
  );
  assert.equal(moved, true);
  assert.equal(
    (await service.getState()).source.changeId,
    initial.source.changeId,
  );
});

test("structured log preserves actual jj graph prefixes, metadata, connector rows and working-copy flags", async () => {
  const options = await fixture();
  const sourceId = await revisionId(options.repoPath, "@");
  await jj(options.repoPath, [
    "describe",
    "-m",
    'Review <script> "quoted"\ttab\nsecond line',
  ]);
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  await jj(options.repoPath, [
    "new",
    initial.parent!.commitId,
    "-m",
    "Sibling",
  ]);
  const workingCopyId = await revisionId(options.repoPath, "@");
  const log = await service.getLog();
  const source = log.rows.find((row) => row.revision?.changeId === sourceId)!;
  assert.equal(source.revision!.description, 'Review <script> "quoted"\ttab');
  assert.equal(source.mutable, true);
  assert.equal(source.isWorkingCopy, false);
  assert.equal(source.isEmpty, false);
  assert.equal(
    log.rows.find((row) => row.revision?.changeId === workingCopyId)!.isEmpty,
    true,
  );
  assert.equal(
    log.rows.find((row) => row.revision?.changeId === workingCopyId)!
      .isWorkingCopy,
    true,
  );
  assert.ok(
    log.rows.some((row) => !row.revision),
    "jj's branch/connector lines are retained",
  );
  assert.ok(
    log.rows.some((row) => row.revision && !row.mutable),
    "immutable nodes retain their eligibility metadata",
  );
  const renderedIds = (
    await jj(options.repoPath, [
      "log",
      "--config",
      "ui.log-word-wrap=false",
      "-r",
      reviewLogRevset,
      "-T",
      'json(change_id) ++ "\\n"',
    ])
  ).stdout;
  assert.equal(
    log.rows
      .map(
        (row) =>
          row.graph +
          (row.revision ? JSON.stringify(row.revision.changeId) : ""),
      )
      .join("\n") + "\n",
    renderedIds,
  );
  assert.equal(
    log.output,
    (await jj(options.repoPath, ["log", "-r", reviewLogRevset])).stdout,
  );
  assert.equal(log.version, (await service.getState()).version);
});

test("review graph ignores the default revset and excludes selected revisions outside its filter", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    "revsets.log",
    "root()",
  ]);
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    "ui.log-word-wrap",
    "true",
  ]);
  assert.ok(
    (await service.getLog()).output.includes(initial.source.description),
    "explicit review revset overrides the configured default log",
  );
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    "user.email",
    "another-reviewer@example.com",
  ]);
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    'revset-aliases."tracked_remote_bookmarks()"',
    `change_id("${initial.parent!.changeId}")`,
  ]);
  const log = await service.getLog();
  assert.ok(!log.output.includes(initial.source.description));
  assert.ok(
    log.rows.some((row) => row.revision?.changeId === initial.parent!.changeId),
    "Tracked remote bookmark heads are included without their descendants",
  );
  assert.ok(
    !log.rows.some((row) => row.revision?.changeId === initial.source.changeId),
  );
  assert.ok(
    log.rows.every(
      (row) => !row.revision || /^[k-z]+$/.test(row.revision.changeId),
    ),
  );
});

test("divergent API choices cannot poison an unrelated selected source", async () => {
  const options = await fixture();
  const divergentId = await revisionId(options.repoPath, "@");
  const service = new ReviewService({
    repoPath: options.repoPath,
    revision: "@--",
  });
  const initial = await service.getState();
  await jj(options.repoPath, [
    "describe",
    divergentId,
    "-m",
    "First candidate rewrite",
  ]);
  await jj(options.repoPath, [
    "--at-operation",
    initial.operation,
    "describe",
    divergentId,
    "-m",
    "Second candidate rewrite",
  ]);
  await jj(options.repoPath, ["status"]);
  const before = await service.getState();
  await rejectsCode(
    service.selectRevision({ version: before.version, changeId: divergentId }),
    "INVALID_REVISION",
  );
  assert.deepEqual(await service.getState(), before);
});

test("a mutable sibling can be selected and uses its own immediate parent", async () => {
  const options = await fixture();
  const originalId = await revisionId(options.repoPath, "@");
  await jj(options.repoPath, ["new", "@--", "-m", "Sibling source"]);
  await writeFile(
    path.join(options.repoPath, "sibling.txt"),
    "independent sibling change\n",
  );
  const siblingId = await revisionId(options.repoPath, "@");
  const siblingParent = await revisionId(options.repoPath, "@-");
  const service = new ReviewService({
    repoPath: options.repoPath,
    revision: originalId,
  });
  const original = await service.getState();
  assert.notEqual(original.parent!.changeId, siblingParent);
  assert.ok(!original.targets.some((target) => target.changeId === siblingId));
  const selected = (
    await service.selectRevision({
      version: original.version,
      changeId: siblingId,
    })
  ).state;
  assert.equal(selected.parent!.changeId, siblingParent);
  assert.deepEqual(
    selected.files.map((file) => file.path),
    ["sibling.txt"],
  );
  const result = await service.squashLines({
    version: selected.version,
    selections: selections(selected),
  });
  assert.equal(result.state.source.changeId, siblingId);
  assert.deepEqual(result.state.files, []);
  assert.equal(
    (await service.undo(result.state.version)).state.source.commitId,
    selected.source.commitId,
  );
});

test("state and graph batch revision author and jj's distinguishing change prefix", async () => {
  const options = await fixture();
  const description = 'Quoted "title" <not-markup>\twith a tab';
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    "user.name",
    "Ada Example",
  ]);
  await jj(options.repoPath, [
    "new",
    "-m",
    `${description}\n\nA longer description body.`,
  ]);
  await writeFile(
    path.join(options.repoPath, "author.txt"),
    "metadata fixture\n",
  );
  let toolCalls = 0;
  const service = new ReviewService({
    repoPath: options.repoPath,
    toolRunner: (command, args, cwd) => {
      toolCalls++;
      return run(command, args, cwd);
    },
  });
  const state = await service.getState();
  assert.equal(state.source.author, "Ada Example");
  assert.equal(state.source.description, description);
  assert.equal(state.parent!.author, "Orbit Team");
  assert.equal(
    state.source.changeIdPrefix,
    await revisionId(options.repoPath, "@", "change_id.shortest(8).prefix()"),
  );
  assert.ok(state.source.changeId.startsWith(state.source.changeIdPrefix!));
  toolCalls = 0;
  const graph = await service.getLog({ includeOutput: false });
  assert.deepEqual(
    graph.rows.find((row) => row.revision?.changeId === state.source.changeId)
      ?.revision,
    state.source,
  );
  assert.equal(graph.version, state.version);
  assert.equal(
    toolCalls,
    0,
    "revision metadata uses existing jj queries, never a mutation tool",
  );
  assert.deepEqual(
    (await new ReviewService({ repoPath: options.repoPath }).getState()).source,
    state.source,
  );
});

test("leaving an empty working copy can abandon the pinned source while the new @ is healthy; graph permits only explicit recovery", async () => {
  const options = await fixture();
  const healthyId = await revisionId(options.repoPath, "@");
  await jj(options.repoPath, ["new"]);
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  assert.deepEqual(initial.files, []);
  await jj(options.repoPath, ["edit", healthyId]);
  assert.equal(await revisionId(options.repoPath, "@"), healthyId);
  assert.equal(
    await revisionId(
      options.repoPath,
      `change_id("${initial.source.changeId}")`,
    ),
    "",
    "jj automatically abandoned the empty undescribed working copy",
  );
  await assert.rejects(service.getState(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    assert.ok(error.message.includes(initial.source.changeId));
    assert.match(error.message, /no visible revision/);
    assert.doesNotMatch(error.message, /divergent/);
    assert.deepEqual(error.details, {
      sourceChangeId: initial.source.changeId,
      sourceStatus: "missing",
    });
    return true;
  });
  const graph = await service.getLog({ includeOutput: false });
  assert.notEqual(graph.version, initial.version);
  assert.ok(
    graph.rows.some(
      (row) => row.isWorkingCopy && row.revision?.changeId === healthyId,
    ),
  );
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  await rejectsCode(
    service.selectRevision({ version: initial.version, changeId: healthyId }),
    "STALE_STATE",
  );
  await rejectsCode(
    service.selectRevision({
      version: graph.version,
      changeId: initial.source.changeId,
    }),
    "INVALID_REVISION",
  );
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  const selected = (
    await service.selectRevision({
      version: graph.version,
      changeId: healthyId,
    })
  ).state;
  assert.equal(selected.source.changeId, healthyId);
  assert.equal(selected.canUndo, false);
  assert.deepEqual(await service.getState(), selected);
});

test("divergent source diagnostics distinguish multiple revisions and the graph enables explicit recovery without resolving divergence", async () => {
  const options = await fixture();
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  const preview = await service.preview({
    version: initial.version,
    target: initial.parent!.changeId,
    selections: selections(initial),
  });
  await jj(options.repoPath, [
    "describe",
    initial.source.commitId,
    "-m",
    "First rewrite",
  ]);
  await jj(options.repoPath, [
    "--at-operation",
    initial.operation,
    "describe",
    initial.source.commitId,
    "-m",
    "Second rewrite",
  ]);
  await jj(options.repoPath, ["status"]);
  await assert.rejects(service.getState(), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "SOURCE_UNAVAILABLE");
    assert.ok(error.message.includes(initial.source.changeId));
    assert.match(error.message, /divergent \(2 visible revisions\)/);
    assert.doesNotMatch(error.message, /abandoned/);
    assert.equal(error.details?.sourceStatus, "divergent");
    return true;
  });
  const graph = await service.getLog({ includeOutput: false });
  assert.equal(
    graph.rows.filter(
      (row) => row.revision?.changeId === initial.source.changeId,
    ).length,
    2,
  );
  await rejectsCode(
    service.selectRevision({
      version: graph.version,
      changeId: initial.source.changeId,
    }),
    "INVALID_REVISION",
  );
  const selected = (
    await service.selectRevision({
      version: graph.version,
      changeId: initial.parent!.changeId,
    })
  ).state;
  assert.equal(selected.source.changeId, initial.parent!.changeId);
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  assert.equal(
    (
      await revisionId(
        options.repoPath,
        `change_id("${initial.source.changeId}")`,
        'commit_id ++ "\\n"',
      )
    ).split("\n").length,
    2,
  );
});

test("graph access with an unavailable source does not bypass in-process pending recovery", async () => {
  const options = await fixture();
  const service = postWriteFailureService(options.repoPath);
  const initial = await service.getState();
  await rejectsCode(
    service.squashLines({
      version: initial.version,
      selections: [selections(initial)[0]],
    }),
    "PARTIAL_FAILURE",
  );
  await jj(options.repoPath, ["abandon", initial.source.changeId]);
  const graph = await service.getLog({ includeOutput: false });
  await rejectsCode(
    service.selectRevision({
      version: initial.version,
      changeId: initial.parent!.changeId,
    }),
    "STALE_STATE",
  );
  await rejectsCode(
    service.selectRevision({
      version: graph.version,
      changeId: initial.parent!.changeId,
    }),
    "RECOVERY_REQUIRED",
  );
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  const beforeRestart = (
    await jj(options.repoPath, [
      "op",
      "log",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      "self.id()",
    ])
  ).stdout.trim();
  const restarted = new ReviewService({ repoPath: options.repoPath });
  const current = await restarted.getState();
  assert.equal(current.canUndo, false);
  assert.equal(current.operation, beforeRestart);
  await restarted.getLog({ includeOutput: false });
  assert.equal((await restarted.getState()).operation, beforeRestart);
  assert.deepEqual(await readdir(options.dataDir), [
    path.basename(options.repoPath),
  ]);
});

test("unavailable-source recovery revalidates history before publishing a candidate", async () => {
  const options = await fixture();
  let changeDuringSelection = false;
  const service = new ReviewService({
    repoPath: options.repoPath,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (changeDuringSelection && args[0] === "diff") {
        changeDuringSelection = false;
        await jj(cwd, ["new", "-m", "External operation during recovery"]);
      }
      return result;
    },
  });
  const initial = await service.getState();
  await jj(options.repoPath, ["abandon", initial.source.changeId]);
  const graph = await service.getLog({ includeOutput: false });
  changeDuringSelection = true;
  await rejectsCode(
    service.selectRevision({
      version: graph.version,
      changeId: initial.parent!.changeId,
    }),
    "STALE_STATE",
  );
  assert.equal(changeDuringSelection, false);
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  const refreshed = await service.getLog({ includeOutput: false });
  assert.notEqual(refreshed.version, graph.version);
  assert.equal(
    (
      await service.selectRevision({
        version: refreshed.version,
        changeId: initial.parent!.changeId,
      })
    ).state.source.changeId,
    initial.parent!.changeId,
  );
});

test("clean source above resolved ancestor conflicts stays writable; conflicted sources can be entered and left via graph", async () => {
  const options = await fixture();
  const base = await revisionId(options.repoPath, "@");
  await jj(options.repoPath, ["new", "-m", "Left branch"]);
  await writeFile(path.join(options.repoPath, "conflict.txt"), "left\n");
  const left = await revisionId(options.repoPath, "@", "commit_id");
  await jj(options.repoPath, ["new", base, "-m", "Right branch"]);
  await writeFile(path.join(options.repoPath, "conflict.txt"), "right\n");
  await jj(options.repoPath, ["new", left, "@", "-m", "Conflicted merge"]);
  const conflictId = await revisionId(options.repoPath, "@");
  const service = new ReviewService({ repoPath: options.repoPath });
  const initialConflict = await service.getState();
  assert.equal(initialConflict.source.changeId, conflictId);
  assert.equal(initialConflict.parent, null);
  assert.deepEqual(initialConflict.targets, []);
  assert.match(initialConflict.squashUnavailable!, /conflicts/);
  await jj(options.repoPath, ["new", "-m", "Resolved descendant"]);
  await writeFile(path.join(options.repoPath, "conflict.txt"), "resolved\n");
  await jj(options.repoPath, ["new", "-m", "Empty parent"]);
  await jj(options.repoPath, ["new", "-m", "Healthy source"]);
  await writeFile(path.join(options.repoPath, "healthy.txt"), "review me\n");
  const healthy = await revisionId(options.repoPath, "@");
  const graph = await service.getLog({ includeOutput: false });
  assert.equal((await service.getState()).source.changeId, conflictId);
  const state = (
    await service.selectRevision({ version: graph.version, changeId: healthy })
  ).state;
  assert.equal(state.parent!.description, "Empty parent");
  assert.ok(!state.targets.some((target) => target.changeId === conflictId));
  assert.equal(state.squashUnavailable, undefined);
  const conflict = (
    await service.selectRevision({
      version: state.version,
      changeId: conflictId,
    })
  ).state;
  assert.equal(conflict.source.changeId, conflictId);
  assert.equal(conflict.parent, null);
  assert.deepEqual(conflict.targets, []);
  assert.match(conflict.squashUnavailable!, /conflicts/);
  const returned = (
    await service.selectRevision({
      version: conflict.version,
      changeId: healthy,
    })
  ).state;
  assert.equal(returned.source.changeId, healthy);
  const result = await service.squashLines({
    version: returned.version,
    selections: selections(returned),
  });
  assert.equal(result.state.source.changeId, healthy);
  assert.deepEqual(result.state.files, []);
});

test("unavailable-source graph respects the filter even when the working copy is outside mine()", async () => {
  const options = await fixture();
  const healthy = await revisionId(options.repoPath, "@");
  await jj(options.repoPath, ["new"]);
  const service = new ReviewService({ repoPath: options.repoPath });
  const initial = await service.getState();
  await jj(options.repoPath, ["edit", healthy]);
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    "user.email",
    "different-user@example.com",
  ]);
  const graph = await service.getLog({ includeOutput: false });
  const workingCopy = graph.rows.find((row) => row.isWorkingCopy);
  assert.equal(workingCopy, undefined);
  assert.ok(
    !graph.rows.some(
      (row) => row.revision?.changeId === initial.source.changeId,
    ),
  );
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  assert.equal(
    (
      await service.selectRevision({
        version: graph.version,
        changeId: healthy,
      })
    ).state.source.changeId,
    healthy,
  );
});
