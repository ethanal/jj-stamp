import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFile,
  mkdtemp,
  readFile,
  readdir,
  mkdir,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApiError, ReviewService, type State } from "../server/service.ts";
import { jj, run, ProcessError } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-recovery-"));
  const root = await createDemo(dataDir);
  return { dataDir, root };
}
function selection(state: State) {
  const hunk = state.files[0].hunks[0];
  return {
    version: state.version,
    selections: [
      {
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      },
    ],
  };
}
async function rejectsCode(promise: Promise<unknown>, code: string) {
  let caught: ApiError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    caught = error;
    return true;
  });
  return caught!;
}

test("a snapshot after positive squash attribution disables undo, not future reviewed work", async () => {
  const { root } = await fixture();
  let squashCalls = 0;
  let awaitingAttribution = false;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") {
        squashCalls++;
        awaitingAttribution = true;
      }
      return result;
    },
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (awaitingAttribution && args[0] === "op" && args[1] === "log") {
        awaitingAttribution = false;
        // The service has captured the real squash operation; another process
        // records a snapshot before its post-success state read can finish.
        await appendFile(
          path.join(root, "src/preferences.ts"),
          "\n// external edit\n",
        );
        await jj(root, ["status"]);
      }
      return result;
    },
  });
  const before = await service.getState();
  const error = await rejectsCode(
    service.squashLines(selection(before)),
    "HISTORY_CHANGED",
  );
  assert.match(error.message, /squash completed/i);
  const after = await service.getState();
  assert.equal(after.canUndo, false);
  assert.notEqual(after.source.commitId, before.source.commitId);
  await rejectsCode(service.undo(after.version), "UNDO_UNAVAILABLE");
  await service.preview({
    ...selection(after),
    target: after.parent!.changeId,
  });
  assert.equal(
    squashCalls,
    1,
    "reads, undo, and preview never replay the squash",
  );
});

test("a snapshot during post-squash validation cannot leave a false pending guard or claim nothing squashed", async () => {
  const { root } = await fixture();
  let squashed = false;
  let edited = false;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") squashed = true;
      if (squashed && !edited && args[0] === "hunks") {
        edited = true;
        await appendFile(
          path.join(root, "src/preferences.ts"),
          "\n// edit while rendering\n",
        );
      }
      return result;
    },
  });
  const before = await service.getState();
  const error = await rejectsCode(
    service.squashLines(selection(before)),
    "HISTORY_CHANGED",
  );
  assert.equal(edited, true);
  assert.match(error.message, /squash completed/i);
  assert.doesNotMatch(error.message, /nothing was squashed/i);
  assert.equal((await service.getState()).canUndo, false);
});

test("a post-attribution diff read failure is not an ambiguous history write", async () => {
  const { root } = await fixture();
  let squashed = false;
  let failed = false;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") squashed = true;
      return result;
    },
    jjRunner: async (cwd, args) => {
      if (squashed && !failed && args[0] === "diff") {
        failed = true;
        throw new Error("simulated post-success read failure");
      }
      return jj(cwd, args);
    },
  });
  const error = await rejectsCode(
    service.squashLines(selection(await service.getState())),
    "HISTORY_CHANGED",
  );
  assert.match(error.message, /squash completed/i);
  assert.equal(error.details?.cause, "simulated post-success read failure");
  const after = await service.getState();
  assert.equal(after.canUndo, false);
  await service.preview({
    ...selection(after),
    target: after.parent!.changeId,
  });
});

test("a snapshot before squash attribution remains ambiguous, with actionable pending diagnostics", async () => {
  const { root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") {
        squashCalls++;
        await appendFile(
          path.join(root, "src/preferences.ts"),
          "\n// snapshot before attribution\n",
        );
        await jj(root, ["status"]);
      }
      return result;
    },
  });
  const before = await service.getState();
  const first = await rejectsCode(
    service.squashLines(selection(before)),
    "HISTORY_CHANGED",
  );
  const pending = first.details?.pending as Record<string, unknown>;
  assert.ok(pending);
  assert.equal(pending.beforeOperation, before.operation);
  assert.equal(pending.sourceCommit, before.source.commitId);
  assert.equal(pending.sourceChangeId, before.source.changeId);
  assert.equal(pending.targetCommit, before.parent!.commitId);
  assert.equal(pending.targetChangeId, before.parent!.changeId);
  assert.equal(pending.kind, "squash");
  const after = await service.getState();
  await service.getLog({ includeOutput: false });
  const error = await rejectsCode(
    service.squashLines(selection(after)),
    "RECOVERY_REQUIRED",
  );
  assert.deepEqual(error.details?.pending, pending);
  for (const value of [
    before.operation,
    before.source.commitId,
    before.source.changeId,
    before.parent!.commitId,
  ])
    assert.ok(error.message.includes(value), `diagnostic contains ${value}`);
  assert.match(error.message, /reconcile history before restarting/i);
  assert.equal(after.canUndo, false);
  assert.equal(squashCalls, 1);
  const restarted = new ReviewService({ repoPath: root });
  const fresh = await restarted.getState();
  assert.equal(fresh.operation, after.operation);
  assert.equal(fresh.canUndo, false);
  await restarted.preview({
    ...selection(fresh),
    target: fresh.parent!.changeId,
  });
});

test("nonzero exit after a real squash retains its guard even when the head is attributable", async () => {
  const { root } = await fixture();
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash")
        throw new ProcessError(command, args, result, 23);
      return result;
    },
  });
  const error = await rejectsCode(
    service.squashLines(selection(await service.getState())),
    "PARTIAL_FAILURE",
  );
  assert.ok(error.details?.pending);
  const state = await service.getState();
  await rejectsCode(service.squashLines(selection(state)), "RECOVERY_REQUIRED");
});

test("an unreadable operation head after tool success keeps its in-memory guard", async () => {
  const { root } = await fixture();
  let awaitingAttribution = false;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") awaitingAttribution = true;
      return result;
    },
    jjRunner: async (cwd, args) => {
      if (awaitingAttribution && args[0] === "op" && args[1] === "log") {
        awaitingAttribution = false;
        throw new Error("simulated attribution read failure");
      }
      return jj(cwd, args);
    },
  });
  const error = await rejectsCode(
    service.squashLines(selection(await service.getState())),
    "HISTORY_CHANGED",
  );
  assert.match(
    String(error.details?.cause),
    /simulated attribution read failure/,
  );
  const pending = error.details?.pending;
  assert.ok(pending);
  const blocked = await rejectsCode(
    service.squashLines(selection(await service.getState())),
    "RECOVERY_REQUIRED",
  );
  assert.deepEqual(blocked.details?.pending, pending);
});

test("undo exists only in its owning process and restart never changes jj history", async () => {
  const { dataDir, root } = await fixture();
  const entries = await readdir(dataDir);
  const service = new ReviewService({ repoPath: root });
  const before = await service.getState();
  const result = await service.squashLines(selection(before));
  assert.equal(result.state.canUndo, true);
  const restarted = new ReviewService({ repoPath: root });
  const fresh = await restarted.getState();
  assert.equal(fresh.canUndo, false);
  assert.equal(fresh.operation, result.state.operation);
  assert.equal(fresh.source.commitId, result.state.source.commitId);
  await rejectsCode(restarted.undo(fresh.version), "UNDO_UNAVAILABLE");
  assert.equal((await service.getState()).canUndo, true);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.files, before.files);
  assert.equal(undone.state.canUndo, false);
  assert.deepEqual(
    await readdir(dataDir),
    entries,
    "no app state directory or journal is created beside the repository",
  );
});

test("corrupt legacy journal files are ignored and left untouched during reads, squash, undo, and restart", async (t) => {
  const { dataDir, root } = await fixture();
  const oldStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = path.join(dataDir, "legacy-state");
  t.after(() => {
    if (oldStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldStateHome;
  });
  const legacyDirectory = path.join(process.env.XDG_STATE_HOME, "jj-stamp");
  await mkdir(legacyDirectory, { recursive: true });
  const journalPath = path.join(
    legacyDirectory,
    `operations-${createHash("sha256").update(root).digest("hex").slice(0, 20)}.json`,
  );
  const contents =
    "not valid JSON; an old application file is not ours to read, overwrite or delete";
  await writeFile(journalPath, contents);
  const service = new ReviewService({ repoPath: root });
  const before = await service.getState();
  const squashed = await service.squashLines(selection(before));
  await service.undo(squashed.state.version);
  const fresh = await new ReviewService({ repoPath: root }).getState();
  assert.equal(fresh.canUndo, false);
  assert.equal(await readFile(journalPath, "utf8"), contents);
  assert.deepEqual(await readdir(legacyDirectory), [
    path.basename(journalPath),
  ]);
});

for (const failure of ["read failure", "snapshot"] as const) {
  test(`post-success conflict warning ${failure} cannot publish stale undo or misreport a failed squash`, async () => {
    const { root } = await fixture();
    let squashed = false;
    let injected = false;
    let squashCalls = 0;
    const service = new ReviewService({
      repoPath: root,
      toolRunner: async (command, args, cwd) => {
        const result = await run(command, args, cwd);
        if (args[0] === "squash") {
          squashed = true;
          squashCalls++;
        }
        return result;
      },
      jjRunner: async (cwd, args) => {
        if (
          squashed &&
          !injected &&
          args[0] === "log" &&
          args.includes("conflicts()")
        ) {
          injected = true;
          if (failure === "read failure")
            throw new ProcessError(
              "jj",
              args,
              { stdout: "", stderr: "Conflict query unavailable" },
              1,
            );
          await appendFile(
            path.join(root, "src/preferences.ts"),
            "\n// edit during conflict warning\n",
          );
          await jj(root, ["status"]);
        }
        return jj(cwd, args);
      },
    });
    const before = await service.getState();
    const error = await rejectsCode(
      service.squashLines(selection(before)),
      "HISTORY_CHANGED",
    );
    assert.equal(injected, true);
    assert.match(error.message, /squash completed/i);
    assert.doesNotMatch(error.message, /nothing was squashed/i);
    const after = await service.getState();
    assert.equal(after.canUndo, false);
    await rejectsCode(service.undo(after.version), "UNDO_UNAVAILABLE");
    await service.preview({
      ...selection(after),
      target: after.parent!.changeId,
    });
    assert.equal(squashCalls, 1);
  });
}
