import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { ApiError, ReviewService, type State } from "../server/service.ts";
import { jj, ProcessOutputLimitError, run } from "../server/process.ts";

const revision = (changeId: string) => `change_id("${changeId}")`;

async function valueAt(root: string, rev: string, template: string) {
  return (
    await jj(root, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      rev,
      "-T",
      template,
    ])
  ).stdout.trim();
}

async function fileAt(root: string, changeId: string) {
  return (
    await jj(root, [
      "file",
      "show",
      "--ignore-working-copy",
      "-r",
      revision(changeId),
      "a.txt",
    ])
  ).stdout;
}

async function fixture(t: TestContext, adjacent = false) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-descendant-squash-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await jj(root, ["git", "init", "--no-colocate"]);
  await jj(root, ["config", "set", "--repo", "user.name", "Descendant Test"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "descendant@example.com",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  const base = Array.from({ length: 60 }, (_, i) => `line ${i + 1}\n`).join("");
  await writeFile(path.join(root, "a.txt"), base);
  await jj(root, ["commit", "-m", "Base"]);
  const baseId = await valueAt(root, "@-", "change_id");
  const source = base
    .replace(
      "line 1\n",
      `line 1\nselected addition\n${adjacent ? "unselected addition\n" : ""}`,
    )
    .replace("line 15\n", `line 15\n${adjacent ? "" : "unselected addition\n"}`)
    .replace("line 60\n", "unselected tail\n");
  await writeFile(path.join(root, "a.txt"), source);
  await jj(root, ["commit", "-m", "Source"]);
  const sourceId = await valueAt(root, "@-", "change_id");
  const middle = source.replace("line 30\n", "intermediate edit\n");
  await writeFile(path.join(root, "a.txt"), middle);
  await jj(root, ["commit", "-m", "Immediate descendant"]);
  const middleId = await valueAt(root, "@-", "change_id");
  const destination = middle.replace("line 45\n", "destination edit\n");
  await writeFile(path.join(root, "a.txt"), destination);
  await jj(root, ["describe", "-m", "Deep descendant destination"]);
  const destinationId = await valueAt(root, "@", "change_id");
  const service = new ReviewService({ repoPath: root, revision: sourceId });
  const state = await service.getState();
  const ids = [baseId, sourceId, middleId, destinationId];
  const commits = await Promise.all(
    ids.map((id) => valueAt(root, revision(id), "commit_id")),
  );
  return {
    root,
    base,
    source,
    middle,
    destination,
    baseId,
    sourceId,
    middleId,
    destinationId,
    ids,
    commits,
    service,
    state,
  };
}

function input(state: State, target: string, all = false) {
  const selections = state.files.flatMap((file) =>
    file.hunks.flatMap((hunk) => {
      const lines = hunk.rows
        .filter((row) =>
          all ? /^[+-]/.test(row.raw) : row.raw === "+selected addition",
        )
        .map((row) => row.index);
      return lines.length ? [{ id: hunk.id, lines }] : [];
    }),
  );
  assert.ok(selections.length, "fixture must have selectable source rows");
  return { version: state.version, target, selections };
}

const rejectsCode = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );

async function squash(
  service: ReviewService,
  api: "direct" | "legacy",
  selection: ReturnType<typeof input>,
) {
  if (api === "direct") return service.squashLines(selection);
  const preview = await service.preview(selection);
  assert.ok(preview.patch.includes("+selected addition"));
  return service.squash(preview.token);
}

async function assertExactUndo(
  f: Awaited<ReturnType<typeof fixture>>,
  service: ReviewService,
  before: State,
  after: State,
) {
  const undone = await service.undo(after.version);
  assert.equal(undone.state.canUndo, false);
  assert.deepEqual(undone.state.source, before.source);
  assert.deepEqual(undone.state.parent, before.parent);
  assert.deepEqual(undone.state.targets, before.targets);
  assert.deepEqual(undone.state.files, before.files);
  assert.deepEqual(
    await Promise.all(
      f.ids.map((id) => valueAt(f.root, revision(id), "commit_id")),
    ),
    f.commits,
    "undo must restore every rewritten revision's exact commit identity",
  );
  assert.equal(
    await readFile(path.join(f.root, "a.txt"), "utf8"),
    f.destination,
  );
  assert.equal(await valueAt(f.root, "@", "change_id"), f.destinationId);
}

for (const api of ["direct", "legacy"] as const) {
  for (const depth of ["immediate", "deeper"] as const) {
    test(`${api} selected rows squash into ${depth} descendant with exact deltas, workspace and undo`, async (t) => {
      const f = await fixture(t);
      const targetId = depth === "immediate" ? f.middleId : f.destinationId;
      assert.ok(f.state.targets.some((target) => target.changeId === targetId));
      assert.ok(
        !f.state.targets.some(
          (target) => target.changeId === f.state.source.changeId,
        ),
        "the source must never be its own destination",
      );
      const target = f.state.targets.find(
        (entry) => entry.changeId === targetId,
      )!;
      const result = await squash(f.service, api, input(f.state, targetId));
      assert.equal(result.warning, undefined);
      assert.equal(result.state.source.changeId, f.sourceId);
      assert.equal(result.state.parent!.changeId, f.baseId);
      assert.equal(result.state.canUndo, true);
      assert.notEqual(
        result.state.targets.find((entry) => entry.changeId === targetId)!
          .commitId,
        target.commitId,
      );
      assert.equal(await fileAt(f.root, f.baseId), f.base);
      assert.equal(
        await fileAt(f.root, f.sourceId),
        f.source.replace("selected addition\n", ""),
        "remove only the selected source row, not the unselected rows",
      );
      assert.equal(
        await fileAt(f.root, f.middleId),
        depth === "immediate"
          ? f.middle
          : f.middle.replace("selected addition\n", ""),
        "intervening descendants retain their own delta without the moved row",
      );
      assert.equal(await fileAt(f.root, f.destinationId), f.destination);
      assert.equal(
        await readFile(path.join(f.root, "a.txt"), "utf8"),
        f.destination,
        "the workspace at the deeper descendant must be byte-for-byte unchanged",
      );
      assert.equal(await valueAt(f.root, "@", "change_id"), f.destinationId);
      const targetDiff = (
        await jj(f.root, [
          "diff",
          "--ignore-working-copy",
          "--git",
          "-r",
          revision(targetId),
        ])
      ).stdout;
      assert.ok(targetDiff.includes("+selected addition"));
      assert.ok(!targetDiff.includes("+unselected addition"));
      assert.ok(!targetDiff.includes("+unselected tail"));
      assert.ok(
        targetDiff.includes(
          depth === "immediate" ? "+intermediate edit" : "+destination edit",
        ),
        "the destination's own delta survives",
      );
      const retainedRows = result.state.files.flatMap((file) =>
        file.hunks.flatMap((hunk) => hunk.rows.map((row) => row.raw)),
      );
      assert.ok(!retainedRows.includes("+selected addition"));
      assert.ok(retainedRows.includes("+unselected addition"));
      assert.ok(retainedRows.includes("+unselected tail"));
      await assertExactUndo(f, f.service, f.state, result.state);
    });
  }

  test(`${api} all source rows squash into a descendant while keeping the emptied source and exact undo`, async (t) => {
    const f = await fixture(t);
    const result = await squash(
      f.service,
      api,
      input(f.state, f.destinationId, true),
    );
    assert.equal(result.warning, undefined);
    assert.equal(result.state.source.changeId, f.sourceId);
    assert.equal(
      await valueAt(f.root, revision(f.sourceId), "empty"),
      "true",
      "keep-emptied must preserve the selected source revision",
    );
    assert.equal(result.state.files.length, 0);
    assert.equal(await fileAt(f.root, f.sourceId), f.base);
    assert.equal(
      await fileAt(f.root, f.middleId),
      f.base.replace("line 30\n", "intermediate edit\n"),
    );
    assert.equal(await fileAt(f.root, f.destinationId), f.destination);
    assert.equal(
      await readFile(path.join(f.root, "a.txt"), "utf8"),
      f.destination,
    );
    await assertExactUndo(f, f.service, f.state, result.state);
  });

  test(`${api} adjacent selected and unselected rows moved forward warn about conflicts and undo exactly`, async (t) => {
    // Moving only half of a contiguous insertion forward makes jj merge the
    // selected row against the retained neighboring row. This can conflict
    // even though the descendants' own edits are elsewhere in the file.
    const f = await fixture(t, true);
    const result = await squash(
      f.service,
      api,
      input(f.state, f.destinationId),
    );
    assert.match(result.warning!, /created a conflict/);
    assert.equal(result.state.source.changeId, f.sourceId);
    assert.equal(result.state.canUndo, true);
    assert.match(
      await fileAt(f.root, f.sourceId),
      /<<<<<<< conflict 1 of 1/,
      "jj can conflict while removing one row from a contiguous source insertion",
    );
    const conflicted = (
      await valueAt(f.root, "conflicts()", 'change_id ++ "\\n"')
    ).split("\n");
    assert.ok(
      conflicted.includes(f.sourceId),
      "the warning must correspond to a real newly conflicted source",
    );
    assert.ok(
      result.state.squashUnavailable,
      "a newly conflicted source remains reviewable but is read-only",
    );
    await rejectsCode(
      squash(f.service, api, {
        ...input(f.state, f.destinationId),
        version: result.state.version,
      }),
      "SQUASH_UNAVAILABLE",
    );
    assert.equal(
      (await f.service.getState()).operation,
      result.state.operation,
      "rejecting a conflicted source must not mutate or consume undo",
    );
    await assertExactUndo(f, f.service, f.state, result.state);
    assert.equal(
      await valueAt(f.root, "conflicts()", 'change_id ++ "\\n"'),
      "",
    );
  });

  test(`${api} immutable immediate parent does not block an explicit mutable descendant destination`, async (t) => {
    const f = await fixture(t);
    await jj(f.root, [
      "config",
      "set",
      "--repo",
      'revset-aliases."immutable_heads()"',
      revision(f.baseId),
    ]);
    const state = await f.service.getState();
    assert.equal(state.parent, null);
    assert.equal(state.squashUnavailable, undefined);
    assert.ok(
      state.targets.some((target) => target.changeId === f.destinationId),
    );
    assert.ok(!state.targets.some((target) => target.changeId === f.baseId));
    const { target: _target, ...withoutTarget } = input(state, f.destinationId);
    await rejectsCode(
      f.service.squashLines(withoutTarget),
      "SQUASH_UNAVAILABLE",
    );
    assert.equal((await f.service.getState()).operation, state.operation);
    const result = await squash(f.service, api, input(state, f.destinationId));
    assert.equal(result.warning, undefined);
    assert.equal(result.state.parent, null);
    assert.equal(
      await fileAt(f.root, f.sourceId),
      f.source.replace("selected addition\n", ""),
    );
    assert.equal(await fileAt(f.root, f.destinationId), f.destination);
    await assertExactUndo(f, f.service, state, result.state);
  });

  test(`${api} config-only descendant conflict eligibility race rejects before mutation`, async (t) => {
    const f = await fixture(t);
    let armed = false;
    let injected = false;
    let mutations = 0;
    const service = new ReviewService({
      repoPath: f.root,
      revision: f.sourceId,
      jjRunner: async (cwd, args) => {
        const result = await jj(cwd, args);
        if (armed && !injected && args[0] === "file" && args[1] === "show") {
          injected = true;
          await jj(f.root, [
            "config",
            "set",
            "--repo",
            'revset-aliases."conflicts()"',
            revision(f.destinationId),
          ]);
        }
        return result;
      },
      toolRunner: async (command, args, cwd) => {
        mutations++;
        return run(command, args, cwd);
      },
    });
    const state = await service.getState();
    armed = true;
    await rejectsCode(
      squash(service, api, input(state, f.destinationId)),
      "STALE_STATE",
    );
    assert.equal(injected, true);
    assert.equal(mutations, 0);
    const current = await service.getState();
    assert.equal(
      current.operation,
      state.operation,
      "a configuration-only eligibility change has no jj operation",
    );
    assert.notEqual(current.version, state.version);
    assert.ok(
      !current.targets.some((target) => target.changeId === f.destinationId),
    );
    assert.ok(
      current.targets.some((target) => target.changeId === f.middleId),
      "an excluded descendant must not exclude other valid descendants",
    );
    await rejectsCode(
      squash(service, api, input(current, f.destinationId)),
      "INVALID_TARGET",
    );
    assert.equal(mutations, 0);
    assert.equal(await fileAt(f.root, f.sourceId), f.source);
    assert.equal(
      await readFile(path.join(f.root, "a.txt"), "utf8"),
      f.destination,
    );
  });
}

const forwardConeQuery = (args: string[]) =>
  args[0] === "log" &&
  args.includes('json(change_id) ++ "\\t" ++ json(commit_id) ++ "\\n"');

for (const api of ["direct", "legacy"] as const) {
  for (const failure of [
    "129 commits",
    "output limit",
    "query failure",
  ] as const) {
    test(`${api} forward cone ${failure} fails before any mutation`, async (t) => {
      const f = await fixture(t);
      let armed = false;
      let reads = 0;
      let mutations = 0;
      const readFailure = new Error("Injected forward cone read failure.");
      const target = f.state.targets.find(
        (entry) => entry.changeId === f.destinationId,
      )!;
      const service = new ReviewService({
        repoPath: f.root,
        revision: f.sourceId,
        jjRunner: async (cwd, args, limits) => {
          if (armed && forwardConeQuery(args)) {
            reads++;
            if (failure === "output limit") throw new ProcessOutputLimitError();
            if (failure === "query failure") throw readFailure;
            const alphabet = "klmnopqrstuvwxyz";
            return {
              stdout: Array.from({ length: 129 }, (_, i) => {
                if (i === 0)
                  return `${JSON.stringify(target.changeId)}\t${JSON.stringify(target.commitId)}\n`;
                const changeId = i
                  .toString(16)
                  .padStart(32, "0")
                  .replace(
                    /[0-9a-f]/g,
                    (digit) => alphabet[parseInt(digit, 16)],
                  );
                const commitId = i.toString(16).padStart(40, "0");
                return `${JSON.stringify(changeId)}\t${JSON.stringify(commitId)}\n`;
              }).join(""),
              stderr: "",
            };
          }
          return jj(cwd, args, limits);
        },
        toolRunner: async (command, args, cwd) => {
          mutations++;
          return run(command, args, cwd);
        },
      });
      const before = await service.getState();
      armed = true;
      await assert.rejects(
        squash(service, api, input(before, f.destinationId)),
        (error: unknown) => {
          if (failure === "query failure") return error === readFailure;
          assert.ok(error instanceof ApiError);
          assert.equal(error.status, 422);
          assert.equal(error.code, "UNSAFE_PREVIEW");
          return true;
        },
      );
      assert.equal(reads, 1);
      assert.equal(mutations, 0);
      armed = false;
      const current = await service.getState();
      assert.equal(current.operation, before.operation);
      assert.equal(current.version, before.version);
      assert.equal(current.canUndo, false);
      assert.deepEqual(current.source, before.source);
      assert.deepEqual(current.targets, before.targets);
      assert.deepEqual(current.files, before.files);
      assert.deepEqual(
        await Promise.all(
          f.ids.map((id) => valueAt(f.root, revision(id), "commit_id")),
        ),
        f.commits,
      );
      assert.equal(
        await readFile(path.join(f.root, "a.txt"), "utf8"),
        f.destination,
      );
      await rejectsCode(
        service.squashLines(input(current, current.source.changeId)),
        "INVALID_TARGET",
      );
      assert.equal(mutations, 0);
    });
  }

  test(`${api} failed forward conservation read after attribution reports completion and disables undo`, async (t) => {
    const f = await fixture(t);
    let armed = false;
    let reads = 0;
    let mutations = 0;
    const service = new ReviewService({
      repoPath: f.root,
      revision: f.sourceId,
      jjRunner: async (cwd, args, limits) => {
        if (armed && forwardConeQuery(args) && ++reads === 2)
          throw new Error("Injected post-squash forward cone read failure.");
        return jj(cwd, args, limits);
      },
      toolRunner: async (command, args, cwd) => {
        mutations++;
        return run(command, args, cwd);
      },
    });
    const before = await service.getState();
    armed = true;
    await assert.rejects(
      squash(service, api, input(before, f.destinationId)),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "HISTORY_CHANGED");
        assert.match(error.message, /completed and was attributed/);
        assert.ok(error.details?.completedOperation);
        assert.equal(error.details?.pending, undefined);
        return true;
      },
    );
    assert.equal(reads, 2);
    assert.equal(mutations, 1, "a completed squash must never be replayed");
    armed = false;
    const current = await service.getState();
    assert.notEqual(current.operation, before.operation);
    assert.equal(current.canUndo, false);
    assert.equal(current.source.changeId, before.source.changeId);
    assert.equal(
      await fileAt(f.root, f.sourceId),
      f.source.replace("selected addition\n", ""),
      "the attributed squash remains completed despite the failed post-read",
    );
    assert.equal(
      await readFile(path.join(f.root, "a.txt"), "utf8"),
      f.destination,
    );
    await rejectsCode(service.undo(current.version), "UNDO_UNAVAILABLE");
    await rejectsCode(
      service.squashLines(input(current, current.source.changeId, true)),
      "INVALID_TARGET",
    );
    assert.equal(mutations, 1, "no pending guard, retry or rollback remains");
  });
}

test("a divergent descendant is not a destination and never falls back to Parent", async (t) => {
  const f = await fixture(t);
  const target = f.state.targets.find(
    (entry) => entry.changeId === f.destinationId,
  )!;
  await jj(f.root, [
    "describe",
    "-r",
    revision(f.destinationId),
    "-m",
    "First descendant rewrite",
  ]);
  await jj(f.root, [
    "--at-operation",
    f.state.operation,
    "describe",
    "-r",
    `commit_id("${target.commitId}")`,
    "-m",
    "Concurrent descendant rewrite",
  ]);
  await jj(f.root, ["status"]);
  assert.equal(
    (
      await valueAt(f.root, revision(f.destinationId), 'commit_id ++ "\\n"')
    ).split("\n").length,
    2,
  );
  const current = await f.service.getState();
  assert.equal(current.source.commitId, f.state.source.commitId);
  assert.ok(current.parent);
  assert.ok(
    !current.targets.some((entry) => entry.changeId === f.destinationId),
  );
  for (const api of ["direct", "legacy"] as const)
    await rejectsCode(
      squash(f.service, api, input(current, f.destinationId)),
      "INVALID_TARGET",
    );
  assert.equal((await f.service.getState()).operation, current.operation);
  assert.equal(await fileAt(f.root, f.sourceId), f.source);
});

for (const api of ["direct", "legacy"] as const) {
  for (const deletionAt of ["later descendant", "destination"] as const)
    test(`${api} detects any native content drift past a deletion at the ${deletionAt} and undoes exactly`, async (t) => {
      const root = await mkdtemp(
        path.join(os.tmpdir(), "jj-stamp-descendant-deletion-"),
      );
      t.after(() => rm(root, { recursive: true, force: true }));
      await jj(root, ["git", "init", "--no-colocate"]);
      await jj(root, ["config", "set", "--repo", "user.name", "Deletion Test"]);
      await jj(root, [
        "config",
        "set",
        "--repo",
        "user.email",
        "deletion@example.com",
      ]);
      await jj(root, [
        "config",
        "set",
        "--repo",
        'revset-aliases."immutable_heads()"',
        "root()",
      ]);
      // jj 0.45.1 can silently resurrect a deleted file when moving its addition
      // forward. Cover both the target itself and a target's later descendant,
      // while accepting conserved contents if a future jj fixes this bug.
      const introduced = "selected addition\n";
      const destinationBytes = "destination contents\n";
      await writeFile(path.join(root, "a.txt"), introduced);
      await jj(root, ["commit", "-m", "A introduces a"]);
      const sourceId = await valueAt(root, "@-", "change_id");
      if (deletionAt === "later descendant") {
        await writeFile(path.join(root, "b.txt"), destinationBytes);
        await jj(root, ["commit", "-m", "B introduces b"]);
        await rm(path.join(root, "a.txt"));
        await jj(root, ["describe", "-m", "C deletes a"]);
      } else {
        await rm(path.join(root, "a.txt"));
        await jj(root, ["commit", "-m", "B deletes a"]);
        await writeFile(path.join(root, "b.txt"), destinationBytes);
        await jj(root, ["describe", "-m", "C destination introduces b"]);
      }
      const middleId = await valueAt(root, "@-", "change_id");
      const workspaceId = await valueAt(root, "@", "change_id");
      const targetId =
        deletionAt === "later descendant" ? middleId : workspaceId;
      let squashCalls = 0;
      const conservationDiffs: string[] = [];
      const service = new ReviewService({
        repoPath: root,
        revision: sourceId,
        jjRunner: async (cwd, args, limits) => {
          const result = await jj(cwd, args, limits);
          if (
            args[0] === "diff" &&
            args.includes("--from") &&
            args.includes("--to") &&
            args.includes("--summary")
          )
            conservationDiffs.push(result.stdout);
          return result;
        },
        toolRunner: async (command, args, cwd) => {
          if (args.includes("squash")) squashCalls++;
          return run(command, args, cwd);
        },
      });
      const before = await service.getState();
      const ids = [sourceId, middleId, workspaceId];
      const commits = await Promise.all(
        ids.map((id) => valueAt(root, revision(id), "commit_id")),
      );
      assert.ok(before.targets.some((target) => target.changeId === targetId));
      assert.deepEqual((await readdir(root)).sort(), [".jj", "b.txt"]);
      const result = await squash(service, api, input(before, targetId, true));
      assert.equal(result.state.canUndo, true);
      assert.equal(result.state.source.changeId, sourceId);
      assert.equal(await valueAt(root, revision(sourceId), "empty"), "true");
      assert.equal(result.state.files.length, 0);
      assert.equal(
        await valueAt(root, "conflicts()", 'change_id ++ "\\n"'),
        "",
        "a conservation warning must not depend on a jj conflict",
      );
      assert.equal(
        conservationDiffs.length,
        deletionAt === "later descendant" ? 2 : 1,
        "compare every destination/descendant tree even when jj conserves contents",
      );
      if ((await readdir(root)).includes("a.txt")) {
        assert.match(
          result.warning!,
          /changed existing destination or descendant contents/,
        );
        assert.match(result.warning!, /undo/i);
        assert.ok(conservationDiffs.some((diff) => diff.trim()));
        assert.equal(await fileAt(root, workspaceId), introduced);
        assert.equal(
          await readFile(path.join(root, "a.txt"), "utf8"),
          introduced,
        );
      } else {
        assert.equal(result.warning, undefined);
        assert.ok(
          conservationDiffs.every((diff) => !diff.trim()),
          "a fixed jj must conserve the destination and every descendant tree",
        );
        assert.deepEqual((await readdir(root)).sort(), [".jj", "b.txt"]);
        await assert.rejects(readFile(path.join(root, "a.txt")), {
          code: "ENOENT",
        });
      }
      assert.equal(
        await readFile(path.join(root, "b.txt"), "utf8"),
        destinationBytes,
      );
      assert.equal(await valueAt(root, "@", "change_id"), workspaceId);
      assert.equal(
        squashCalls,
        1,
        "a completed native squash must never be retried",
      );
      const undone = await service.undo(result.state.version);
      assert.equal(undone.state.canUndo, false);
      assert.deepEqual(undone.state.source, before.source);
      assert.deepEqual(undone.state.parent, before.parent);
      assert.deepEqual(undone.state.targets, before.targets);
      assert.deepEqual(undone.state.files, before.files);
      assert.deepEqual(
        await Promise.all(
          ids.map((id) => valueAt(root, revision(id), "commit_id")),
        ),
        commits,
        "undo must restore all source, destination and workspace commit identities",
      );
      assert.deepEqual((await readdir(root)).sort(), [".jj", "b.txt"]);
      await assert.rejects(readFile(path.join(root, "a.txt")), {
        code: "ENOENT",
      });
      assert.equal(
        await readFile(path.join(root, "b.txt"), "utf8"),
        destinationBytes,
      );
      assert.equal(await valueAt(root, "@", "change_id"), workspaceId);
      assert.equal(squashCalls, 1);
    });
}
