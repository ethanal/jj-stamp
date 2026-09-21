import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { ReviewService, ApiError } from "../server/service.ts";
import type { ReviewHunk, State, Selection } from "../server/service.ts";
import { jj, run, ProcessError } from "../server/process.ts";
import { createApi } from "../server/api.ts";
import { assertExactPreview, parseFile } from "../server/diff.ts";
import { createDemo } from "./fixtures.ts";

async function fixture() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fold-backend-"));
  const root = await createDemo(dataDir);
  const service = new ReviewService({ dataDir, repoPath: root });
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
  const { service, state, dataDir, root } = await fixture();
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
    await new ReviewService({ dataDir, repoPath: root }).getState(),
    state,
  );
});

test("full hunk squash rewrites pinned parent, retains other changes, and exact undo survives restart", async () => {
  const { service, state, root, dataDir } = await fixture();
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
    preview.command.endsWith("--use-destination-message --keep-emptied"),
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
  const restarted = new ReviewService({ dataDir, repoPath: root });
  assert.equal((await restarted.getState()).canUndo, true);
  const undone = await restarted.undo(result.state.version);
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
  await rejectsCode(restarted.undo(undone.state.version), "UNDO_UNAVAILABLE");
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

test("preview verifier rejects changed path, widened changes and shifted hunk positions", () => {
  const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,4 @@\n a\n+b\n+c\n z\n";
  const parsed = parseFile(patch, "x.ts");
  const picks = [{ patch, path: "x.ts", hunk: parsed.hunks[0], lines: [2] }];
  const exact = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n a\n+b\n z\n";
  assertExactPreview(exact, picks);
  assert.throws(() =>
    assertExactPreview(exact.replaceAll("x.ts", "other.ts"), picks),
  );
  assert.throws(() => assertExactPreview(patch, picks));
  assert.throws(() => assertExactPreview(exact.replace("-1,2", "-2,2"), picks));
});

test("persistent pending mutation blocks later squashes rather than blindly retrying", async () => {
  const { state, dataDir, root } = await fixture();
  const { createHash } = await import("node:crypto");
  const name = `operations-${createHash("sha256").update(state.repo.path).digest("hex").slice(0, 20)}.json`;
  await writeFile(
    path.join(dataDir, name),
    JSON.stringify({
      pending: {
        beforeOperation: state.operation,
        sourceCommit: state.source.commitId,
        kind: "squash",
      },
    }),
  );
  const restarted = new ReviewService({ dataDir, repoPath: root });
  const current = await restarted.getState();
  assert.equal(current.canUndo, false);
  const hunk = current.files[0].hunks[0];
  await rejectsCode(
    restarted.preview(input(current, [{ id: hunk.id, lines: changes(hunk) }])),
    "RECOVERY_REQUIRED",
  );
  assert.equal((await restarted.getState()).operation, current.operation);
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

test("nonzero tool exit after real squash leaves durable recovery guard and cannot replay", async () => {
  const { dataDir, state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    dataDir,
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
  await rejectsCode(service.squash(preview.token), "PARTIAL_FAILURE");
  assert.equal(squashCalls, 1);
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  assert.equal(squashCalls, 1);
  const restarted = new ReviewService({ dataDir, repoPath: root });
  const after = await restarted.getState();
  assert.notEqual(after.operation, state.operation);
  assert.equal(after.canUndo, false);
  assert.equal(after.files.flatMap((f) => f.hunks).length, 5);
  const nextHunk = after.files[0].hunks[0];
  await rejectsCode(
    restarted.preview(
      input(after, [{ id: nextHunk.id, lines: changes(nextHunk) }]),
    ),
    "RECOVERY_REQUIRED",
  );
  assert.equal((await restarted.getState()).operation, after.operation);
});

test("tool failure without mutation consumes token but allows a newly reviewed plan", async () => {
  const { dataDir, state, root } = await fixture();
  let fail = true;
  const service = new ReviewService({
    dataDir,
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
  const { dataDir, state, root } = await fixture();
  const service = new ReviewService({
    dataDir,
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
  const after = await new ReviewService({ dataDir, repoPath: root }).getState();
  assert.equal(after.canUndo, false);
  assert.notEqual(after.operation, state.operation);
});

test("conflicted repositories are refused, and immutable ancestors are never targets", async () => {
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
  await rejectsCode(service.getState(), "CONFLICTED_REPO");
  await rejectsCode(
    service.preview(input(restricted, [{ id: hunk.id, lines: changes(hunk) }])),
    "CONFLICTED_REPO",
  );
  // Return to an already cached, non-conflicted source. Conflicts elsewhere in
  // the repository must still block reads and mutations on a cache hit.
  await jj(root, ["edit", base]);
  await rejectsCode(service.getState(), "CONFLICTED_REPO");
  await rejectsCode(
    service.squashLines({
      version: restricted.version,
      selections: [{ id: hunk.id, lines: changes(hunk) }],
    }),
    "CONFLICTED_REPO",
  );
});

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
  const { state, root, dataDir } = await fixture();
  await jj(root, ["new", state.source.commitId, "-m", "left"]);
  await writeFile(path.join(root, "left.txt"), "left\n");
  const left = (
    await jj(root, ["log", "--no-graph", "-r", "@", "-T", "commit_id"])
  ).stdout.trim();
  await jj(root, ["new", state.source.commitId, "-m", "right"]);
  await writeFile(path.join(root, "right.txt"), "right\n");
  await jj(root, ["new", left, "@", "-m", "merge"]);
  await writeFile(path.join(root, "merge.txt"), "merge\n");
  const service = new ReviewService({ dataDir, repoPath: root });
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

test("log is real default jj graph output, with no custom app template or ANSI", async () => {
  const { service, state, root } = await fixture();
  const result = await service.getLog();
  assert.equal(result.version, state.version);
  assert.equal(
    result.output,
    (await jj(root, ["log", "--limit", "100"])).stdout,
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

test("file and graph reads reject repository changes during their final validation", async () => {
  const { dataDir, state, root } = await fixture();
  for (const action of ["file", "log"] as const) {
    const service = new ReviewService({
      dataDir,
      repoPath: root,
      jjRunner: async (cwd, args) => {
        const result = await jj(cwd, args);
        if (
          (action === "file" && args[0] === "file" && args[1] === "show") ||
          (action === "log" && args[0] === "log" && args[1] === "--limit")
        ) {
          // Edit after reading the pinned content/graph, before the final
          // snapshot. This must fire even when all diff listings are cached.
          await appendFile(
            path.join(root, state.files[0].path),
            `\n// race ${action}\n`,
          );
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
  const { dataDir, state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      const result = await run(command, args, cwd);
      if (args[0] === "patch")
        await appendFile(
          path.join(root, "src/notifications.ts"),
          "\n// external edit during internal preview\n",
        );
      if (args[0] === "squash") squashCalls++;
      return result;
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

test("immediate squash refuses unsafe internal previews without executing the tool", async () => {
  const { dataDir, state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "squash") squashCalls++;
      const result = await run(command, args, cwd);
      return args[0] === "patch"
        ? {
            ...result,
            stdout: result.stdout.replaceAll(
              "src/notifications.ts",
              "src/wrong.ts",
            ),
          }
        : result;
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
  assert.equal(squashCalls, 0);
  assert.equal((await service.getState()).operation, state.operation);
});

test("immediate squash preserves durable recovery guard after a post-write tool failure", async () => {
  const { dataDir, state, root } = await fixture();
  let squashCalls = 0;
  const service = new ReviewService({
    dataDir,
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
  const restarted = new ReviewService({ dataDir, repoPath: root });
  const current = await restarted.getState();
  assert.equal(current.canUndo, false);
  await rejectsCode(
    restarted.squashLines({ version: current.version, selections }),
    "RECOVERY_REQUIRED",
  );
  assert.equal(squashCalls, 1);
});

test("immutable diff cache serves state, log and context without repeating listings or sharing mutable objects", async () => {
  const { dataDir, root } = await fixture();
  let listings = 0,
    diffs = 0,
    patches = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "hunks") listings++;
      if (args[0] === "patch") patches++;
      return run(command, args, cwd);
    },
    jjRunner: async (cwd, args) => {
      if (args[0] === "diff") diffs++;
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  const pristine = structuredClone(state);
  assert.equal(listings, 3);
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
  assert.equal(listings, 3);
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
    patches,
    0,
    "invalid cached selections do not invoke patch or squash",
  );
});

test("cached source never hides external operation-only changes or unsnapshotted workspace edits", async () => {
  const { dataDir, root } = await fixture();
  let listings = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "hunks") listings++;
      return run(command, args, cwd);
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
    listings,
    3,
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
  assert.equal(listings, 6);
  assert.match(edited.files[0].patch, /external unsnapshotted edit/);
  assert.deepEqual(
    edited,
    await new ReviewService({ dataDir, repoPath: root }).getState(),
  );
});

test("cached source rechecks configuration-only immutability without an operation change", async () => {
  const { dataDir, root } = await fixture();
  let listings = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "hunks") listings++;
      return run(command, args, cwd);
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
  assert.equal(listings, 3);
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

test("transient hunk listing failures are not retained in the immutable diff cache", async () => {
  const { dataDir, root } = await fixture();
  let listings = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "hunks" && ++listings === 1)
        throw new Error("temporary listing failure");
      return run(command, args, cwd);
    },
  });
  const failed = await service.getState();
  assert.match(failed.files[0].unsupported!, /temporary listing failure/);
  const recovered = await service.getState();
  assert.ok(recovered.files.every((file) => !file.unsupported));
  assert.equal(listings, 6);
  assert.notEqual(recovered.version, failed.version);
  assert.deepEqual(await service.getState(), recovered);
  assert.equal(listings, 6);
});

test("direct squash checks one exact preview and lists only the new committed source", async () => {
  const { dataDir, root } = await fixture();
  let listings = 0,
    patches = 0,
    squashes = 0;
  const service = new ReviewService({
    dataDir,
    repoPath: root,
    toolRunner: async (command, args, cwd) => {
      if (args[0] === "hunks") listings++;
      if (args[0] === "patch") patches++;
      if (args[0] === "squash") squashes++;
      return run(command, args, cwd);
    },
  });
  const before = await service.getState();
  listings = 0;
  const hunk = before.files[2].hunks[1];
  const result = await service.squashLines({
    version: before.version,
    selections: [
      {
        id: hunk.id,
        lines: [hunk.rows.find((row) => row.raw.startsWith("+"))!.index],
      },
    ],
  });
  assert.equal(patches, 1);
  assert.equal(squashes, 1);
  assert.equal(listings, 3);
  assert.equal(result.state.canUndo, true);
  assert.deepEqual(await service.getState(), result.state);
  assert.equal(listings, 3);
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
