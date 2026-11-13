import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import type { AddressInfo } from "node:net";
import { ApiError, ReviewService, type State } from "../server/service.ts";
import { createApi } from "../server/api.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-input-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createDemo(directory);
}
function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}
const identity = async (root: string, revset: string, template = "commit_id") =>
  (
    await jj(root, ["log", "--no-graph", "-r", revset, "-T", template])
  ).stdout.trim();

test("custom graph revsets apply equally to text and rows, remain read-only and do not persist", async (t) => {
  const root = await fixture(t);
  const commands: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: (cwd, args) => {
      commands.push([...args]);
      return jj(cwd, args);
    },
  });
  const before = await service.getState();
  const defaults = await service.getLog();
  const custom = await service.getLog({ revset: "root()" });
  const revisions = custom.rows.flatMap((row) => row.revision ?? []);
  assert.equal(revisions.length, 1);
  assert.match(revisions[0].changeId, /^z+$/);
  assert.equal(custom.version, before.version);
  assert.equal(custom.output, (await jj(root, ["log", "-r", "root()"])).stdout);
  assert.deepEqual(
    await service.getLog({ includeOutput: false, revset: "root()" }),
    { ...custom, output: "" },
  );
  // Shell-looking text is a literal jj revset argument, not a shell command.
  const revset = 'none() | description("$(echo unsafe); --help")';
  const empty = await service.getLog({ revset });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.output, "");
  const renders = commands.filter(
    (args) => args.includes("--at-operation") && args.includes("-r"),
  );
  assert.equal(
    renders.filter((args) => args[args.indexOf("-r") + 1] === revset).length,
    2,
  );
  assert.deepEqual(await service.getState(), before);
  assert.deepEqual(await service.getLog(), defaults);
});

test("service rejects empty, unbounded and non-string revsets before starting jj", async () => {
  let commands = 0;
  const service = new ReviewService({
    repoPath: "/not-used",
    jjRunner: async () => {
      commands++;
      throw new Error("Must not run");
    },
  });
  for (const revset of [
    "",
    " \n\t ",
    "x".repeat(4097),
    "all()\0",
    [],
    null,
    1,
  ]) {
    await rejectsCode(
      service.getLog({ revset: revset as string }),
      "INVALID_REQUEST",
    );
  }
  assert.equal(commands, 0);
});

test("graph/log HTTP queries validate revsets and revision accepts commit identities", async (t) => {
  const root = await fixture(t);
  const service = new ReviewService({ repoPath: root });
  const app = express();
  app.use("/api", createApi(service));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const before = await service.getState();
  const full = await (
    await fetch(`${base}/log?revset=${encodeURIComponent("root()")}`)
  ).json();
  for (const endpoint of ["graph", "log?format=rows"]) {
    const separator = endpoint.includes("?") ? "&" : "?";
    const response = await fetch(
      `${base}/${endpoint}${separator}revset=root()`,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      version: full.version,
      rows: full.rows,
    });
  }
  for (const endpoint of ["graph", "log"]) {
    for (const query of [
      "revset=",
      "revset=%20%0A",
      `revset=${"x".repeat(4097)}`,
      "revset=all()%00",
      "revset=all()&revset=root()",
    ]) {
      const response = await fetch(`${base}/${endpoint}?${query}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).code, "INVALID_REQUEST");
    }
  }
  const select = (changeId: string, version = before.version) =>
    fetch(`${base}/revision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version, changeId }),
    });
  for (const value of [
    'commit_id("abc")',
    "abc | def",
    " abc",
    "abc ",
    "abc\n",
    "@\n",
    "kkk\r\n",
    "0".repeat(65),
  ]) {
    const response = await select(value);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  const preview = await service.preview({
    version: before.version,
    target: before.parent!.changeId,
    selections: before.files.flatMap((file) =>
      file.hunks.map((hunk) => ({
        id: hunk.id,
        lines: hunk.rows
          .filter((row) => /^[+-]/.test(row.raw))
          .map((row) => row.index),
      })),
    ),
  });
  const selected = await select(before.parent!.commitId.slice(0, 12));
  assert.equal(selected.status, 200);
  const body = (await selected.json()) as { state: State };
  assert.deepEqual(body.state.source, before.parent);
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
  const stale = await select(before.source.commitId);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "STALE_STATE");
});

test("full and prefix commit identities ignore bookmark shadowing and pin the full change", async (t) => {
  const root = await fixture(t);
  const candidate = await identity(root, "@-");
  const candidateChange = await identity(root, "@-", "change_id");
  const prefix = candidate.slice(0, 12);
  for (const name of [candidate, prefix])
    await jj(root, ["bookmark", "set", name, "-r", "@"]);
  const commands: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: (cwd, args) => {
      commands.push([...args]);
      return jj(cwd, args);
    },
  });
  const before = await service.getState();
  const selected = (
    await service.selectRevision({
      version: before.version,
      changeId: candidate,
    })
  ).state;
  assert.equal(selected.source.commitId, candidate);
  assert.equal(selected.source.changeId, candidateChange);
  assert.deepEqual(
    selected.files.map((file) => file.path),
    ["src/preferences.ts"],
    "the displayed diff must also ignore the bookmark named after the full hash",
  );
  const selectedPrefix = (
    await service.selectRevision({
      version: selected.version,
      changeId: prefix,
    })
  ).state;
  assert.deepEqual(selectedPrefix, selected);
  for (const value of [candidate, prefix])
    assert.equal(
      commands.filter(
        (args) =>
          args[0] === "log" &&
          args.includes("-r") &&
          args[args.indexOf("-r") + 1].includes(`commit_id("${value}")`),
      ).length,
      2,
      "capture and final validation both resolve literal commit identity",
    );
  await jj(root, [
    "describe",
    candidateChange,
    "-m",
    "Rewritten selected change",
  ]);
  await jj(root, ["new", "-m", "Moved workspace"]);
  const followed = await service.getState();
  assert.equal(followed.source.changeId, candidateChange);
  assert.notEqual(followed.source.commitId, candidate);
  assert.equal(followed.source.description, "Rewritten selected change");
  await rejectsCode(
    service.selectRevision({
      version: followed.version,
      changeId: candidate,
    }),
    "INVALID_REVISION",
  );
  assert.deepEqual(await service.getState(), followed);
});

test("missing and ambiguous commit prefixes preserve the current selection", async (t) => {
  const root = await fixture(t);
  // Seventeen visible commits guarantee a shared first hexadecimal digit.
  for (let i = 0; i < 17; i++)
    await jj(root, ["new", "-m", `Prefix candidate ${i}`]);
  const commits = (await identity(root, "all()", 'commit_id ++ "\\n"')).split(
    "\n",
  );
  const prefix = commits.find((id, i) =>
    commits.some((other, j) => i !== j && other[0] === id[0]),
  )![0];
  const service = new ReviewService({ repoPath: root });
  const before = await service.getState();
  for (const value of [prefix, "f".repeat(64)]) {
    await rejectsCode(
      service.selectRevision({ version: before.version, changeId: value }),
      "INVALID_REVISION",
    );
    assert.deepEqual(await service.getState(), before);
  }
});

test("commit selection rejects divergent candidates even when a full hash names one revision", async (t) => {
  const root = await fixture(t);
  const candidateChange = await identity(root, "@", "change_id");
  const service = new ReviewService({ repoPath: root, revision: "@--" });
  const initial = await service.getState();
  await jj(root, ["describe", candidateChange, "-m", "First rewrite"]);
  await jj(root, [
    "--at-operation",
    initial.operation,
    "describe",
    candidateChange,
    "-m",
    "Second rewrite",
  ]);
  await jj(root, ["status"]);
  const candidate = await identity(root, "@");
  assert.equal(await identity(root, "@", "divergent"), "true");
  const before = await service.getState();
  await rejectsCode(
    service.selectRevision({
      version: before.version,
      changeId: candidate,
    }),
    "INVALID_REVISION",
  );
  assert.deepEqual(await service.getState(), before);
});

test("commit selection revalidates candidate visibility and preserves source/watch scope on a capture race", async (t) => {
  const root = await fixture(t);
  let armed = false;
  let injected = false;
  const service = new ReviewService({
    repoPath: root,
    revision: "@-",
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (armed && !injected && args[0] === "diff") {
        injected = true;
        await jj(root, ["describe", "@", "-m", "Concurrent candidate rewrite"]);
      }
      return result;
    },
  });
  const before = await service.getState();
  const paths = service.getWatchPaths();
  const candidate = await identity(root, "@");
  armed = true;
  await rejectsCode(
    service.selectRevision({ version: before.version, changeId: candidate }),
    "INVALID_REVISION",
  );
  assert.equal(injected, true);
  assert.deepEqual(service.getWatchPaths(), paths);
  assert.equal(
    (await service.getState()).source.changeId,
    before.source.changeId,
  );
});
