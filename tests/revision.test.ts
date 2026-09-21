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
import { jj, run } from "../server/process.ts";
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
const journalPath = (options: ServiceOptions) =>
  path.join(
    options.dataDir,
    `operations-${createHash("sha256").update(options.repoPath).digest("hex").slice(0, 20)}.json`,
  );

// Run against actual jj and jj-hunk-tool, including non-working-copy rewrites.
test("non-@ ancestor is resolved once and follows its change through full squash, restart, undo and workspace moves", async () => {
  const options = await fixture();
  const workingCopyId = await revisionId(options.repoPath, "@");
  const selectedId = await revisionId(options.repoPath, "@-");
  let resolutions = 0;
  const service = new ReviewService({
    ...options,
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
    (await new ReviewService(options).getState()).canUndo,
    false,
    "another source cannot undo this review's squash",
  );
  const restarted = new ReviewService({ ...options, revision: selectedId });
  assert.equal((await restarted.getState()).canUndo, true);
  const undone = await restarted.undo(result.state.version);
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
  assert.ok(!(await readdir(options.dataDir)).includes("active-repo.json"));
});

test("default @ is a one-time choice, not a moving source", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
  const initial = await service.getState();
  await jj(options.repoPath, ["new", "-m", "Unrelated workspace"]);
  const moved = await service.getState();
  assert.deepEqual(moved.source, initial.source);
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
    ...options,
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
      new ReviewService({ ...options, revision }).getState(),
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
  const service = new ReviewService(options);
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
      ...options,
      revision: initial.source.commitId,
    }).getState(),
    "INVALID_REVISION",
  );
  assert.notEqual(
    (await new ReviewService(options).getState()).source.changeId,
    initial.source.changeId,
  );
});

test("external divergence rejects cached source and even an explicitly selected divergent commit", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
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
      ...options,
      revision: initial.source.changeId,
    }).getState(),
    "INVALID_REVISION",
  );
  await rejectsCode(
    new ReviewService({ ...options, revision: commits[0] }).getState(),
    "INVALID_REVISION",
  );
});

test("initial read becoming stale does not re-resolve @ on re-entry", async () => {
  const options = await fixture();
  const original = await revisionId(options.repoPath, "@");
  let moved = false;
  const service = new ReviewService({
    ...options,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "hunks" && !moved) {
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

test("failed initialization cannot skip a corrupt journal on re-entry", async () => {
  const options = await fixture();
  await writeFile(journalPath(options), "{broken");
  const service = new ReviewService(options);
  await assert.rejects(service.getState(), SyntaxError);
  await writeFile(journalPath(options), "{}");
  await jj(options.repoPath, [
    "new",
    "-m",
    "Workspace moved after init failure",
  ]);
  await assert.rejects(
    service.getState(),
    SyntaxError,
    "only a new service may reinitialize after journal recovery",
  );
  assert.equal(
    (await new ReviewService(options).getState()).source.description,
    "Workspace moved after init failure",
  );
});

test("initial conflicts do not clear identity or the durable recovery journal", async () => {
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
  await writeFile(journalPath(options), JSON.stringify(pending));
  const service = new ReviewService(options);
  await rejectsCode(service.getState(), "CONFLICTED_SOURCE");
  await jj(options.repoPath, ["edit", original]);
  await rejectsCode(service.getState(), "CONFLICTED_SOURCE");
  await jj(options.repoPath, ["abandon", conflictId]);
  await rejectsCode(service.getState(), "SOURCE_UNAVAILABLE");
  assert.deepEqual(
    JSON.parse(await readFile(journalPath(options), "utf8")),
    pending,
  );
  const restarted = new ReviewService(options);
  const state = await restarted.getState();
  await rejectsCode(
    restarted.squashLines({
      version: state.version,
      selections: selections(state),
    }),
    "RECOVERY_REQUIRED",
  );
});

test("service construction requires both repository and journal directory", () => {
  assert.throws(
    () => new ReviewService({ dataDir: "/tmp" } as ServiceOptions),
    /explicit repoPath and dataDir/,
  );
  assert.throws(
    () => new ReviewService({ repoPath: process.cwd() } as ServiceOptions),
    /explicit repoPath and dataDir/,
  );
});

test("explicit selection switches to a mutable ancestor, invalidates previews and remains pinned through later rewrites", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
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

test("invalid and immutable choices retain source and previews; source prefixes use identity rather than bookmarks", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
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
  const rootId = await revisionId(options.repoPath, "root()");
  await rejectsCode(
    service.selectRevision({ version: original.version, changeId: rootId }),
    "IMMUTABLE_SOURCE",
  );
  assert.deepEqual(await service.getState(), original);
  // Rejected selections did not consume an already validated preview.
  const squashed = await service.squash(preview.token);
  const selected = (
    await service.selectRevision({
      version: squashed.state.version,
      changeId: original.parent!.changeId.slice(0, 12),
    })
  ).state;
  assert.equal(selected.source.changeId, original.parent!.changeId);
});

test("selection is serialized, and undo stays scoped to its exact selected source and repository operation", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
  const initial = await service.getState();
  const result = await service.squashLines({
    version: initial.version,
    selections: [selections(initial)[0]],
  });
  assert.equal(result.state.canUndo, true);
  const journal = await readFile(journalPath(options), "utf8");
  const other = (
    await service.selectRevision({
      version: result.state.version,
      changeId: result.state.parent!.changeId,
    })
  ).state;
  assert.equal(other.canUndo, false);
  await rejectsCode(service.undo(other.version), "UNDO_UNAVAILABLE");
  assert.equal(await readFile(journalPath(options), "utf8"), journal);
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

test("pending recovery journal prevents explicit source switching", async () => {
  const options = await fixture();
  const original = await new ReviewService(options).getState();
  const pending = {
    pending: {
      beforeOperation: original.operation,
      sourceCommit: original.source.commitId,
      kind: "squash",
    },
  };
  await writeFile(journalPath(options), JSON.stringify(pending));
  const service = new ReviewService(options);
  const state = await service.getState();
  await rejectsCode(
    service.selectRevision({
      version: state.version,
      changeId: state.parent!.changeId,
    }),
    "RECOVERY_REQUIRED",
  );
  assert.deepEqual(await service.getState(), state);
  assert.deepEqual(
    JSON.parse(await readFile(journalPath(options), "utf8")),
    pending,
  );
});

test("selecting a mutable merge exposes no destination and refuses squash", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
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
    ...options,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "hunks" && args.includes(chosenCommit) && !moved) {
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
  const service = new ReviewService(options);
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
    "immutable nodes are represented as non-selectable",
  );
  const renderedIds = (
    await jj(options.repoPath, [
      "log",
      "--config",
      "ui.log-word-wrap=false",
      "-r",
      `(${reviewLogRevset}) | change_id("${sourceId}")`,
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

test("review graph ignores the default revset and includes selected revisions outside its filter", async () => {
  const options = await fixture();
  const service = new ReviewService(options);
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
  const log = await service.getLog();
  assert.ok(!log.output.includes(initial.source.description));
  assert.ok(
    log.rows.some((row) => row.revision?.changeId === initial.source.changeId),
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
  const service = new ReviewService({ ...options, revision: "@--" });
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
  const service = new ReviewService({ ...options, revision: originalId });
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
