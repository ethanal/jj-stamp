import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ApiError, ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-metadata-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createDemo(dir);
}

async function changeId(repoPath: string, revision = "@") {
  return (
    await jj(repoPath, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      revision,
      "-T",
      "change_id",
    ])
  ).stdout.trim();
}

function metadataRevset(changeIds: string[]) {
  return changeIds
    .flatMap((id) => {
      const source = `change_id(${JSON.stringify(id)})`;
      return [source, `mutable() & ::${source} ~ ${source}`, `${source}-`];
    })
    .map((revset) => `(${revset})`)
    .join(" | ");
}

/** Compare real jj output with the old global membership query, not a mock. */
function comparingRunner() {
  const reads: Array<{ revset: string; recorded: boolean }> = [];
  const runner = async (cwd: string, args: string[]) => {
    const templateIndex = args.indexOf("-T") + 1;
    const template = templateIndex ? args[templateIndex] : "";
    const result = await jj(cwd, args);
    if (args[0] !== "log" || !template.includes("conflicts()")) return result;

    const revset = args[args.indexOf("-r") + 1];
    const conflictExpression = `self.contained_in(${JSON.stringify(`(${revset}) & conflicts()`)})`;
    assert.equal(
      template.split(conflictExpression).length,
      2,
      "each metadata query scopes its one conflict flag to exactly its outer revset",
    );
    const originalArgs = [...args];
    originalArgs[templateIndex] = template.replace(
      conflictExpression,
      'self.contained_in("conflicts()")',
    );
    // The service query has already snapshotted when appropriate. The oracle
    // reads those exact recorded bytes without making another snapshot.
    if (!originalArgs.includes("--ignore-working-copy"))
      originalArgs.push("--ignore-working-copy");
    assert.equal(
      result.stdout,
      (await jj(cwd, originalArgs)).stdout,
      "scoped membership must preserve every revision field and eligibility flag",
    );
    reads.push({ revset, recorded: args.includes("--ignore-working-copy") });
    return result;
  };
  return { runner, reads };
}

test("both state, graph and two-selection metadata reads scope conflicts to the exact outer revset", async (t) => {
  const repoPath = await fixture(t);
  const { runner, reads } = comparingRunner();
  const service = new ReviewService({ repoPath, jjRunner: runner });
  const state = await service.getState();
  assert.deepEqual(
    reads,
    Array.from({ length: 2 }, () => ({
      revset: metadataRevset([state.source.changeId]),
      recorded: false,
    })),
  );
  reads.length = 0;
  const graph = await service.getLog({ includeOutput: false });
  assert.equal(graph.version, state.version);
  assert.deepEqual(
    reads,
    Array.from({ length: 2 }, () => ({
      revset: metadataRevset([state.source.changeId]),
      recorded: true,
    })),
  );
  reads.length = 0;
  const candidate = state.parent!.changeId;
  const selected = await service.selectRevision({
    version: state.version,
    changeId: candidate,
  });
  assert.equal(selected.state.source.changeId, candidate);
  assert.deepEqual(
    reads,
    Array.from({ length: 2 }, () => ({
      revset: metadataRevset([state.source.changeId, candidate]),
      recorded: false,
    })),
  );
});

async function conflictingMerge(repoPath: string, base: string) {
  await jj(repoPath, ["new", base, "-m", "Left branch"]);
  await writeFile(path.join(repoPath, "conflict.txt"), "left\n");
  await jj(repoPath, ["status"]);
  const left = await changeId(repoPath);
  await jj(repoPath, ["new", base, "-m", "Right branch"]);
  await writeFile(path.join(repoPath, "conflict.txt"), "right\n");
  await jj(repoPath, ["new", left, "@", "-m", "Conflicted merge"]);
  return changeId(repoPath);
}

for (const scenario of ["source", "parent", "unrelated"] as const) {
  test(`scoped metadata matches global membership with a conflicted ${scenario}`, async (t) => {
    const repoPath = await fixture(t);
    const clean = await changeId(repoPath);
    const conflicted = await conflictingMerge(repoPath, clean);
    if (scenario === "parent") {
      await jj(repoPath, ["new", "-m", "Resolved child"]);
      await writeFile(path.join(repoPath, "conflict.txt"), "resolved\n");
      await jj(repoPath, ["status"]);
    }
    const { runner, reads } = comparingRunner();
    const service = new ReviewService({
      repoPath,
      jjRunner: runner,
      revision: scenario === "unrelated" ? clean : "@",
    });
    if (scenario === "source") {
      await assert.rejects(
        service.getState(),
        (error: unknown) =>
          error instanceof ApiError && error.code === "CONFLICTED_SOURCE",
      );
    } else {
      const state = await service.getState();
      assert.equal(reads.length, 2);
      assert.ok(
        !state.targets.some((target) => target.changeId === conflicted),
      );
      if (scenario === "parent") {
        assert.equal(state.parent, null);
        assert.match(state.squashUnavailable!, /parent contains conflicts/);
      } else {
        assert.equal(state.source.changeId, clean);
        assert.ok(state.parent);
      }
    }
    reads.length = 0;
    assert.ok((await service.getLog({ includeOutput: false })).rows.length);
    assert.equal(
      reads.length,
      2,
      "even conflicted-source graph reads validate twice",
    );
  });
}

test("scoped membership preserves custom conflicts() aliases", async (t) => {
  const repoPath = await fixture(t);
  const source = await changeId(repoPath);
  const parent = await changeId(repoPath, "@-");
  for (const alias of [
    "all()",
    "none()",
    `change_id("${source}")`,
    `change_id("${parent}")`,
  ]) {
    await t.test(alias, async () => {
      await jj(repoPath, [
        "config",
        "set",
        "--repo",
        'revset-aliases."conflicts()"',
        alias,
      ]);
      const { runner, reads } = comparingRunner();
      const service = new ReviewService({ repoPath, jjRunner: runner });
      const graph = await service.getLog({ includeOutput: false });
      assert.ok(graph.rows.length);
      assert.equal(reads.length, 2);
      reads.length = 0;
      if (alias === "all()" || alias.includes(source)) {
        await assert.rejects(
          service.getState(),
          (error: unknown) =>
            error instanceof ApiError && error.code === "CONFLICTED_SOURCE",
        );
      } else {
        const state = await service.getState();
        assert.equal(reads.length, 2);
        if (alias.includes(parent)) {
          assert.equal(state.parent, null);
          assert.match(state.squashUnavailable!, /parent contains conflicts/);
        } else assert.equal(state.parent!.changeId, parent);
      }
    });
  }
});

test("metadata and graph keep the configured broad distinguishing-prefix scope", async (t) => {
  const repoPath = await fixture(t);
  const original = await changeId(repoPath);
  // Seventeen distinct IDs guarantee a shared first digit in jj's sixteen-
  // digit alphabet. Other authors' branches are outside the review graph.
  const byFirstDigit = new Map<string, string>();
  let selected = "",
    collision = "";
  for (let i = 0; i < 17; i++) {
    await jj(repoPath, [
      "new",
      "root()",
      "-m",
      `Prefix branch ${i}`,
      "--config",
      'user.email="someone-else@example.com"',
    ]);
    const id = await changeId(repoPath);
    const earlier = byFirstDigit.get(id[0]);
    if (earlier) {
      selected = earlier;
      collision = id;
      break;
    }
    byFirstDigit.set(id[0], id);
  }
  assert.ok(selected && collision);
  await jj(repoPath, ["edit", original]);
  await jj(repoPath, ["config", "set", "--repo", "revsets.log", "root()"]);
  await jj(repoPath, [
    "config",
    "set",
    "--repo",
    "revsets.short-prefixes",
    "all()",
  ]);
  const { runner } = comparingRunner();
  const service = new ReviewService({
    repoPath,
    revision: selected,
    jjRunner: runner,
  });
  const state = await service.getState();
  const graph = await service.getLog({ includeOutput: false });
  assert.equal(graph.version, state.version);
  assert.ok(state.source.changeIdPrefix!.length > 1);
  assert.ok(!graph.rows.some((row) => row.revision?.changeId === collision));
  const expected = new Map(
    (
      await jj(repoPath, [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "all()",
        "-T",
        'json(commit_id) ++ "\\t" ++ json(change_id.shortest(8).prefix()) ++ "\\n"',
      ])
    ).stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [id, prefix] = line
          .split("\t")
          .map((field) => JSON.parse(field) as string);
        return [id, prefix] as const;
      }),
  );
  for (const revision of [
    state.source,
    ...state.targets,
    ...(state.parent ? [state.parent] : []),
    ...graph.rows.flatMap((row) => (row.revision ? [row.revision] : [])),
  ]) {
    assert.equal(
      revision.changeIdPrefix,
      expected.get(revision.commitId),
      "prefixes must agree with recorded jj output under the original configuration",
    );
  }
});
