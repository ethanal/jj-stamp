import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  appendFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { ReviewService, ApiError, reviewLogRevset } from "../server/service.ts";
import type { ReviewHunk, State, Selection } from "../server/service.ts";
import { jj, run, ProcessError, formatCommand } from "../server/process.ts";
import { createApi } from "../server/api.ts";
import { parseFile } from "../server/diff.ts";
import { materializeSelection } from "../server/selection.ts";
import { createDemo } from "./fixtures.ts";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fold-backend-"));
  const root = await createDemo(dataDir);
  const service = new ReviewService({ repoPath: root });
  const state = await service.getState();
  return { service, state, dataDir, root: state.repo.path };
}
const changes = (hunk: ReviewHunk) =>
  hunk.rows.filter((row) => /^[+-]/.test(row.raw)).map((row) => row.index);
const input = (
  state: State,
  selections: Selection[],
  target = state.targets[0].changeId,
) => ({ version: state.version, target, selections });
function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}
const fileAt = async (root: string, revision: string, file: string) =>
  (await jj(root, ["file", "show", "-r", revision, file])).stdout;

test("explicit fixture uses real jj repository with three files, six hunks, and two mutable targets", async () => {
  const { service, state, root } = await fixture();
  assert.equal(state.repo.name, path.basename(state.repo.path));
  assert.equal("demo" in state.repo, false);
  assert.equal(state.source.description, "Polish notification delivery");
  assert.deepEqual(
    state.targets.map((t) => t.description),
    ["Add notification preferences", "Build notification delivery service"],
  );
  assert.deepEqual(
    state.files.map((f) => f.path),
    [
      "src/notifications.ts",
      "src/preferences.ts",
      "tests/notifications.test.ts",
    ],
  );
  assert.equal(state.files.flatMap((f) => f.hunks).length, 6);
  assert.ok(state.files.every((f) => !f.unsupported));
  assert.equal(state.canUndo, false);
  assert.deepEqual(await service.getState(), state);
  assert.deepEqual(
    await new ReviewService({ repoPath: root }).getState(),
    state,
  );
});

test("full hunk squash rewrites pinned parent, retains other changes, and exact undo is process-local", async () => {
  const { service, state, root } = await fixture();
  const hunk = state.files[0].hunks[0];
  const worktree = await readFile(path.join(root, state.files[0].path), "utf8");
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  assert.deepEqual(preview.specs, [hunk.id]);
  assert.equal(preview.selectedLines, 2);
  assert.ok(
    preview.command.includes(
      `--from ${state.source.commitId} --into ${state.targets[0].commitId}`,
    ),
  );
  assert.ok(
    preview.command.includes("--use-destination-message --keep-emptied"),
  );
  assert.equal(
    (await service.getState()).operation,
    state.operation,
    "preview does not mutate history",
  );
  const result = await service.squash(preview.token);
  assert.equal(result.state.canUndo, true);
  assert.equal(result.state.source.changeId, state.source.changeId);
  assert.notEqual(result.state.source.commitId, state.source.commitId);
  assert.equal(result.state.files.flatMap((f) => f.hunks).length, 5);
  assert.ok(
    (await fileAt(root, "@-", state.files[0].path)).includes(
      "return `[orbit] ${notification.subject.trim()}`;",
    ),
  );
  assert.ok(
    !(await fileAt(root, "@-", state.files[0].path)).includes(
      "RETRY_DELAY_MS * attempt",
    ),
  );
  assert.equal(
    await readFile(path.join(root, state.files[0].path), "utf8"),
    worktree,
  );
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  const restarted = new ReviewService({ repoPath: root });
  const reopened = await restarted.getState();
  assert.equal(reopened.canUndo, false);
  assert.equal(reopened.operation, result.state.operation);
  assert.deepEqual(reopened.files, result.state.files);
  await rejectsCode(restarted.undo(reopened.version), "UNDO_UNAVAILABLE");
  assert.equal((await restarted.getState()).operation, result.state.operation);
  const undone = await service.undo(result.state.version);
  assert.equal(undone.state.canUndo, false);
  assert.equal(undone.state.source.commitId, state.source.commitId);
  assert.deepEqual(undone.state.files, state.files);
  assert.deepEqual(undone.state.targets, state.targets);
  const op = (
    await jj(root, [
      "op",
      "log",
      "--no-graph",
      "-n",
      "1",
      "-T",
      "self.description()",
    ])
  ).stdout;
  assert.match(op, /revert operation/);
  await rejectsCode(service.undo(undone.state.version), "UNDO_UNAVAILABLE");
});

test("partial selection moves exactly one added row, not its neighboring addition", async () => {
  const { service, state, root } = await fixture();
  const file = state.files[2],
    hunk = file.hunks[1];
  const added = hunk.rows.filter((r) => r.raw.startsWith("+"));
  assert.equal(added.length, 2);
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: [added[0].index] }]),
  );
  assert.deepEqual(preview.specs, [`${hunk.id}:${added[0].index}`]);
  assert.equal(preview.selectedLines, 1);
  const patchChanges = preview.patch
    .split("\n")
    .filter((line) => /^[+-]/.test(line) && !/^(---|\+\+\+) /.test(line));
  assert.deepEqual(patchChanges, [added[0].raw]);
  const result = await service.squash(preview.token);
  const parent = await fileAt(root, "@-", file.path);
  assert.ok(parent.includes(added[0].raw.slice(1)));
  assert.ok(!parent.includes(added[1].raw.slice(1)));
  const remaining = result.state.files
    .find((f) => f.path === file.path)!
    .hunks.flatMap((h) => h.rows)
    .filter((r) => r.raw.startsWith("+"))
    .map((r) => r.raw);
  assert.ok(!remaining.includes(added[0].raw));
  assert.ok(remaining.includes(added[1].raw));
  assert.equal(result.state.canUndo, true);
});

test("partial deletion stays exact rather than widening to the replacement", async () => {
  const { service, state, root } = await fixture();
  const file = state.files[0],
    hunk = file.hunks[0];
  const removed = hunk.rows.find((row) => row.raw.startsWith("-"))!;
  const added = hunk.rows.find((row) => row.raw.startsWith("+"))!;
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: [removed.index] }]),
  );
  const result = await service.squash(preview.token);
  const parent = await fileAt(root, "@-", file.path);
  assert.ok(!parent.includes(removed.raw.slice(1)));
  assert.ok(!parent.includes(added.raw.slice(1)));
  assert.ok(
    result.state.files[0].hunks
      .flatMap((h) => h.rows)
      .some((r) => r.raw === added.raw),
  );
});

test("multi-file hunks can squash into grandparent while retaining other source hunks", async () => {
  const { service, state, root } = await fixture();
  const selected = [state.files[0].hunks[1], state.files[1].hunks[1]];
  const preview = await service.preview(
    input(
      state,
      selected.map((h) => ({ id: h.id, lines: changes(h) })),
      state.targets[1].changeId,
    ),
  );
  const result = await service.squash(preview.token);
  assert.equal(result.state.files.flatMap((f) => f.hunks).length, 4);
  assert.ok(
    (await fileAt(root, "@--", state.files[0].path)).includes(
      "RETRY_DELAY_MS * attempt",
    ),
  );
  assert.ok(
    (await fileAt(root, "@--", state.files[1].path)).includes(
      "All notifications paused",
    ),
  );
  assert.equal(result.state.canUndo, true);
});

test("stale state and preview reject workspace edits without mutating history or retrying", async () => {
  const { service, state, root } = await fixture();
  const hunk = state.files[0].hunks[0];
  const selection = [{ id: hunk.id, lines: changes(hunk) }];
  const preview = await service.preview(input(state, selection));
  await appendFile(
    path.join(root, "src/notifications.ts"),
    "\n// An external edit.\n",
  );
  await rejectsCode(service.squash(preview.token), "STALE_STATE");
  const edited = await service.getState();
  await rejectsCode(service.preview(input(state, selection)), "STALE_STATE");
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  assert.equal((await service.getState()).operation, edited.operation);
  assert.equal(edited.targets[0].commitId, state.targets[0].commitId);
  assert.equal(edited.canUndo, false);
});

test("external history operation invalidates preview and undo even without changed file bytes", async () => {
  const { service, state, root } = await fixture();
  const hunk = state.files[0].hunks[0];
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  const result = await service.squash(preview.token);
  await jj(root, ["describe", "-m", "External description change"]);
  await rejectsCode(service.undo(result.state.version), "STALE_STATE");
  const current = await service.getState();
  assert.equal(current.canUndo, false);
  await rejectsCode(service.undo(current.version), "UNDO_UNAVAILABLE");
  assert.equal((await service.getState()).operation, current.operation);
});

test("invalid context, indices, duplicate hunks, unknown IDs and target injection never mutate", async () => {
  const { service, state } = await fixture();
  const hunk = state.files[0].hunks[0];
  const context = hunk.rows.find((r) => r.raw.startsWith(" "))!.index;
  for (const lines of [
    [],
    [0],
    [-1],
    [1.5],
    [9999],
    [context],
    [changes(hunk)[0], changes(hunk)[0]],
  ]) {
    await rejectsCode(
      service.preview(input(state, [{ id: hunk.id, lines }])),
      "INVALID_SELECTION",
    );
  }
  await rejectsCode(
    service.preview(input(state, [{ id: "deadbee", lines: [1] }])),
    "INVALID_SELECTION",
  );
  const selection = { id: hunk.id, lines: changes(hunk) };
  await rejectsCode(
    service.preview(input(state, [selection, selection])),
    "INVALID_SELECTION",
  );
  for (const target of [
    "root()",
    "@",
    state.source.changeId,
    "; touch /tmp/never-execute",
    "all()",
  ]) {
    await rejectsCode(
      service.preview(input(state, [selection], target)),
      "INVALID_TARGET",
    );
  }
  assert.equal((await service.getState()).operation, state.operation);
});

test("serialized duplicate squash requests execute once only", async () => {
  const { service, state } = await fixture();
  const hunk = state.files[0].hunks[0];
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  const responses = await Promise.allSettled([
    service.squash(preview.token),
    service.squash(preview.token),
    service.getState(),
  ]);
  assert.equal(responses[0].status, "fulfilled");
  assert.equal(responses[1].status, "rejected");
  if (responses[1].status === "rejected")
    assert.equal(responses[1].reason.code, "STALE_PREVIEW");
  const after = await service.getState();
  assert.equal(after.files.flatMap((f) => f.hunks).length, 5);
  assert.equal(after.canUndo, true);
});

test("unsupported newline, mode, binary and rename structures fail closed", async () => {
  const { service, state, root } = await fixture();
  await writeFile(path.join(root, "src/notifications.ts"), "no newline");
  const next = await service.getState();
  const unsupported = next.files.find(
    (f) => f.path === "src/notifications.ts",
  )!;
  assert.match(unsupported.unsupported!, /newline/);
  assert.deepEqual(unsupported.hunks, []);
  const goodPatch = state.files[0].patch;
  for (const extra of [
    "old mode 100644\nnew mode 100755\n",
    "Binary files a/x and b/x differ\n",
    "rename from x\nrename to y\n",
  ]) {
    assert.throws(() => parseFile(extra + goodPatch, state.files[0].path));
  }
});

test("native materialization selects exact rows and rejects changed paths, widened patches and shifted positions", () => {
  const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,4 @@\n a\n+b\n+c\n z\n";
  const base = Buffer.from("a\nz\n");
  const source = Buffer.from("a\nb\nc\nz\n");
  const selection = {
    path: "x.ts",
    patch,
    selections: [{ hunk: 0, lines: [2] }],
  };
  const exact =
    "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n a\n+b\n z\n";
  const materialized = materializeSelection(selection, base, source);
  assert.equal(materialized.preview, exact);
  assert.deepEqual(materialized.result, Buffer.from("a\nb\nz\n"));
  for (const unsafe of [
    patch.replaceAll("x.ts", "other.ts"),
    patch.replace("+1,4", "+1,5").replace("+c\n", "+c\n+unselected extra\n"),
    patch.replace("-1,2", "-2,2"),
  ]) {
    assert.throws(() =>
      materializeSelection({ ...selection, patch: unsafe }, base, source),
    );
  }
});

test("legacy pending journal is ignored and never rewritten or supplemented", async () => {
  const { state, dataDir, root } = await fixture();
  const { createHash } = await import("node:crypto");
  const name = `operations-${createHash("sha256").update(state.repo.path).digest("hex").slice(0, 20)}.json`;
  const legacy = JSON.stringify({
    pending: {
      beforeOperation: state.operation,
      sourceCommit: state.source.commitId,
      kind: "squash",
    },
  });
  await writeFile(path.join(dataDir, name), legacy);
  const entries = (await readdir(dataDir)).sort();
  const restarted = new ReviewService({ repoPath: root });
  const current = await restarted.getState();
  assert.deepEqual(current, state);
  const hunk = current.files[0].hunks[0];
  const preview = await restarted.preview(
    input(current, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  assert.equal((await restarted.getState()).operation, current.operation);
  const result = await restarted.squash(preview.token);
  assert.equal(result.state.canUndo, true);
  await restarted.undo(result.state.version);
  assert.equal(await readFile(path.join(dataDir, name), "utf8"), legacy);
  assert.deepEqual((await readdir(dataDir)).sort(), entries);
});

test("review, preview, squash, undo and restart create no application state files", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fold-no-state-"));
  const root = await createDemo(dataDir);
  // Native jj metadata changes are expected; application files anywhere outside
  // that metadata, and new top-level metadata directories, are not.
  const files = async () =>
    (await readdir(dataDir, { recursive: true }))
      .filter((entry) => !entry.split(path.sep).includes(".jj"))
      .sort();
  const before = await files();
  const metadata = (await readdir(path.join(root, ".jj"))).sort();
  const assertNoState = async () => {
    assert.deepEqual(await files(), before);
    assert.deepEqual((await readdir(path.join(root, ".jj"))).sort(), metadata);
  };
  const service = new ReviewService({ repoPath: root });
  const state = await service.getState();
  await service.getLog();
  await service.getFile({ version: state.version, path: state.files[0].path });
  await assertNoState();
  const hunk = state.files[0].hunks[0];
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  await assertNoState();
  const squashed = await service.squash(preview.token);
  assert.equal(squashed.state.canUndo, true);
  await assertNoState();
  const restarted = new ReviewService({ repoPath: root });
  const reopened = await restarted.getState();
  assert.equal(reopened.canUndo, false);
  assert.equal(reopened.operation, squashed.state.operation);
  await rejectsCode(restarted.squash(preview.token), "STALE_PREVIEW");
  await rejectsCode(restarted.undo(reopened.version), "UNDO_UNAVAILABLE");
  await assertNoState();
  const undone = await service.undo(squashed.state.version);
  assert.deepEqual(undone.state.files, state.files);
  await assertNoState();
});

test("Express API JSON contracts and malformed body validation", async (t) => {
  const { service } = await fixture();
  const app = express();
  app.use("/api", createApi(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const get = await fetch(`${base}/state`);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("cache-control"), "no-store");
  const state = (await get.json()) as State;
  const post = (route: string, body: unknown) =>
    fetch(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const [route, body] of [
    ["preview", {}],
    ["squash", { token: "--help" }],
    ["undo", {}],
  ] as const) {
    const response = await post(route, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  const hunk = state.files[0].hunks[0];
  const response = await post(
    "preview",
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.selectedLines, 2);
  const squash = await post("squash", { token: preview.token });
  assert.equal(squash.status, 200);
  const result = await squash.json();
  assert.equal(result.state.canUndo, true);
  assert.equal(typeof result.output, "string");
  const replay = await post("squash", { token: preview.token });
  assert.equal(replay.status, 409);
  const undo = await post("undo", { version: result.state.version });
  assert.equal(undo.status, 200);
  const undone = await undo.json();
  assert.equal(undone.state.canUndo, false);
  const reset = await post("reset", { version: undone.state.version });
  assert.equal(reset.status, 404);
  assert.equal((await service.getState()).repo.path, state.repo.path);
});

test("nonzero tool exit after real squash blocks this service, while restart only forgets recovery state", async () => {
  const { dataDir, state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") {
        squashCalls++;
        throw new ProcessError(
          command,
          args,
          {
            stdout: result.stdout,
            stderr: result.stderr + "\nSimulated post-write failure",
          },
          23,
        );
      }
      return result;
    },
  });
  const hunk = state.files[0].hunks[0];
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  await assert.rejects(service.squash(preview.token), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, "PARTIAL_FAILURE");
    assert.ok(
      String(error.details?.output).startsWith(
        `Working directory: ${root}\nFailed command:\njj squash --from ${state.source.commitId} --into ${state.parent!.commitId} --tool jj-stamp --use-destination-message --keep-emptied`,
      ),
    );
    assert.match(String(error.details?.output), /Simulated post-write failure/);
    assert.match(error.message, /history may have changed/);
    return true;
  });
  assert.equal(squashCalls, 1);
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  assert.equal(squashCalls, 1);
  const after = await service.getState();
  assert.notEqual(after.operation, state.operation);
  assert.equal(after.canUndo, false);
  assert.equal(after.files.flatMap((f) => f.hunks).length, 5);
  const nextHunk = after.files[0].hunks[0];
  await rejectsCode(
    service.preview(
      input(after, [{ id: nextHunk.id, lines: changes(nextHunk) }]),
    ),
    "RECOVERY_REQUIRED",
  );
  assert.equal((await service.getState()).operation, after.operation);
  const restarted = new ReviewService({ repoPath: root });
  assert.deepEqual(await restarted.getState(), after);
  await restarted.preview(
    input(after, [{ id: nextHunk.id, lines: changes(nextHunk) }]),
  );
  await rejectsCode(restarted.undo(after.version), "UNDO_UNAVAILABLE");
  assert.equal((await restarted.getState()).operation, after.operation);
  assert.equal(squashCalls, 1);
  assert.deepEqual(await readdir(dataDir), [path.basename(root)]);
});

test("tool failure without mutation consumes token but allows a newly reviewed plan", async () => {
  const { state, root } = await fixture();
  let fail = true;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "squash" && fail) {
        fail = false;
        throw new ProcessError(
          command,
          args,
          { stdout: "", stderr: "Simulated failure before rewrite" },
          23,
        );
      }
      return run(command, args, cwd);
    },
  });
  const hunk = state.files[0].hunks[0];
  const selection = [{ id: hunk.id, lines: changes(hunk) }];
  const first = await service.preview(input(state, selection));
  await rejectsCode(service.squash(first.token), "TOOL_FAILED");
  await rejectsCode(service.squash(first.token), "STALE_PREVIEW");
  assert.equal((await service.getState()).operation, state.operation);
  const second = await service.preview(input(state, selection));
  assert.equal((await service.squash(second.token)).state.canUndo, true);
});

test("an intervening external operation during real squash disables attribution and undo", async () => {
  const { state, root } = await fixture();
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "squash")
        await jj(cwd, ["bookmark", "create", "external-work", "-r", "@-"]);
      return run(command, args, cwd);
    },
  });
  const hunk = state.files[0].hunks[0];
  const preview = await service.preview(
    input(state, [{ id: hunk.id, lines: changes(hunk) }]),
  );
  await rejectsCode(service.squash(preview.token), "HISTORY_CHANGED");
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  const after = await new ReviewService({ repoPath: root }).getState();
  assert.equal(after.canUndo, false);
  assert.notEqual(after.operation, state.operation);
});

test("unrelated conflicts allow review, squash, and undo; immutable ancestors are never targets", async () => {
  const { service, state, root } = await fixture();
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    state.targets[1].changeId,
  ]);
  const restricted = await service.getState();
  assert.deepEqual(
    restricted.targets.map((t) => t.changeId),
    [state.targets[0].changeId],
  );
  const hunk = restricted.files[0].hunks[0];
  await rejectsCode(
    service.preview(
      input(
        restricted,
        [{ id: hunk.id, lines: changes(hunk) }],
        state.targets[1].changeId,
      ),
    ),
    "INVALID_TARGET",
  );
  const base = restricted.source.commitId;
  await jj(root, ["new", base, "-m", "Left conflict branch"]);
  await writeFile(path.join(root, "src/notifications.ts"), "left version\n");
  await jj(root, ["status"]);
  const left = (
    await jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
  ).stdout.trim();
  await jj(root, ["new", base, "-m", "Right conflict branch"]);
  await writeFile(path.join(root, "src/notifications.ts"), "right version\n");
  await jj(root, ["status"]);
  await jj(root, ["new", left, "@", "-m", "Conflicted merge"]);
  const conflicted = (
    await jj(root, ["log", "-r", "@", "--no-graph", "-T", "change_id"])
  ).stdout.trim();
  await rejectsCode(
    new ReviewService({ repoPath: root }).getState(),
    "CONFLICTED_SOURCE",
  );
  const clean = await service.getState();
  assert.deepEqual(clean.files, restricted.files);
  assert.ok((await service.getLog()).rows.length);
  await rejectsCode(
    service.selectRevision({ version: clean.version, changeId: conflicted }),
    "CONFLICTED_SOURCE",
  );
  assert.equal(
    (await service.getState()).source.changeId,
    clean.source.changeId,
  );
  await rejectsCode(
    service.preview(input(restricted, [{ id: hunk.id, lines: changes(hunk) }])),
    "STALE_STATE",
  );
  // Return to an already cached, clean source while its conflicted descendants
  // remain visible. Both mutation paths and undo must continue to work.
  await jj(root, ["edit", base]);
  const before = await service.getState();
  const selections = [{ id: hunk.id, lines: changes(hunk) }];
  const preview = await service.preview(input(before, selections));
  const result = await service.squash(preview.token);
  assert.equal(result.warning, undefined);
  assert.equal(result.state.canUndo, true);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.files, before.files);
  // Exercise the direct API on another hunk, rather than asking jj to recreate
  // an identical Git commit immediately after undo (same-second timestamps).
  const otherHunk = undone.state.files[1].hunks[0];
  const direct = await service.squashLines({
    version: undone.state.version,
    selections: [{ id: otherHunk.id, lines: changes(otherHunk) }],
  });
  assert.equal(direct.warning, undefined);
  assert.equal(direct.state.canUndo, true);
  await service.undo(direct.state.version);
});

test("new descendant conflicts still warn and allow exact undo", async () => {
  const { service, state, root } = await fixture();
  const file = state.files[0];
  const hunk = file.hunks[0];
  const removed = hunk.rows.find((row) => row.raw.startsWith("-"))!;
  await jj(root, ["new", state.parent!.commitId, "-m", "Sibling edit"]);
  const contents = await readFile(path.join(root, file.path), "utf8");
  await writeFile(
    path.join(root, file.path),
    contents.replace(removed.raw.slice(1), "// incompatible sibling edit"),
  );
  await jj(root, ["status"]);
  const before = await service.getState();
  const result = await service.squashLines({
    version: before.version,
    selections: [{ id: hunk.id, lines: changes(hunk) }],
  });
  assert.match(result.warning!, /created a conflict/);
  assert.equal((await service.getState()).canUndo, true);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.files, before.files);
  assert.equal(
    (
      await jj(root, [
        "log",
        "-r",
        "conflicts()",
        "--no-graph",
        "-T",
        "change_id",
      ])
    ).stdout,
    "",
  );
});

for (const style of ["diff", "snapshot", "git"] as const) {
  test(`conflicted parents accept incremental resolution squashes and undo (${style} markers)`, async () => {
    const { root, state } = await fixture();
    await jj(root, [
      "config",
      "set",
      "--repo",
      "ui.conflict-marker-style",
      style,
    ]);
    const gap = Array.from({ length: 12 }, (_, i) => `context ${i}\n`).join("");
    const contents = (side: string) => `${side} first\n${gap}${side} second\n`;
    await jj(root, ["new", state.source.commitId, "-m", "Conflict base"]);
    await writeFile(path.join(root, "conflict.txt"), contents("base"));
    await writeFile(path.join(root, "other.txt"), "base other\n");
    const base = (
      await jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
    ).stdout.trim();
    await jj(root, ["new", base, "-m", "Left"]);
    await writeFile(path.join(root, "conflict.txt"), contents("left"));
    await writeFile(path.join(root, "other.txt"), "left other\n");
    const left = (
      await jj(root, ["log", "-r", "@", "--no-graph", "-T", "commit_id"])
    ).stdout.trim();
    await jj(root, ["new", base, "-m", "Right"]);
    await writeFile(path.join(root, "conflict.txt"), contents("right"));
    await writeFile(path.join(root, "other.txt"), "right other\n");
    await jj(root, ["new", left, "@", "-m", "Conflicted parent"]);
    const parent = (
      await jj(root, ["log", "-r", "@", "--no-graph", "-T", "change_id"])
    ).stdout.trim();
    await jj(root, ["new", "-m", "Resolved child"]);
    await writeFile(path.join(root, "conflict.txt"), contents("resolved"));
    await writeFile(path.join(root, "other.txt"), "resolved other\n");
    const service = new ReviewService({ repoPath: root });
    const clean = await service.getState();
    assert.equal(clean.parent!.changeId, parent);
    assert.equal(clean.squashUnavailable, undefined);
    assert.ok(clean.targets.some((target) => target.changeId === parent));
    const original = await fileAt(root, "@-", "conflict.txt");
    const other = await fileAt(root, "@-", "other.txt");
    const file = clean.files.find((file) => file.path === "conflict.txt")!;
    assert.equal(file.unsupported, undefined);
    assert.equal(file.hunks.length, 2);
    const first = file.hunks[0];
    const partial = await service.squashLines({
      version: clean.version,
      selections: [{ id: first.id, lines: changes(first) }],
    });
    assert.equal(partial.warning, undefined);
    assert.equal(partial.state.canUndo, true);
    assert.equal(partial.state.parent!.changeId, parent);
    assert.equal(partial.state.squashUnavailable, undefined);
    const remaining = partial.state.files.find(
      (file) => file.path === "conflict.txt",
    )!;
    assert.equal(remaining.hunks.length, 1);
    const partialBytes = await fileAt(root, "@-", "conflict.txt");
    assert.ok(partialBytes.startsWith("resolved first\n"));
    assert.ok(partialBytes.includes("left second\n"));
    assert.ok(partialBytes.includes("right second\n"));
    assert.equal(await fileAt(root, "@-", "other.txt"), other);
    assert.equal(await fileAt(root, "@", "conflict.txt"), contents("resolved"));
    assert.equal((await service.getState()).version, partial.state.version);

    // The legacy path must also accept the conflicted immediate parent.
    const preview = await service.preview(
      input(
        partial.state,
        partial.state.files.flatMap((file) =>
          file.hunks.map((hunk) => ({
            id: hunk.id,
            lines: changes(hunk),
          })),
        ),
        parent,
      ),
    );
    const complete = await service.squash(preview.token);
    assert.equal(complete.warning, undefined);
    assert.equal(complete.state.files.length, 0);
    assert.equal(
      await fileAt(root, "@-", "conflict.txt"),
      contents("resolved"),
    );
    assert.equal(await fileAt(root, "@-", "other.txt"), "resolved other\n");
    assert.equal(
      (
        await jj(root, [
          "log",
          "--no-graph",
          "-r",
          "conflicts()",
          "-T",
          "change_id",
        ])
      ).stdout,
      "",
    );
    const undone = await service.undo(complete.state.version);
    assert.deepEqual(undone.state.files, partial.state.files);
    assert.equal(undone.state.parent!.changeId, parent);
    assert.equal(await fileAt(root, "@-", "conflict.txt"), partialBytes);
    assert.equal(await fileAt(root, "@-", "other.txt"), other);
    assert.notEqual(partialBytes, original);
  });
}

test("immediate squash chooses only the exact parent, retains partial rows, and undoes", async () => {
  const { service, state, root } = await fixture();
  assert.deepEqual(state.parent, state.targets[0]);
  assert.equal(state.squashUnavailable, undefined);
  const file = state.files[2];
  const hunk = file.hunks[1];
  const added = hunk.rows.filter((row) => row.raw.startsWith("+"));
  const grandparent = (
    await jj(root, ["log", "--no-graph", "-r", "@--", "-T", "commit_id"])
  ).stdout;
  const result = await service.squashLines({
    version: state.version,
    selections: [{ id: hunk.id, lines: [added[0].index] }],
  });
  assert.equal(result.state.parent!.changeId, state.parent!.changeId);
  assert.notEqual(result.state.parent!.commitId, state.parent!.commitId);
  assert.equal(
    (await jj(root, ["log", "--no-graph", "-r", "@--", "-T", "commit_id"]))
      .stdout,
    grandparent,
  );
  const parent = await fileAt(root, "@-", file.path);
  assert.ok(parent.includes(added[0].raw.slice(1)));
  assert.ok(!parent.includes(added[1].raw.slice(1)));
  assert.equal(result.state.canUndo, true);
  await rejectsCode(
    service.squashLines({
      version: state.version,
      selections: [{ id: hunk.id, lines: [added[0].index] }],
    }),
    "STALE_STATE",
  );
  const undone = await service.undo(result.state.version);
  assert.deepEqual(undone.state.files, state.files);
  assert.deepEqual(undone.state.parent, state.parent);
});

test("immediate squash rejects target override and concurrent duplicate execution", async () => {
  const { service, state } = await fixture();
  const hunk = state.files[0].hunks[0];
  const request = {
    version: state.version,
    selections: [{ id: hunk.id, lines: changes(hunk) }],
  };
  await rejectsCode(
    service.squashLines({
      ...request,
      target: state.targets[1].changeId,
    } as typeof request),
    "INVALID_REQUEST",
  );
  const results = await Promise.allSettled([
    service.squashLines(request),
    service.squashLines(request),
  ]);
  assert.equal(results[0].status, "fulfilled");
  assert.equal(results[1].status, "rejected");
  if (results[1].status === "rejected")
    assert.equal(results[1].reason.code, "STALE_STATE");
  assert.equal(
    (await service.getState()).files.flatMap((file) => file.hunks).length,
    5,
  );
});

test("immutable immediate parent never falls back to an older candidate", async () => {
  const { service, state, root } = await fixture();
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    state.parent!.changeId,
  ]);
  let restricted = await service.getState();
  assert.equal(restricted.parent, null);
  assert.match(restricted.squashUnavailable!, /immediate parent is immutable/);
  // Model a customized mutable() alias which advertises an older ancestor.
  // Immutable ancestry is normally closed, but such aliases must not cause fallback.
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."mutable()"',
    `${state.source.changeId} | ${state.targets[1].changeId}`,
  ]);
  restricted = await service.getState();
  assert.deepEqual(
    restricted.targets.map((target) => target.changeId),
    [state.targets[1].changeId],
  );
  assert.equal(restricted.parent, null);
  const hunk = restricted.files[0].hunks[0];
  await rejectsCode(
    service.squashLines({
      version: restricted.version,
      selections: [{ id: hunk.id, lines: changes(hunk) }],
    }),
    "SQUASH_UNAVAILABLE",
  );
  assert.equal((await service.getState()).operation, restricted.operation);
});

test("merge parents are unavailable rather than selecting any ancestor; file context fails closed", async () => {
  const { state, root } = await fixture();
  await jj(root, ["new", state.source.commitId, "-m", "left"]);
  await writeFile(path.join(root, "left.txt"), "left\n");
  const left = (
    await jj(root, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])
  ).stdout.trim();
  await jj(root, ["new", state.source.commitId, "-m", "right"]);
  await writeFile(path.join(root, "right.txt"), "right\n");
  await jj(root, ["new", left, "@", "-m", "merge"]);
  await writeFile(path.join(root, "merge.txt"), "merge\n");
  const service = new ReviewService({ repoPath: root });
  const merged = await service.getState();
  assert.equal(merged.parent, null);
  assert.match(merged.squashUnavailable!, /exactly one immediate parent/);
  assert.ok(merged.targets.length > 1);
  const hunk = merged.files[0].hunks[0];
  await rejectsCode(
    service.squashLines({
      version: merged.version,
      selections: [{ id: hunk.id, lines: changes(hunk) }],
    }),
    "SQUASH_UNAVAILABLE",
  );
  await rejectsCode(
    service.getFile({ version: merged.version, path: "merge.txt" }),
    "UNSUPPORTED_DIFF",
  );
});

test("log uses the review revset and real jj graph output, with no custom app text template or ANSI", async () => {
  const { service, state, root } = await fixture();
  const result = await service.getLog();
  assert.equal(result.version, state.version);
  assert.equal(
    result.output,
    (await jj(root, ["log", "-r", reviewLogRevset])).stdout,
  );
  assert.match(result.output, /@/);
  assert.ok(result.output.includes(state.source.description));
  assert.ok(!result.output.includes("\u001b"));
  assert.equal((await service.getState()).operation, state.operation);
});

test("file context uses full pinned parent/source contents and rejects stale or arbitrary paths", async () => {
  const { service, state, root } = await fixture();
  for (const file of state.files) {
    const result = await service.getFile({
      version: state.version,
      path: file.path,
    });
    assert.deepEqual(result, {
      oldFile: {
        name: file.path,
        contents: await fileAt(root, state.parent!.commitId, file.path),
      },
      newFile: {
        name: file.path,
        contents: await readFile(path.join(root, file.path), "utf8"),
      },
    });
    assert.ok(
      result.newFile!.contents.split("\n").length > file.hunks[0].rows.length,
    );
  }
  for (const name of [
    "/etc/passwd",
    "../package.json",
    ".jj/repo/config.toml",
    "src",
    "all()",
    "--help",
    "src/*.ts",
  ]) {
    await rejectsCode(
      service.getFile({ version: state.version, path: name }),
      "INVALID_PATH",
    );
  }
  await appendFile(
    path.join(root, state.files[0].path),
    "\n// stale context\n",
  );
  await rejectsCode(
    service.getFile({ version: state.version, path: state.files[0].path }),
    "STALE_STATE",
  );
});

test("context new/deleted files have null opposite sides and unsupported files are refused", async () => {
  const { service, root } = await fixture();
  const { unlink } = await import("node:fs/promises");
  await writeFile(path.join(root, "added.txt"), "one\ntwo\n");
  const deletedContents = await fileAt(root, "@-", "src/preferences.ts");
  await unlink(path.join(root, "src/preferences.ts"));
  let state = await service.getState();
  assert.deepEqual(
    await service.getFile({ version: state.version, path: "added.txt" }),
    {
      oldFile: null,
      newFile: { name: "added.txt", contents: "one\ntwo\n" },
    },
  );
  assert.deepEqual(
    await service.getFile({
      version: state.version,
      path: "src/preferences.ts",
    }),
    {
      oldFile: { name: "src/preferences.ts", contents: deletedContents },
      newFile: null,
    },
  );
  await writeFile(path.join(root, "added.txt"), "missing newline");
  state = await service.getState();
  await rejectsCode(
    service.getFile({ version: state.version, path: "added.txt" }),
    "UNSUPPORTED_DIFF",
  );
});

test("file reads reject working-copy races and graph reads reject recorded-history races", async () => {
  const { state, root } = await fixture();
  for (const action of ["file", "log"] as const) {
    const service = new ReviewService({
      repoPath: root,
      jjRunner: async (cwd, args) => {
        const result = await jj(cwd, args);
        if (
          (action === "file" && args[0] === "file" && args[1] === "show") ||
          (action === "log" &&
            args[0] === "log" &&
            args.includes("--at-operation"))
        ) {
          if (action === "file") {
            // File-content validation still snapshots external edits.
            await appendFile(
              path.join(root, state.files[0].path),
              "\n// race file\n",
            );
          } else {
            // Graph reads must not snapshot; only a recorded external operation
            // invalidates the pinned graph, not unsnapshotted worktree bytes.
            await jj(cwd, ["bookmark", "set", "graph-race", "-r", "@"]);
          }
        }
        return result;
      },
    });
    const version = (await service.getState()).version;
    await rejectsCode(
      action === "file"
        ? service.getFile({ version, path: state.files[0].path })
        : service.getLog(),
      "STALE_STATE",
    );
  }
});

test("immediate squash retains preview verification and revalidates before mutation", async () => {
  const { state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (args[0] === "file" && args[1] === "show")
        await appendFile(
          path.join(root, "src/notifications.ts"),
          "\n// external edit during internal preview\n",
        );
      return result;
    },
    toolRunner: (command, args, cwd) => {
      if (args[0] === "squash") squashCalls++;
      return run(command, args, cwd);
    },
  });
  const hunk = state.files[0].hunks[0];
  await rejectsCode(
    service.squashLines({
      version: state.version,
      selections: [{ id: hunk.id, lines: changes(hunk) }],
    }),
    "STALE_STATE",
  );
  assert.equal(squashCalls, 0);
  assert.equal(
    (await service.getState()).parent!.commitId,
    state.parent!.commitId,
  );
});

test("new endpoint contracts include parent, raw log, context and immediate squash without target", async (t) => {
  const { service, state } = await fixture();
  const app = express();
  app.use("/api", createApi(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const post = (route: string, body: unknown) =>
    fetch(`${base}/${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.deepEqual(
    (await (await fetch(`${base}/state`)).json()).parent,
    state.parent,
  );
  const log = await fetch(`${base}/log`);
  assert.equal(log.status, 200);
  assert.equal(log.headers.get("cache-control"), "no-store");
  assert.deepEqual(await log.json(), await service.getLog());
  const file = await post("file", {
    version: state.version,
    path: state.files[0].path,
  });
  assert.equal(file.status, 200);
  assert.deepEqual(
    await file.json(),
    await service.getFile({
      version: state.version,
      path: state.files[0].path,
    }),
  );
  const hunk = state.files[0].hunks[0];
  const request = {
    version: state.version,
    selections: [{ id: hunk.id, lines: changes(hunk) }],
  };
  for (const [route, body] of [
    ["squash-lines", {}],
    ["squash-lines", { ...request, target: state.targets[1].changeId }],
    ["squash-lines", { ...request, selections: [] }],
    ["file", {}],
    [
      "file",
      { version: state.version, path: state.files[0].path, revision: "@--" },
    ],
  ] as const) {
    const response = await post(route, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  const invalid = await post("file", {
    version: state.version,
    path: "../secret",
  });
  assert.equal(invalid.status, 400);
  const response = await post("squash-lines", request);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.state.canUndo, true);
  assert.equal(typeof result.output, "string");
  assert.equal("token" in result, false);
  assert.equal((await post("squash-lines", request)).status, 409);
  assert.equal(
    (await post("file", { version: state.version, path: state.files[0].path }))
      .status,
    409,
  );
  assert.equal(
    (await post("undo", { version: result.state.version })).status,
    200,
  );
});

test("file context remains available when the exact parent is immutable", async () => {
  const { service, state, root } = await fixture();
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    state.parent!.changeId,
  ]);
  const restricted = await service.getState();
  assert.equal(restricted.parent, null);
  const file = restricted.files[0];
  const context = await service.getFile({
    version: restricted.version,
    path: file.path,
  });
  assert.equal(
    context.oldFile!.contents,
    await fileAt(root, state.parent!.commitId, file.path),
  );
});

for (const side of ["base", "source"] as const) {
  test(`immediate squash rejects exact ${side} bytes inconsistent with its pinned diff`, async () => {
    const { state, root } = await fixture();
    let squashCalls = 0;
    let corrupted = false;
    const service = new ReviewService({
      repoPath: root,
      toolRunner: async (command, args, cwd) => {
        squashCalls++;
        return run(command, args, cwd);
      },
      jjRunner: async (cwd, args) => {
        const result = await jj(cwd, args);
        const revision =
          side === "base" ? state.parent!.commitId : state.source.commitId;
        if (
          args[0] === "file" &&
          args[1] === "show" &&
          args.includes(revision)
        ) {
          corrupted = true;
          const stdout = "wrong pinned file contents\n";
          return { ...result, stdout, stdoutBytes: Buffer.from(stdout) };
        }
        return result;
      },
    });
    const hunk = state.files[0].hunks[0];
    await rejectsCode(
      service.squashLines({
        version: state.version,
        selections: [{ id: hunk.id, lines: changes(hunk) }],
      }),
      "UNSAFE_PREVIEW",
    );
    assert.equal(corrupted, true);
    assert.equal(squashCalls, 0);
    assert.deepEqual(await service.getState(), state);
  });
}

test("immediate squash preserves in-process recovery guard after a post-write tool failure", async () => {
  const { dataDir, state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "squash") {
        squashCalls++;
        throw new ProcessError(
          command,
          args,
          {
            ...result,
            stderr: "Simulated immediate squash failure after mutation",
          },
          23,
        );
      }
      return result;
    },
  });
  const hunk = state.files[0].hunks[0];
  const selections = [{ id: hunk.id, lines: changes(hunk) }];
  await rejectsCode(
    service.squashLines({ version: state.version, selections }),
    "PARTIAL_FAILURE",
  );
  const current = await service.getState();
  assert.equal(current.canUndo, false);
  await rejectsCode(
    service.squashLines({ version: current.version, selections }),
    "RECOVERY_REQUIRED",
  );
  assert.equal(squashCalls, 1);
  const restarted = new ReviewService({ repoPath: root });
  assert.deepEqual(await restarted.getState(), current);
  const nextHunk = current.files[0].hunks[0];
  await restarted.preview(
    input(current, [{ id: nextHunk.id, lines: changes(nextHunk) }]),
  );
  await rejectsCode(restarted.undo(current.version), "UNDO_UNAVAILABLE");
  assert.equal((await restarted.getState()).operation, current.operation);
  assert.deepEqual(await readdir(dataDir), [path.basename(root)]);
});

test("immutable diff cache serves state, log and context without repeating pinned diffs or sharing mutable objects", async () => {
  const { root } = await fixture();
  let diffs = 0,
    toolCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      toolCalls++;
      return run(command, args, cwd);
    },
    jjRunner: async (cwd, args) => {
      if (args[0] === "diff") diffs++;
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  const pristine = structuredClone(state);
  assert.equal(diffs, 1);
  const context = await service.getFile({
    version: state.version,
    path: state.files[0].path,
  });
  assert.equal(
    context.newFile!.contents,
    await fileAt(root, state.source.commitId, state.files[0].path),
  );
  assert.equal((await service.getLog()).version, state.version);
  state.files[0].hunks[0].rows[0].raw = "+caller mutation";
  state.files[0].hunks[0].id = "caller mutation";
  state.files[0].patch = "caller mutation";
  assert.deepEqual(await service.getState(), pristine);
  assert.equal(diffs, 1);
  const hunk = pristine.files[0].hunks[0];
  await rejectsCode(
    service.squashLines({
      version: pristine.version,
      selections: [
        {
          id: hunk.id,
          lines: [hunk.rows.find((row) => row.raw.startsWith(" "))!.index],
        },
      ],
    }),
    "INVALID_SELECTION",
  );
  await rejectsCode(
    service.getFile({
      version: pristine.version,
      path: ".jj/repo/config.toml",
    }),
    "INVALID_PATH",
  );
  assert.equal(
    toolCalls,
    0,
    "reads and invalid cached selections never invoke a mutation tool",
  );
});

test("cached source never hides external operation-only changes or unsnapshotted workspace edits", async () => {
  const { root } = await fixture();
  let diffs = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (args[0] === "diff") diffs++;
      return jj(cwd, args);
    },
  });
  const initial = await service.getState();
  const selection = [
    {
      id: initial.files[0].hunks[0].id,
      lines: changes(initial.files[0].hunks[0]),
    },
  ];
  await jj(root, ["bookmark", "create", "external-cache-test", "-r", "@"]);
  const history = await service.getState();
  assert.equal(history.source.commitId, initial.source.commitId);
  assert.notEqual(history.operation, initial.operation);
  assert.notEqual(history.version, initial.version);
  assert.equal(
    diffs,
    1,
    "operation-only changes reuse immutable source diff, not the old version",
  );
  await rejectsCode(
    service.squashLines({ version: initial.version, selections: selection }),
    "STALE_STATE",
  );
  await rejectsCode(
    service.getFile({ version: initial.version, path: initial.files[0].path }),
    "STALE_STATE",
  );
  const graph = await service.getLog();
  assert.equal(graph.version, history.version);
  assert.match(graph.output, /external-cache-test/);
  await appendFile(
    path.join(root, initial.files[0].path),
    "\n// external unsnapshotted edit\n",
  );
  await rejectsCode(
    service.getFile({ version: history.version, path: history.files[0].path }),
    "STALE_STATE",
  );
  await rejectsCode(
    service.squashLines({ version: history.version, selections: selection }),
    "STALE_STATE",
  );
  const edited = await service.getState();
  assert.notEqual(edited.source.commitId, history.source.commitId);
  assert.notEqual(edited.version, history.version);
  assert.equal(diffs, 2);
  assert.match(edited.files[0].patch, /external unsnapshotted edit/);
  assert.deepEqual(
    edited,
    await new ReviewService({ repoPath: root }).getState(),
  );
});

test("cached source rechecks configuration-only immutability without an operation change", async () => {
  const { root } = await fixture();
  let diffs = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (args[0] === "diff") diffs++;
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    state.parent!.commitId,
  ]);
  const restricted = await service.getState();
  assert.equal(restricted.operation, state.operation);
  assert.equal(restricted.source.commitId, state.source.commitId);
  assert.notEqual(restricted.version, state.version);
  assert.equal(restricted.parent, null);
  assert.equal(diffs, 1);
  const selections = [
    { id: state.files[0].hunks[0].id, lines: changes(state.files[0].hunks[0]) },
  ];
  await rejectsCode(
    service.squashLines({ version: state.version, selections }),
    "STALE_STATE",
  );
  await rejectsCode(
    service.squashLines({ version: restricted.version, selections }),
    "SQUASH_UNAVAILABLE",
  );
  await rejectsCode(
    service.getFile({ version: state.version, path: state.files[0].path }),
    "STALE_STATE",
  );
  const context = await service.getFile({
    version: restricted.version,
    path: restricted.files[0].path,
  });
  assert.equal(
    context.oldFile!.contents,
    await fileAt(root, state.parent!.commitId, state.files[0].path),
  );
});

test("revision API validates strict versioned identity input and returns the explicitly selected state", async (t) => {
  const { service, state } = await fixture();
  const app = express();
  app.use("/api", createApi(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const select = (body: unknown) =>
    fetch(`${base}/revision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  for (const body of [
    {},
    { version: state.version },
    { version: state.version, changeId: "@-" },
    { version: state.version, changeId: "k".repeat(65) },
    {
      version: state.version,
      changeId: state.parent!.changeId,
      target: state.source.changeId,
    },
    { version: 1, changeId: state.parent!.changeId },
  ]) {
    const response = await select(body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  const missing = await select({
    version: state.version,
    changeId: "k".repeat(32),
  });
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "INVALID_REVISION");
  const selectedResponse = await select({
    version: state.version,
    changeId: state.parent!.changeId,
  });
  assert.equal(selectedResponse.status, 200);
  const { state: selected } = (await selectedResponse.json()) as {
    state: State;
  };
  assert.deepEqual(selected.source, state.parent);
  const stale = await select({
    version: state.version,
    changeId: state.source.changeId,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "STALE_STATE");
  const immutable = await select({
    version: selected.version,
    changeId: "z".repeat(32),
  });
  assert.equal(immutable.status, 409);
  assert.equal((await immutable.json()).code, "IMMUTABLE_SOURCE");
  const log = await (await fetch(`${base}/log`)).json();
  const rowLog = await (await fetch(`${base}/log?format=rows`)).json();
  assert.deepEqual(rowLog, { version: log.version, rows: log.rows });
  const graphResponse = await fetch(`${base}/graph`);
  assert.equal(graphResponse.status, 200);
  assert.equal(graphResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await graphResponse.json(), rowLog);
  assert.equal((await fetch(`${base}/log?format=invalid`)).status, 400);
  assert.equal(log.version, selected.version);
  assert.equal(typeof log.output, "string");
  assert.ok(
    log.rows.some(
      (row: { revision?: { changeId: string }; mutable?: boolean }) =>
        row.revision?.changeId === selected.source.changeId && row.mutable,
    ),
  );
  assert.deepEqual(await service.getState(), selected);
});

test("native callback failure includes its full invocation over HTTP and never retried by reads or restart", async (t) => {
  const { root, state } = await fixture();
  // Native callback errors must preserve jj diagnostics, without legacy dependency advice.
  const stderr =
    "Error: Failed to edit diff\nCaused by:\n    jj-stamp native callback: source tree did not match pinned plan\n    Tool exited with exit status: 1\n";
  let squashCalls = 0;
  let invocation = "";
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "squash") {
        squashCalls++;
        assert.equal(command, "jj");
        assert.deepEqual(args.slice(0, 9), [
          "squash",
          "--from",
          state.source.commitId,
          "--into",
          state.parent!.commitId,
          "--tool",
          "jj-stamp",
          "--use-destination-message",
          "--keep-emptied",
        ]);
        assert.ok(args.includes("--config"));
        assert.deepEqual(args.slice(args.indexOf("--") + 1), [
          `root-file:${JSON.stringify(state.files[0].path)}`,
        ]);
        invocation = formatCommand(command, args);
        throw new ProcessError(command, args, { stdout: "", stderr }, 1);
      }
      return run(command, args, cwd);
    },
  });
  const app = express();
  app.use("/api", createApi(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const hunk = state.files[0].hunks[0];
  const response = await fetch(`${base}/squash-lines`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      version: state.version,
      selections: [{ id: hunk.id, lines: [changes(hunk)[0]] }],
    }),
  });
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const error = await response.json();
  assert.equal(error.code, "TOOL_FAILED");
  assert.match(error.output, /native callback/);
  assert.doesNotMatch(error.error, /GNU patch|required patch executable/);
  assert.match(
    error.error,
    /without a recorded history change.*Nothing was automatically retried/,
  );
  assert.equal(
    error.output,
    `Working directory: ${root}\nFailed command:\n${invocation}\n\n${stderr}`,
    "include the exact failed invocation and preserve complete subprocess diagnostics",
  );
  assert.deepEqual(await service.getState(), state);
  assert.deepEqual(await (await fetch(`${base}/state`)).json(), state);
  assert.deepEqual(
    await new ReviewService({ repoPath: root }).getState(),
    state,
  );
  assert.equal(
    squashCalls,
    1,
    "reads and restart never replay the failed selection",
  );
});

test("pinned preparation file-read failures expose stdout and stderr without attempting a mutation", async (t) => {
  const { root, state } = await fixture();
  const stdout = "Reading pinned file\n";
  const stderr = "Error: pinned file could not be read\n";
  let squashCalls = 0;
  let invocation = "";
  const service = new ReviewService({
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "squash") squashCalls++;
      return run(command, args, cwd);
    },
    jjRunner: async (cwd, args) => {
      if (args[0] === "file" && args[1] === "show") {
        invocation = formatCommand("jj", args);
        throw new ProcessError("jj", args, { stdout, stderr }, 1, cwd);
      }
      return jj(cwd, args);
    },
  });
  const app = express();
  app.use("/api", createApi(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const hunk = state.files[0].hunks[0];
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/squash-lines`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: state.version,
        selections: [{ id: hunk.id, lines: [changes(hunk)[0]] }],
      }),
    },
  );
  assert.equal(response.status, 500);
  const error = await response.json();
  assert.equal(error.code, "TOOL_FAILED");
  assert.equal(
    error.output,
    `Working directory: ${root}\nFailed command:\n${invocation}\n\n${stdout}${stderr}`,
  );
  assert.match(error.error, /pinned file could not be read/);
  assert.equal(squashCalls, 0);
  assert.deepEqual(await service.getState(), state);
});

test("transient preparation file-read failures do not poison cached diffs or authorize writes", async () => {
  const { root } = await fixture();
  let failRead = true;
  let reads = 0;
  let diffs = 0;
  let mutations = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (args[0] === "diff") diffs++;
      if (args[0] === "file" && args[1] === "show") {
        reads++;
        if (failRead) {
          failRead = false;
          throw new ProcessError(
            "jj",
            args,
            { stdout: "", stderr: "temporary file read failure\n" },
            1,
            cwd,
          );
        }
      }
      return jj(cwd, args);
    },
    toolRunner: async (command, args, cwd) => {
      mutations++;
      return run(command, args, cwd);
    },
  });
  const state = await service.getState();
  const hunk = state.files[0].hunks[0];
  const request = input(state, [{ id: hunk.id, lines: changes(hunk) }]);
  await assert.rejects(service.preview(request), (error: unknown) => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.result.stderr, "temporary file read failure\n");
    assert.equal(error.command, "jj");
    assert.ok(error.args.includes(state.parent!.commitId));
    return true;
  });
  assert.equal(reads, 1);
  assert.equal(mutations, 0);
  assert.deepEqual(await service.getState(), state);
  const preview = await service.preview(request);
  assert.ok(preview.token);
  assert.equal(
    reads,
    3,
    "fresh explicit preview retries both pinned file sides",
  );
  assert.equal(
    diffs,
    1,
    "file-read failures do not change or refetch the immutable diff",
  );
  assert.equal(mutations, 0);
});

test("direct squash reads exact pinned file sides and only the new source diff, never an external preview", async () => {
  const { root } = await fixture();
  let diffs = 0;
  let mutations = 0;
  const reads: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (args[0] === "diff") diffs++;
      if (args[0] === "file" && args[1] === "show") reads.push(args);
      return jj(cwd, args);
    },
    toolRunner: async (command, args, cwd) => {
      assert.equal(command, "jj");
      assert.equal(
        args[0],
        "squash",
        "the mutation is the only external tool invocation",
      );
      mutations++;
      return run(command, args, cwd);
    },
  });
  const before = await service.getState();
  diffs = 0;
  const file = before.files[2];
  const hunk = file.hunks[1];
  const result = await service.squashLines({
    version: before.version,
    selections: [
      {
        id: hunk.id,
        lines: [hunk.rows.find((row) => row.raw.startsWith("+"))!.index],
      },
    ],
  });
  assert.deepEqual(
    reads,
    [before.parent!.commitId, before.source.commitId].map((revision) => [
      "file",
      "show",
      "-r",
      revision,
      "--ignore-working-copy",
      "--",
      `root-file:${JSON.stringify(file.path)}`,
    ]),
  );
  assert.equal(mutations, 1);
  assert.equal(diffs, 1);
  assert.equal(result.state.canUndo, true);
  assert.deepEqual(await service.getState(), result.state);
  assert.equal(diffs, 1);
});

test("native partial multi-file squash preserves the complete source tree and unselected destination files", async () => {
  const { service, root, state } = await fixture();
  const tree = async (revision: string) => {
    const paths = (
      await jj(root, ["file", "list", "-r", revision, "--ignore-working-copy"])
    ).stdout
      .trim()
      .split("\n");
    return Promise.all(
      paths.map(async (file) => [file, await fileAt(root, revision, file)]),
    );
  };
  const originalSource = await tree(state.source.commitId);
  const untouchedPath = state.files[1].path;
  const untouchedParent = await fileAt(
    root,
    state.parent!.commitId,
    untouchedPath,
  );
  const selected = [state.files[0], state.files[2]].map((file) => {
    const hunk = file.hunks[1];
    return {
      id: hunk.id,
      lines: [hunk.rows.find((row) => row.raw.startsWith("+"))!.index],
    };
  });
  const result = await service.squashLines({
    version: state.version,
    selections: selected,
  });
  assert.deepEqual(await tree(result.state.source.commitId), originalSource);
  assert.equal(
    await fileAt(root, result.state.parent!.commitId, untouchedPath),
    untouchedParent,
  );
  assert.notEqual(result.state.parent!.commitId, state.parent!.commitId);
  assert.equal(result.state.source.changeId, state.source.changeId);
  assert.equal(result.state.canUndo, true);
  const undone = await service.undo(result.state.version);
  assert.deepEqual(await tree(undone.state.source.commitId), originalSource);
  assert.equal(undone.state.parent!.commitId, state.parent!.commitId);
});
