import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ApiError, ReviewService, type State } from "../server/service.ts";
import { jj, run } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-validation-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = await createDemo(directory);
  const before = await new ReviewService({ repoPath: root }).getState();
  return { root, before };
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

const conflicts = (args: string[]) =>
  args[0] === "log" && args.includes("conflicts()");
const metadata = (args: string[]) =>
  args[0] === "log" && args.some((arg) => arg.includes("self.contained_in"));

// Cover distinct windows without multiplying every boundary by every race.
const races = [
  { api: "direct", boundary: "files", change: "edit" },
  { api: "direct", boundary: "file bytes", change: "config" },
  { api: "legacy", boundary: "file bytes", change: "history" },
  { api: "direct", boundary: "baseline", change: "edit" },
  { api: "legacy", boundary: "baseline", change: "config" },
  { api: "direct", boundary: "final metadata", change: "history" },
  { api: "direct", boundary: "file bytes", change: "conflict eligibility" },
  { api: "legacy", boundary: "baseline", change: "conflict eligibility" },
] as const;

for (const scenario of races) {
  test(`${scenario.api} squash rejects ${scenario.change} during ${scenario.boundary} before installing pending`, async (t) => {
    const { root, before } = await fixture(t);
    let armed = false;
    let injected = false;
    let baselineRead = false;
    let squashCalls = 0;
    const calls: string[] = [];
    async function inject(boundary: string) {
      if (!armed || injected || boundary !== scenario.boundary) return;
      injected = true;
      if (scenario.change === "edit") {
        await appendFile(
          path.join(root, "src/preferences.ts"),
          "\n// concurrent edit during validation\n",
        );
      } else if (scenario.change === "history") {
        await jj(root, [
          "bookmark",
          "set",
          "validation-race",
          "-r",
          before.source.commitId,
        ]);
      } else {
        await jj(root, [
          "config",
          "set",
          "--repo",
          scenario.change === "conflict eligibility"
            ? 'revset-aliases."conflicts()"'
            : 'revset-aliases."immutable_heads()"',
          scenario.change === "conflict eligibility"
            ? `change_id("${before.source.changeId}")`
            : before.parent!.commitId,
        ]);
      }
    }
    const service = new ReviewService({
      repoPath: root,
      jjRunner: async (cwd, args) => {
        if (armed)
          calls.push(
            conflicts(args)
              ? "baseline"
              : metadata(args)
                ? "metadata"
                : args[0],
          );
        const result = await jj(cwd, args);
        if (conflicts(args)) {
          assert.ok(args.includes("--ignore-working-copy"));
          if (armed) baselineRead = true;
          await inject("baseline");
        } else if (metadata(args) && baselineRead) {
          // Return the old metadata result after recording a new operation.
          // Only the subsequent, sequential operation read can detect this.
          await inject("final metadata");
        } else if (args[0] === "file" && args[1] === "show") {
          assert.ok(args.includes("--ignore-working-copy"));
          await inject("file bytes");
        } else if (args[0] === "diff") {
          assert.ok(args.includes("--ignore-working-copy"));
          await inject("files");
        }
        return result;
      },
      toolRunner: async (command, args, cwd) => {
        if (armed) calls.push(args[0]);
        if (args[0] === "squash") squashCalls++;
        const result = await run(command, args, cwd);
        return result;
      },
    });
    const token =
      scenario.api === "legacy"
        ? (
            await service.preview({
              ...selection(before),
              target: before.parent!.changeId,
            })
          ).token
        : undefined;
    armed = true;
    const error = await rejectsCode(
      token ? service.squash(token) : service.squashLines(selection(before)),
      "STALE_STATE",
    );
    armed = false;
    assert.equal(injected, true, "the intended interleaving actually ran");
    assert.equal(squashCalls, 0);
    assert.equal(error.details?.pending, undefined);
    assert.deepEqual(calls.slice(-3), ["baseline", "metadata", "op"]);
    if (token) await rejectsCode(service.squash(token), "STALE_PREVIEW");
    if (
      scenario.change === "config" ||
      scenario.change === "conflict eligibility"
    ) {
      // Prove this was an eligibility-only race, not an operation-head race.
      const readOnly = await service.getState();
      assert.equal(readOnly.operation, before.operation);
      assert.equal(readOnly.parent, null);
      if (scenario.change === "conflict eligibility")
        assert.match(readOnly.squashUnavailable!, /contains conflicts/);
      await jj(root, [
        "config",
        "set",
        "--repo",
        scenario.change === "conflict eligibility"
          ? 'revset-aliases."conflicts()"'
          : 'revset-aliases."immutable_heads()"',
        scenario.change === "conflict eligibility" ? "none()" : "root()",
      ]);
    }
    const refreshed = await service.getState();
    assert.equal(
      refreshed.parent!.commitId,
      before.parent!.commitId,
      "no destination rewrite occurred",
    );
    if (scenario.change === "history") {
      assert.notEqual(refreshed.operation, before.operation);
      assert.equal(refreshed.source.commitId, before.source.commitId);
    }
    // A fresh explicit preview succeeds: stale preparation left no pending guard.
    await service.preview({
      ...selection(refreshed),
      target: refreshed.parent!.changeId,
    });
    assert.equal(
      squashCalls,
      0,
      "refresh and preview never replay a rejected mutation",
    );
  });
}

test("legacy preview does not publish its cold capture after a configuration race in pinned files", async (t) => {
  const { root, before } = await fixture(t);
  let injected = false;
  let squashCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (args[0] === "diff" && !injected) {
        injected = true;
        await jj(root, [
          "config",
          "set",
          "--repo",
          'revset-aliases."immutable_heads()"',
          before.parent!.commitId,
        ]);
      }
      return result;
    },
    toolRunner: (command, args, cwd) => {
      if (args[0] === "squash") squashCalls++;
      return run(command, args, cwd);
    },
  });
  await rejectsCode(
    service.preview({ ...selection(before), target: before.parent!.changeId }),
    "STALE_STATE",
  );
  assert.equal(injected, true);
  assert.equal((await service.getState()).operation, before.operation);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  const refreshed = await service.getState();
  const preview = await service.preview({
    ...selection(refreshed),
    target: refreshed.parent!.changeId,
  });
  assert.ok(preview.token);
  assert.equal(squashCalls, 0);
});

for (const phase of ["before", "after"] as const) {
  test(`malformed global conflict IDs fail closed ${phase} squash with the correct guard state`, async (t) => {
    const { root, before } = await fixture(t);
    let corrupted = false;
    let squashCalls = 0;
    const service = new ReviewService({
      repoPath: root,
      jjRunner: async (cwd, args) => {
        const result = await jj(cwd, args);
        if (conflicts(args)) {
          assert.ok(args.includes("--ignore-working-copy"));
          if (
            !corrupted &&
            (phase === "before" ? squashCalls === 0 : squashCalls === 1)
          ) {
            corrupted = true;
            return { ...result, stdout: "not-a-change-id\n" };
          }
        }
        return result;
      },
      toolRunner: async (command, args, cwd) => {
        if (args[0] === "squash") squashCalls++;
        return run(command, args, cwd);
      },
    });
    if (phase === "before") {
      await assert.rejects(
        service.squashLines(selection(before)),
        /Unrecognized conflict change identity/,
      );
      assert.equal(squashCalls, 0);
    } else {
      const error = await rejectsCode(
        service.squashLines(selection(before)),
        "HISTORY_CHANGED",
      );
      assert.match(error.message, /squash completed and was attributed/i);
      assert.doesNotMatch(error.message, /nothing was squashed/i);
      assert.ok(error.details?.completedOperation);
      assert.equal(error.details?.pending, undefined);
      assert.equal(squashCalls, 1);
    }
    assert.equal(corrupted, true);
    const refreshed = await service.getState();
    assert.equal(refreshed.canUndo, false);
    if (phase === "before") assert.equal(refreshed.operation, before.operation);
    else assert.notEqual(refreshed.operation, before.operation);
    await rejectsCode(service.undo(refreshed.version), "UNDO_UNAVAILABLE");
    // This would be RECOVERY_REQUIRED if a false pending guard remained.
    await service.preview({
      ...selection(refreshed),
      target: refreshed.parent!.changeId,
    });
    assert.equal(squashCalls, phase === "before" ? 0 : 1);
  });
}
