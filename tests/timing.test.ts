import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import {
  ServiceTiming,
  jjTimingName,
  toolTimingName,
  type OperationTiming,
} from "../server/timing.ts";
import { createDemo } from "./fixtures.ts";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-timing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return await createDemo(directory);
}

function checkRecord(record: OperationTiming) {
  assert.deepEqual(Object.keys(record).sort(), [
    "durationMs",
    "id",
    "name",
    "ok",
    "queueMs",
    "subprocesses",
  ]);
  assert.ok(record.queueMs >= 0);
  assert.ok(record.durationMs >= 0);
  for (const subprocess of record.subprocesses) {
    assert.deepEqual(Object.keys(subprocess).sort(), [
      "durationMs",
      "name",
      "ok",
      "startMs",
    ]);
    assert.ok(subprocess.startMs >= 0);
    assert.ok(subprocess.durationMs >= 0);
    assert.ok(
      subprocess.startMs + subprocess.durationMs <=
        record.durationMs + 0.000001,
    );
  }
}

test("timing separates queue wait, execution and observer time; subprocesses keep invocation order", async () => {
  let clock = 0;
  const records: OperationTiming[] = [];
  const timing = new ServiceTiming(
    (record) => {
      records.push(record);
      clock += 100; // Observer time belongs to neither this task nor its children.
    },
    () => clock,
  );
  const firstChild = deferred();
  const secondChild = deferred();
  const first = timing.wrap(
    () => firstChild.promise,
    () => "first",
  );
  const second = timing.wrap(
    () => secondChild.promise,
    () => "second",
  );
  const task1 = timing.task("state", async () => {
    clock = 12;
    const a = first();
    clock = 15;
    const b = second();
    clock = 18;
    secondChild.resolve();
    await b;
    clock = 21;
    firstChild.resolve();
    await a;
    clock = 25;
    return "result";
  });
  clock = 3;
  const task2 = timing.task("graph", async () => {
    clock += 5;
    return 42;
  });
  clock = 10;
  assert.equal(await task1(), "result");
  assert.equal(await task2(), 42);
  assert.deepEqual(records, [
    {
      id: 1,
      name: "state",
      queueMs: 10,
      durationMs: 15,
      ok: true,
      subprocesses: [
        { name: "first", startMs: 2, durationMs: 9, ok: true },
        { name: "second", startMs: 5, durationMs: 3, ok: true },
      ],
    },
    {
      id: 2,
      name: "graph",
      queueMs: 122,
      durationMs: 5,
      ok: true,
      subprocesses: [],
    },
  ]);
});

test("runner wrappers preserve receiver, argument and result identity, sync throws and rejection identity", async () => {
  const records: OperationTiming[] = [];
  const timing = new ServiceTiming((record) => records.push(record));
  const argument = ["private argument"];
  const result = { stdout: "private output", stderr: "private diagnostic" };
  const receiver = { marker: "receiver" };
  const failure = new Error("private failure");
  const wrapped = timing.wrap(
    function (this: unknown, value: string[]) {
      assert.equal(this, receiver);
      assert.equal(value, argument);
      return Promise.resolve(result);
    },
    () => "jj",
  );
  const synchronous = timing.wrap(
    (): Promise<void> => {
      throw failure;
    },
    () => "sync",
  );
  const rejected = timing.wrap(
    () => Promise.reject(failure),
    () => "async",
  );
  await timing.task("state", async () => {
    assert.equal(await wrapped.call(receiver, argument), result);
    assert.throws(
      () => synchronous(),
      (error) => error === failure,
    );
    await assert.rejects(rejected(), (error) => error === failure);
  })();
  assert.deepEqual(
    records[0].subprocesses.map(({ ok }) => ok),
    [true, false, false],
  );
  assert.equal(
    records[0].ok,
    true,
    "handled child errors do not fail the operation",
  );
  checkRecord(records[0]);
  assert.doesNotMatch(JSON.stringify(records), /private|receiver/);
});

test("subprocess classifications only expose allowlisted command labels", () => {
  for (const command of ["root", "diff", "status"])
    assert.equal(jjTimingName([command, "private"]), `jj ${command}`);
  assert.equal(jjTimingName(["op", "log", "private"]), "jj op log");
  assert.equal(jjTimingName(["op", "revert", "private"]), "jj op revert");
  assert.equal(jjTimingName(["file", "show", "private"]), "jj file show");
  assert.equal(
    toolTimingName(["squash", "--from", "private", "--tool", "jj-stamp"]),
    "jj squash (native editor)",
  );
  for (const command of ["hunks", "patch"])
    assert.equal(toolTimingName([command, "private"]), "jj");
  assert.equal(
    jjTimingName(["log", "--no-graph", "-r", "private"]),
    "jj log metadata (snapshot)",
  );
  assert.equal(
    jjTimingName([
      "log",
      "--no-graph",
      "--ignore-working-copy",
      "-r",
      "private",
    ]),
    "jj log metadata (recorded)",
  );
  assert.equal(
    jjTimingName(["log", "--at-operation", "private"]),
    "jj log graph (pinned)",
  );
  assert.equal(
    jjTimingName(["log", "--no-graph", "-r", "conflicts()"]),
    "jj log conflicts (snapshot)",
  );
  assert.equal(
    jjTimingName([
      "log",
      "--no-graph",
      "-r",
      "conflicts()",
      "--ignore-working-copy",
    ]),
    "jj log conflicts (recorded)",
  );
  assert.equal(jjTimingName(["private"]), "jj");
  assert.equal(jjTimingName(["op", "private"]), "jj");
  assert.equal(toolTimingName(["private"]), "jj");
});

test("queued operations retain their own subprocesses and wait for failed parallel reads to drain", async (t) => {
  const repoPath = await fixture(t);
  const records: OperationTiming[] = [];
  const started = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const failure = new Error("private operation read failure");
  let fail = true;
  const service = new ReviewService({
    repoPath,
    onTiming: (record) => records.push(record),
    jjRunner: async (cwd, args) => {
      if (args[0] === "op" && fail) {
        fail = false;
        throw failure;
      }
      if (args[0] === "diff") {
        started.resolve();
        await release.promise;
      }
      return jj(cwd, args);
    },
  });
  const failed = assert.rejects(
    service.getState(),
    (error) => error === failure,
  );
  await started.promise;
  const next = service.getState();
  let drained = false;
  const draining = service.drain().then(() => {
    drained = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  assert.equal(
    records.length,
    0,
    "no partial record is emitted while children run",
  );
  release.resolve();
  await Promise.all([failed, next, draining]);
  assert.equal(drained, true);
  assert.deepEqual(
    records.map(({ id, name, ok }) => ({ id, name, ok })),
    [
      { id: 1, name: "state", ok: false },
      { id: 2, name: "state", ok: true },
    ],
  );
  assert.equal(records[0].subprocesses.length, 5);
  assert.equal(records[1].subprocesses.length, 4);
  assert.equal(
    records[0].subprocesses.find((child) => child.name === "jj op log")!.ok,
    false,
  );
  assert.equal(records[0].subprocesses.at(-1)!.name, "jj diff");
  assert.ok(records[1].queueMs > 0);
  for (const record of records) checkRecord(record);
});

for (const asyncObserver of [false, true]) {
  test(`${asyncObserver ? "rejecting" : "throwing"} observers cannot change reads, squash attribution, undo or errors`, async (t) => {
    const repoPath = await fixture(t);
    const records: OperationTiming[] = [];
    const failure = new Error("private observer error");
    let editorCalls = 0;
    const service = new ReviewService({
      repoPath,
      onTiming: (record) => {
        records.push(record);
        if (asyncObserver) return Promise.reject(failure);
        throw failure;
      },
      editorRunner: async (command, args, cwd) => {
        assert.equal(command, "nvim");
        assert.equal(cwd, repoPath);
        assert.equal(args[0], "--server");
        editorCalls++;
        return { stdout: "1\n", stderr: "private editor output" };
      },
    });
    const state = await service.getState();
    assert.equal(
      records[0].subprocesses.length,
      7,
      "startup is captured without extra subprocesses",
    );
    await service.getLog({ includeOutput: false });
    await service.getLog();
    await service.getFile({
      version: state.version,
      path: state.files[0].path,
    });
    await service.openEditor({
      version: state.version,
      path: state.files[0].path,
      line: 1,
    });
    assert.equal(editorCalls, 1);
    const hunk = state.files[0].hunks[0];
    const selections = [
      {
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      },
    ];
    const preview = await service.preview({
      version: state.version,
      target: state.parent!.changeId,
      selections,
    });
    const squashed = await service.squash(preview.token);
    assert.equal(squashed.state.canUndo, true);
    const undone = await service.undo(squashed.state.version);
    assert.deepEqual(undone.state.files, state.files);
    const other = undone.state.files[0].hunks[1];
    const lines = await service.squashLines({
      version: undone.state.version,
      selections: [
        {
          id: other.id,
          lines: other.rows
            .filter((row) => /^[+-]/.test(row.raw))
            .map((row) => row.index),
        },
      ],
    });
    assert.equal(lines.state.canUndo, true);
    const restored = await service.undo(lines.state.version);
    await service.selectRevision({
      version: restored.state.version,
      changeId: restored.state.source.changeId,
    });
    await assert.rejects(service.squash("private missing token"), {
      code: "STALE_PREVIEW",
    });
    assert.equal(
      (await service.getState()).source.commitId,
      state.source.commitId,
    );
    await service.drain();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(
      records.map(({ name }) => name),
      [
        "state",
        "graph",
        "log",
        "file",
        "editor",
        "preview",
        "squash",
        "undo",
        "squash-lines",
        "undo",
        "revision",
        "squash",
        "state",
      ],
    );
    assert.equal(records[11].ok, false);
    assert.deepEqual(records[11].subprocesses, []);
    assert.equal(records[4].subprocesses.at(-1)!.name, "nvim");
    assert.ok(
      records[3].subprocesses.some(({ name }) => name === "jj file show"),
    );
    assert.ok(
      records[6].subprocesses.some(
        ({ name }) => name === "jj squash (native editor)",
      ),
    );
    assert.ok(
      records[7].subprocesses.some(({ name }) => name === "jj op revert"),
    );
    for (const record of records) checkRecord(record);
    const serialized = JSON.stringify(records);
    for (const secret of [
      repoPath,
      state.source.changeId,
      state.source.commitId,
      state.source.description,
      state.files[0].path,
      preview.token,
      "private",
    ])
      assert.equal(
        serialized.includes(secret),
        false,
        `trace excludes ${secret}`,
      );
  });
}

test("startup errors are recorded, memoized and returned unchanged even when observers fail", async () => {
  const records: OperationTiming[] = [];
  const failure = new Error("private startup failure");
  let calls = 0;
  const service = new ReviewService({
    repoPath: "/private/repository",
    jjRunner: () => {
      calls++;
      throw failure;
    },
    onTiming: (record) => {
      records.push(record);
      throw new Error("observer");
    },
  });
  await assert.rejects(service.getState(), (error) => error === failure);
  await assert.rejects(service.getState(), (error) => error === failure);
  assert.equal(calls, 1);
  assert.deepEqual(
    records.map(({ ok }) => ok),
    [false, false],
  );
  assert.equal(records[0].subprocesses[0].name, "jj root");
  assert.equal(records[0].subprocesses[0].ok, false);
  assert.deepEqual(records[1].subprocesses, []);
});
