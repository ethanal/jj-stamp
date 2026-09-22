import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApiError, ReviewService } from "../server/service.ts";
import { jj, run } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-performance-"),
  );
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  return { repoPath: await createDemo(dataDir) };
}

// Count processes instead of asserting wall-clock timings on shared CI hosts.
test("state, graph and selection have bounded process budgets and derive all hunks locally", async (t) => {
  const options = await fixture(t);
  const calls: Array<{ command: string; args: string[] }> = [];
  const service = new ReviewService({
    ...options,
    jjRunner: (cwd, args) => {
      calls.push({ command: "jj", args });
      return jj(cwd, args);
    },
    toolRunner: (command, args, cwd) => {
      calls.push({ command, args });
      return run(command, args, cwd);
    },
  });
  const initial = await service.getState();
  assert.equal(initial.files.length, 3);
  assert.ok(
    initial.files.every((file) =>
      file.hunks.every((hunk) => /^[a-f0-9]{7}$/.test(hunk.id)),
    ),
  );
  assert.equal(
    calls.length,
    7,
    "initialization batches visibility; two metadata checks + one pinned diff",
  );
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "diff").map((call) => call.args),
    [["diff", "--git", "-r", initial.source.commitId, "--ignore-working-copy"]],
  );
  calls.length = 0;
  assert.deepEqual(await service.getState(), initial);
  assert.equal(
    calls.length,
    4,
    "warm state reads only live metadata and operation heads",
  );
  calls.length = 0;
  assert.equal((await service.getLog()).version, initial.version);
  assert.equal(calls.length, 6);
  assert.ok(
    calls.every((call) => call.command === "jj" && call.args[0] !== "diff"),
  );
  calls.length = 0;
  const rows = await service.getLog({ includeOutput: false });
  assert.equal(rows.version, initial.version);
  assert.ok(rows.rows.length);
  assert.equal(rows.output, "");
  assert.equal(
    calls.length,
    5,
    "the browser does not render an unused second graph",
  );
  calls.length = 0;
  const selected = (
    await service.selectRevision({
      version: initial.version,
      changeId: initial.parent!.changeId,
    })
  ).state;
  assert.equal(calls.length, 5, "both sources share validation snapshots");
  assert.deepEqual(
    calls.filter((call) => call.args[0] === "diff").map((call) => call.args),
    [
      [
        "diff",
        "--git",
        "-r",
        selected.source.commitId,
        "--ignore-working-copy",
      ],
    ],
  );
  assert.deepEqual(await service.getState(), selected);
});

test("a cold graph read needs neither diffs nor the mutation runner and has the same repository version", async (t) => {
  const options = await fixture(t);
  const service = new ReviewService({
    ...options,
    jjRunner: (cwd, args) => {
      assert.notEqual(args[0], "diff");
      return jj(cwd, args);
    },
    toolRunner: async () => {
      throw new Error("graph must not run the native mutation runner");
    },
  });
  const graph = await service.getLog({ includeOutput: false });
  assert.ok(graph.rows.length);
  assert.equal(
    graph.version,
    (await new ReviewService(options).getState()).version,
  );
});

for (const affected of ["source", "candidate"] as const) {
  test(`selection rechecks configuration-only mutability of ${affected} before publishing`, async (t) => {
    const options = await fixture(t);
    const original = (await new ReviewService(options).getState()).source;
    await jj(options.repoPath, [
      "new",
      "root()",
      "-m",
      "Independent candidate",
    ]);
    await writeFile(
      path.join(options.repoPath, "candidate.txt"),
      "candidate\n",
    );
    const candidate = (
      await jj(options.repoPath, [
        "log",
        "--no-graph",
        "-r",
        "@",
        "-T",
        "change_id",
      ])
    ).stdout.trim();
    let changed = false;
    const service = new ReviewService({
      ...options,
      revision: original.changeId,
      jjRunner: async (cwd, args) => {
        const result = await jj(cwd, args);
        if (
          args[0] === "diff" &&
          args[args.indexOf("-r") + 1] !== original.commitId &&
          !changed
        ) {
          assert.ok(args.includes("--ignore-working-copy"));
          changed = true;
          await jj(cwd, [
            "config",
            "set",
            "--repo",
            'revset-aliases."immutable_heads()"',
            affected === "source" ? original.changeId : candidate,
          ]);
        }
        return result;
      },
    });
    const before = await service.getState();
    await assert.rejects(
      service.selectRevision({ version: before.version, changeId: candidate }),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code ===
          (affected === "source" ? "STALE_STATE" : "IMMUTABLE_SOURCE"),
    );
    assert.equal(changed, true);
    const after = await service.getState();
    assert.equal(
      after.operation,
      before.operation,
      "configuration change has no history operation",
    );
    assert.deepEqual(
      after.source,
      before.source,
      "failed selection never changes source",
    );
  });
}

test("graph validation catches configuration changes without loading source hunks", async (t) => {
  const options = await fixture(t);
  const before = await new ReviewService(options).getState();
  let changed = false;
  const service = new ReviewService({
    ...options,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (args[0] === "log" && args.includes("--at-operation") && !changed) {
        changed = true;
        await jj(cwd, [
          "config",
          "set",
          "--repo",
          'revset-aliases."immutable_heads()"',
          before.parent!.commitId,
        ]);
      }
      return result;
    },
    toolRunner: async () => {
      throw new Error("graph must not run the native mutation runner");
    },
  });
  await assert.rejects(
    service.getLog({ includeOutput: false }),
    (error: unknown) =>
      error instanceof ApiError && error.code === "STALE_STATE",
  );
  assert.equal(changed, true);
  assert.equal(
    (await new ReviewService(options).getState()).operation,
    before.operation,
  );
});

test("review graph keeps more than 100 matching changes instead of following the default log revset", async (t) => {
  const options = await fixture(t);
  const initial = await new ReviewService(options).getState();
  for (let i = 0; i < 101; i++)
    await jj(options.repoPath, ["new", "root()", "-m", `Visible branch ${i}`]);
  // A narrow default demonstrates that the explicit review revset selects
  // the graph, without applying a latest()/limit cap to its matching changes.
  await jj(options.repoPath, [
    "config",
    "set",
    "--repo",
    "revsets.log",
    "root()",
  ]);
  const service = new ReviewService({
    ...options,
    revision: initial.source.changeId,
  });
  const log = await service.getLog({ includeOutput: false });
  const revisions = log.rows.flatMap((row) =>
    row.revision ? [row.revision] : [],
  );
  assert.equal(
    revisions.length,
    105,
    "101 branches + 3 fixture changes + root trunk",
  );
  assert.ok(
    revisions.some((revision) => revision.changeId === initial.source.changeId),
  );
  assert.ok(
    revisions.some((revision) => revision.description === "Visible branch 0"),
  );
  assert.ok(
    revisions.some((revision) => revision.description === "Visible branch 100"),
  );
});

for (const warm of [false, true]) {
  test(`${warm ? "warm" : "cold"} graph reads never snapshot working-copy edits`, async (t) => {
    const options = await fixture(t);
    const calls: string[][] = [];
    const service = new ReviewService({
      ...options,
      jjRunner: (cwd, args) => {
        calls.push(args);
        return jj(cwd, args);
      },
    });
    const initial = warm
      ? await service.getState()
      : await new ReviewService(options).getState();
    calls.length = 0;
    await appendFile(
      path.join(options.repoPath, initial.files[0].path),
      "\n// not yet snapshotted\n",
    );
    const graph = await service.getLog();
    assert.equal(
      graph.version,
      initial.version,
      "graph describes recorded repository state",
    );
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every(
        (args) =>
          args.includes("--ignore-working-copy") ||
          args.includes("--at-operation"),
      ),
      "every graph subprocess, including initialization, is explicitly non-snapshotting",
    );
    assert.equal(
      (
        await jj(options.repoPath, [
          "op",
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "--limit",
          "1",
          "-T",
          "self.id()",
        ])
      ).stdout.trim(),
      initial.operation,
    );
    assert.equal(
      (
        await jj(options.repoPath, [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          "@",
          "-T",
          "commit_id",
        ])
      ).stdout.trim(),
      initial.source.commitId,
    );
    // Diff reads still snapshot, so later mutation versions see these edits.
    const refreshed = await service.getState();
    assert.notEqual(refreshed.version, initial.version);
    assert.notEqual(refreshed.source.commitId, initial.source.commitId);
    assert.match(refreshed.files[0].patch, /not yet snapshotted/);
  });
}

test("cold state overlaps pinned diff and operation reads, then validates in order", async (t) => {
  const options = await fixture(t);
  let operationPending = false;
  let overlaps = 0;
  const calls: string[] = [];
  const service = new ReviewService({
    ...options,
    jjRunner: async (cwd, args) => {
      calls.push(args[0]);
      if (args[0] === "op") {
        operationPending = true;
        try {
          return await jj(cwd, args);
        } finally {
          operationPending = false;
        }
      }
      if (args[0] === "diff") {
        assert.equal(
          operationPending,
          true,
          "diff need not wait for operation metadata",
        );
        assert.ok(args.includes("--ignore-working-copy"));
        overlaps++;
      }
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  assert.equal(overlaps, 1);
  assert.deepEqual(
    calls.slice(-2),
    ["log", "op"],
    "final metadata validation precedes the operation head check",
  );
  assert.equal((await service.getState()).version, state.version);
});

test("a failed parallel read drains its sibling before releasing the service queue", async (t) => {
  const options = await fixture(t);
  let releaseDiff!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseDiff = resolve;
  });
  let signalDiff!: () => void;
  const diffStarted = new Promise<void>((resolve) => {
    signalDiff = resolve;
  });
  const failure = new Error("injected operation read failure");
  const service = new ReviewService({
    ...options,
    jjRunner: async (cwd, args) => {
      if (args[0] === "op") throw failure;
      if (args[0] === "diff") {
        signalDiff();
        await gate;
      }
      return jj(cwd, args);
    },
  });
  const failed = assert.rejects(
    service.getState(),
    (error) => error === failure,
  );
  await diffStarted;
  let drained = false;
  const draining = service.drain().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(
    drained,
    false,
    "shutdown/next requests must not abandon the diff subprocess",
  );
  releaseDiff();
  await Promise.all([failed, draining]);
  assert.equal(drained, true);
});

test("cold state subprocess budget stays constant with many files and mutable ancestors", async (t) => {
  const options = await fixture(t);
  for (let i = 0; i < 12; i++)
    await jj(options.repoPath, ["new", "-m", `Ancestor ${i}`]);
  for (let i = 0; i < 40; i++)
    await writeFile(
      path.join(options.repoPath, `file-${i}.txt`),
      `change ${i}\n`,
    );
  await jj(options.repoPath, ["status"]);
  const calls: Array<{ command: string; args: string[] }> = [];
  const service = new ReviewService({
    ...options,
    jjRunner: (cwd, args) => {
      calls.push({ command: "jj", args });
      return jj(cwd, args);
    },
    toolRunner: (command, args, cwd) => {
      calls.push({ command, args });
      return run(command, args, cwd);
    },
  });
  const state = await service.getState();
  assert.equal(state.files.length, 40);
  assert.equal(
    state.targets.length,
    14,
    "do not truncate live eligible ancestor metadata",
  );
  assert.ok(
    state.files.every((file) => !file.unsupported && file.hunks.length === 1),
  );
  assert.equal(calls.length, 7);
  assert.ok(calls.every(({ command }) => command === "jj"));
  assert.ok(calls.every(({ args }) => args[0] !== "file"));
  assert.equal(calls.filter(({ args }) => args[0] === "diff").length, 1);
  calls.length = 0;
  assert.deepEqual(await service.getState(), state);
  assert.equal(
    calls.length,
    4,
    "warm reads still revalidate live metadata and operation heads",
  );
});

test("an unavailable-source graph retains the five-process read-only budget and snapshots nothing", async (t) => {
  const options = await fixture(t);
  const calls: string[][] = [];
  let toolCalls = 0;
  const service = new ReviewService({
    ...options,
    jjRunner: (cwd, args) => {
      calls.push(args);
      return jj(cwd, args);
    },
    toolRunner: (command, args, cwd) => {
      toolCalls++;
      return run(command, args, cwd);
    },
  });
  const initial = await service.getState();
  await jj(options.repoPath, ["abandon", initial.source.changeId]);
  const operation = (
    await jj(options.repoPath, [
      "op",
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      "self.id()",
    ])
  ).stdout.trim();
  await writeFile(
    path.join(options.repoPath, "unsnapshotted.txt"),
    "not recorded\n",
  );
  calls.length = 0;
  toolCalls = 0;
  const graph = await service.getLog({ includeOutput: false });
  assert.ok(graph.rows.length);
  assert.notEqual(graph.version, initial.version);
  assert.equal(calls.length, 5);
  assert.equal(toolCalls, 0);
  assert.ok(
    calls.every(
      (args) =>
        args.includes("--ignore-working-copy") ||
        args.includes("--at-operation"),
    ),
  );
  assert.ok(calls.every((args) => args[0] !== "diff"));
  assert.equal(
    (
      await jj(options.repoPath, [
        "op",
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "--limit",
        "1",
        "-T",
        "self.id()",
      ])
    ).stdout.trim(),
    operation,
  );
});

test("direct squash and its graph refresh have explicit subprocess budgets", async (t) => {
  const options = await fixture(t);
  const calls: Array<{ command: string; args: string[] }> = [];
  const service = new ReviewService({
    ...options,
    jjRunner: (cwd, args) => {
      calls.push({ command: "jj", args });
      return jj(cwd, args);
    },
    toolRunner: (command, args, cwd) => {
      calls.push({ command, args });
      return run(command, args, cwd);
    },
  });
  const initial = await service.getState();
  const hunk = initial.files[0].hunks[0];
  calls.length = 0;
  const result = await service.squashLines({
    version: initial.version,
    selections: [
      {
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      },
    ],
  });
  assert.equal(result.state.canUndo, true);
  // One private capture + two pinned file reads/conflict baseline + final
  // metadata/op validation, native mutation, attribution, and the fully
  // validated rewritten source diff. Native editor internals are not counted.
  assert.equal(calls.length, 15);
  assert.equal(
    calls.filter((call) => call.command === "jj" && call.args[0] === "log")
      .length,
    6,
  );
  assert.equal(
    calls.filter((call) => call.command === "jj" && call.args[0] === "op")
      .length,
    5,
  );
  assert.equal(
    calls.filter((call) => call.command === "jj" && call.args[0] === "diff")
      .length,
    1,
  );
  assert.ok(calls.every((call) => call.command === "jj"));
  const fileReads = calls.filter((call) => call.args[0] === "file");
  assert.equal(fileReads.length, 2);
  for (const { args } of fileReads) {
    assert.equal(args[1], "show");
    assert.ok(args.includes("--ignore-working-copy"));
  }
  assert.equal(calls.filter((call) => call.args[0] === "squash").length, 1);
  const conflictReads = calls.filter((call) =>
    call.args.includes("conflicts()"),
  );
  assert.equal(conflictReads.length, 2);
  for (const { args } of conflictReads) {
    assert.ok(args.includes("--ignore-working-copy"));
    assert.equal(args[args.indexOf("-T") + 1], 'change_id ++ "\\n"');
  }
  const squashIndex = calls.findIndex(
    (call) => call.command === "jj" && call.args[0] === "squash",
  );
  assert.deepEqual(calls[squashIndex].args.slice(0, 7), [
    "squash",
    "--from",
    initial.source.commitId,
    "--into",
    initial.parent!.commitId,
    "--tool",
    "jj-stamp",
  ]);
  assert.deepEqual(
    calls[squashIndex].args.slice(calls[squashIndex].args.indexOf("--") + 1),
    [`root-file:${JSON.stringify(initial.files[0].path)}`],
  );
  assert.deepEqual(
    calls.slice(squashIndex - 2, squashIndex).map((call) => call.args[0]),
    ["log", "op"],
    "final live metadata and operation checks immediately precede the mutation",
  );
  assert.ok(!calls[squashIndex - 2].args.includes("--ignore-working-copy"));
  calls.length = 0;
  await service.getLog({ includeOutput: false });
  assert.equal(calls.length, 5);
});

test("preview reads each selected file side once, regardless of selected hunk count", async (t) => {
  const options = await fixture(t);
  const calls: string[][] = [];
  const service = new ReviewService({
    ...options,
    jjRunner: (cwd, args) => {
      calls.push(args);
      return jj(cwd, args);
    },
    toolRunner: async () => {
      throw new Error("preview must not invoke the native mutation runner");
    },
  });
  const state = await service.getState();
  for (const files of [[state.files[0]], state.files]) {
    calls.length = 0;
    const selections = files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      })),
    );
    assert.ok(selections.length > files.length);
    const preview = await service.preview({
      version: state.version,
      target: state.parent!.changeId,
      selections,
    });
    assert.ok(preview.patch);
    assert.equal(calls.length, 4 + files.length * 2);
    assert.deepEqual(
      calls.filter((args) => args[0] === "file"),
      files.flatMap((file) =>
        [state.parent!.commitId, state.source.commitId].map((revision) => [
          "file",
          "show",
          "-r",
          revision,
          "--ignore-working-copy",
          "--",
          `root-file:${JSON.stringify(file.path)}`,
        ]),
      ),
    );
    assert.ok(calls.every((args) => args[0] !== "diff"));
  }
});

for (const kind of ["added", "deleted"] as const) {
  test(`preview skips the absent side of a ${kind} file`, async (t) => {
    const options = await fixture(t);
    const filePath = kind === "added" ? "added.txt" : "src/notifications.ts";
    if (kind === "added")
      await writeFile(path.join(options.repoPath, filePath), "new file\n");
    else await rm(path.join(options.repoPath, filePath));
    const calls: string[][] = [];
    const service = new ReviewService({
      ...options,
      jjRunner: (cwd, args) => {
        calls.push(args);
        return jj(cwd, args);
      },
      toolRunner: async () => {
        throw new Error("preview must not invoke the native mutation runner");
      },
    });
    const state = await service.getState();
    const file = state.files.find((file) => file.path === filePath)!;
    assert.ok(!file.unsupported);
    calls.length = 0;
    await service.preview({
      version: state.version,
      target: state.parent!.changeId,
      selections: file.hunks.map((hunk) => ({
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      })),
    });
    assert.equal(calls.length, 5);
    assert.deepEqual(
      calls.filter((args) => args[0] === "file"),
      [
        [
          "file",
          "show",
          "-r",
          kind === "added" ? state.source.commitId : state.parent!.commitId,
          "--ignore-working-copy",
          "--",
          `root-file:${JSON.stringify(filePath)}`,
        ],
      ],
    );
  });
}
