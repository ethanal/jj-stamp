import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PrReviewManager } from "../server/pr-review.ts";
import {
  parsePrInput,
  summarySchema,
  type PrRunner,
} from "../server/pr-review-github.ts";
import { run, jj } from "../server/process.ts";
import type { PrReviewSummary } from "../src/pr-review-types.ts";
import { startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-real-pr-"));
  const original = path.join(directory, "original");
  const remote = path.join(directory, "remote");
  const assetsDir = path.join(directory, "assets");
  await mkdir(original);
  await mkdir(remote);
  await mkdir(assetsDir);
  await writeFile(path.join(assetsDir, "index.html"), "PR fixture");
  await jj(original, ["git", "init", "--colocate"]);
  await writeFile(
    path.join(original, "untouched.txt"),
    "unsnapshotted original bytes\n",
  );
  const originalOperation = (
    await jj(original, [
      "op",
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "--limit",
      "1",
      "-T",
      "id",
    ])
  ).stdout;
  const git = async (...args: string[]) =>
    (await run("git", args, remote)).stdout.trim();
  await git("init", "--initial-branch=main");
  await git("config", "user.name", "PR Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await writeFile(path.join(remote, "review.ts"), "base\n");
  await writeFile(
    path.join(remote, "opaque.bin"),
    Buffer.from([0, 255, 128, 1]),
  );
  await git("add", ".");
  await git("commit", "-m", "merge base");
  const mergeBase = await git("rev-parse", "HEAD");
  await git("checkout", "-b", "feature");
  await writeFile(path.join(remote, "review.ts"), "head\n");
  await git("commit", "-am", "feature");
  const head = await git("rev-parse", "HEAD");
  await git("update-ref", "refs/pull/7/head", head);
  await git("checkout", "main");
  await writeFile(path.join(remote, "base-only.txt"), "not in PR head\n");
  await git("add", ".");
  await git("commit", "-m", "base advanced independently");
  const base = await git("rev-parse", "HEAD");
  const summary: PrReviewSummary = {
    number: 7,
    title: "Real local fixture",
    url: "https://github.com/test-owner/test-repo/pull/7",
    state: "OPEN",
    isDraft: false,
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: head,
    baseRefOid: base,
    author: { login: "fixture" },
  };
  const fakeGh = path.join(directory, "fake-gh.cjs");
  const data = path.join(directory, "github.json");
  await writeFile(data, JSON.stringify(summary));
  await writeFile(
    fakeGh,
    `
const fs = require("node:fs");
const args = process.argv.slice(3);
const summary = JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
if (args[0] === "repo" && args[1] === "view") console.log(JSON.stringify({owner:{login:"test-owner"},name:"test-repo",nameWithOwner:"test-owner/test-repo",url:"https://github.com/test-owner/test-repo"}));
else if (args[0] === "pr" && args[1] === "list") console.log(JSON.stringify([summary]));
else if (args[0] === "pr" && args[1] === "view" && args[2] === "7") console.log(JSON.stringify(summary));
else { console.error("Forbidden fake gh invocation", args); process.exit(99); }
`,
  );
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const runner: PrRunner = async (command, args, cwd, limits) => {
    calls.push({ command, args: [...args], cwd });
    if (command === "gh")
      return run(process.execPath, [fakeGh, data, ...args], cwd, limits);
    if (command === "git" && args.includes("fetch")) {
      args = args.map((arg) =>
        arg === "https://github.com/test-owner/test-repo" ? remote : arg,
      );
    }
    return run(command, args, cwd, limits);
  };
  const options = {
    repoPath: original,
    assetsDir,
    dataHome: path.join(directory, "data"),
    runner,
  };
  return {
    ...options,
    directory,
    remote,
    mergeBase,
    head,
    base,
    summary,
    calls,
    data,
    fakeGh,
    originalOperation,
    manager: () => new PrReviewManager(options),
    async archive() {
      const root = path.join(options.dataHome, "jj-stamp", "pr-reviews");
      const entry = (await readdir(root)).find(
        (entry) => !entry.startsWith("."),
      )!;
      const dir = path.join(root, entry);
      return {
        dir,
        workspace: path.join(dir, "workspace"),
        metadata: JSON.parse(
          await readFile(path.join(dir, "review.json"), "utf8"),
        ),
      };
    },
  };
}

test("strict PR inputs reject foreign URLs, shell text, ambiguity and noncanonical URLs", () => {
  const repo = {
    owner: "a",
    name: "b",
    nameWithOwner: "a/b",
    url: "https://github.com/a/b",
  };
  assert.equal(parsePrInput("123", repo), 123);
  assert.equal(parsePrInput(" #123 ", repo), 123);
  assert.equal(parsePrInput("https://github.com/a/b/pull/7", repo), 7);
  assert.equal(parsePrInput(" https://github.com/a/b/pull/7/ ", repo), 7);
  for (const input of [
    "0",
    "01",
    "-1",
    "1;pwd",
    "2147483648",
    "https://github.com/a/c/pull/7",
    "https://github.com/a/b/pull/7?x",
    "https://github.com/a/b/pull/7#x",
    "https://evil.invalid/a/b/pull/7",
    "https://github.com@evil.invalid/a/b/pull/7",
  ])
    assert.throws(() => parsePrInput(input, repo), input);
});

test("GitHub bot author logins remain supported as display-only values", () => {
  for (const login of ["dependabot[bot]", "app/dependabot", "ordinary-user"])
    assert.deepEqual(summarySchema.shape.author.parse({ login }), { login });
  assert.throws(() =>
    summarySchema.shape.author.parse({ login: "unsafe\nidentity" }),
  );
});

test("independent comments branches survive annotating, squashing the same code, and managed restart", async () => {
  const f = await fixture();
  let manager = f.manager();
  const headers = { "content-type": "application/json", "x-fold-request": "1" };
  try {
    const opened = await manager.open("#7");
    const state = await (await fetch(`${opened.url}api/state`)).json();
    assert.equal(state.canEditComments, true);
    const archive = await f.archive();
    assert.equal(archive.metadata.schema, 2);
    assert.equal(archive.metadata.branches.length, 2);
    const branch = archive.metadata.branches.find(
      (branch: { codeChangeId: string }) =>
        branch.codeChangeId === archive.metadata.sourceChangeId,
    )!;
    const reviewedBranch = archive.metadata.branches.find(
      (branch: { codeChangeId: string }) =>
        branch.codeChangeId === archive.metadata.reviewedChangeId,
    )!;
    const show = async (revision: string) =>
      (
        await jj(archive.workspace, [
          "file",
          "show",
          "--ignore-working-copy",
          "-r",
          `change_id("${revision}")`,
          "--",
          'root-file:"review.ts"',
        ])
      ).stdout;
    const commit = async (revision: string) =>
      (
        await jj(archive.workspace, [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          `change_id("${revision}")`,
          "-T",
          "commit_id",
        ])
      ).stdout;
    const sourceBefore = await commit(archive.metadata.sourceChangeId);
    const reviewedBefore = await commit(archive.metadata.reviewedChangeId);
    const response = await fetch(`${opened.url}api/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "add",
        version: state.version,
        path: "review.ts",
        line: 1,
        body: "Keep this draft\nAcross restarts",
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.state.canEditComments, true);
    const annotated = await show(branch.commentsChangeId);
    assert.match(annotated, /Keep this draft/);
    assert.equal(
      await readFile(path.join(archive.workspace, "review.ts"), "utf8"),
      "head\n",
    );
    assert.equal(await show(archive.metadata.sourceChangeId), "head\n");
    assert.equal(
      await commit(archive.metadata.sourceChangeId),
      sourceBefore,
      "comment save must not rewrite the source code",
    );
    assert.equal(
      await commit(archive.metadata.reviewedChangeId),
      reviewedBefore,
      "comment save must not rewrite Reviewed",
    );
    const overlayResponse = await fetch(`${opened.url}api/comments/file`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: result.state.version,
        path: "review.ts",
      }),
    });
    const overlay = await overlayResponse.json();
    assert.equal(overlayResponse.status, 200, JSON.stringify(overlay));
    assert.equal(overlay.comments[0].body, "Keep this draft\nAcross restarts");
    const squash = await fetch(`${opened.url}api/squash-lines`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: result.state.version,
        selections: result.state.files.flatMap(
          (file: {
            hunks: { id: string; rows: { index: number; raw: string }[] }[];
          }) =>
            file.hunks.map((hunk) => ({
              id: hunk.id,
              lines: hunk.rows
                .filter((row) => /^[+-]/.test(row.raw))
                .map((row) => row.index),
            })),
        ),
      }),
    });
    const squashed = await squash.json();
    assert.equal(squash.status, 200, JSON.stringify(squashed));
    assert.equal(squashed.state.files.length, 0);
    assert.notEqual(
      await commit(archive.metadata.reviewedChangeId),
      reviewedBefore,
    );
    assert.equal(await show(archive.metadata.reviewedChangeId), "head\n");
    assert.equal(await show(archive.metadata.sourceChangeId), "head\n");
    assert.equal(await show(branch.commentsChangeId), annotated);
    // Reviewed has its own independent COMMENTS leaf, not an annotation commit
    // inserted between the two clean code revisions.
    const selectedReviewed = await fetch(`${opened.url}api/revision`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        version: squashed.state.version,
        changeId: archive.metadata.reviewedChangeId,
      }),
    });
    const selected = await selectedReviewed.json();
    assert.equal(selectedReviewed.status, 200, JSON.stringify(selected));
    assert.equal(selected.state.canEditComments, true);
    const reviewedComment = await fetch(`${opened.url}api/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        action: "add",
        version: selected.state.version,
        path: "review.ts",
        line: 1,
        body: "Reviewed branch draft",
      }),
    });
    const savedReviewed = await reviewedComment.json();
    assert.equal(reviewedComment.status, 200, JSON.stringify(savedReviewed));
    const annotatedReviewed = await show(reviewedBranch.commentsChangeId);
    assert.match(annotatedReviewed, /Reviewed branch draft/);
    assert.equal(await show(branch.commentsChangeId), annotated);
    assert.equal(await show(archive.metadata.sourceChangeId), "head\n");
    assert.equal(await show(archive.metadata.reviewedChangeId), "head\n");
    await manager.close();
    const beforeRestart = f.calls.length;
    await writeFile(
      f.data,
      JSON.stringify({ ...f.summary, headRefOid: "a".repeat(40) }),
    );
    manager = f.manager();
    const resumed = await manager.open("7");
    const resumedState = await (await fetch(`${resumed.url}api/state`)).json();
    assert.equal(resumedState.canEditComments, true);
    assert.equal(resumedState.source.changeId, archive.metadata.sourceChangeId);
    assert.equal(resumedState.files.length, 0);
    assert.equal(await show(branch.commentsChangeId), annotated);
    assert.equal(
      await show(reviewedBranch.commentsChangeId),
      annotatedReviewed,
    );
    assert.equal(
      await readFile(path.join(archive.workspace, "review.ts"), "utf8"),
      "head\n",
    );
    assert.equal(
      (
        await jj(archive.workspace, [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          "@",
          "-T",
          "change_id",
        ])
      ).stdout,
      archive.metadata.sourceChangeId,
    );
    assert.deepEqual(
      await readFile(path.join(archive.workspace, "opaque.bin")),
      Buffer.from([0, 255, 128, 1]),
    );
    assert.equal(
      f.calls
        .slice(beforeRestart)
        .some(
          (call) =>
            call.args.includes("fetch") ||
            (call.command === "gh" && call.args[0] === "pr"),
        ),
      false,
    );
    // Source changes are never excused merely because a comment branch exists.
    await writeFile(
      path.join(archive.workspace, "review.ts"),
      "unexpected code\n",
    );
    await jj(archive.workspace, ["status"]);
    await manager.close();
    manager = f.manager();
    await assert.rejects(
      manager.open("7"),
      /Remaining tree differs from the exact pinned PR head/,
    );
    assert.equal(
      await readFile(path.join(archive.workspace, "review.ts"), "utf8"),
      "unexpected code\n",
    );
  } finally {
    await manager.close();
  }
});

test("resume rejects a working-copy move without silently retargeting edits", async () => {
  const f = await fixture();
  let manager = f.manager();
  try {
    await manager.open("7");
    const archive = await f.archive();
    await jj(archive.workspace, [
      "new",
      "@-",
      "-m",
      "unrelated workspace change",
    ]);
    await manager.close();
    manager = f.manager();
    await assert.rejects(manager.open("7"), /working copy no longer edits/);
  } finally {
    await manager.close();
  }
});

test("real PR opens exact synthetic tree in isolated server and resumes local squash without remote imports", async () => {
  const f = await fixture();
  let manager = f.manager();
  manager.setOriginalWorkspaceUrl("http://127.0.0.1:9999/");
  try {
    assert.equal(manager.context().mode, "workspace");
    assert.equal(manager.context().repository, null);
    assert.equal(f.calls.length, 0, "workspace context does not invoke gh");
    const list = await manager.list();
    assert.equal(list.scope, "all-open");
    assert.deepEqual(list.pullRequests, [f.summary]);
    const opened = await manager.open("7");
    assert.match(opened.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.deepEqual(
      await manager.open("https://github.com/test-owner/test-repo/pull/7"),
      opened,
    );
    const context = await (await fetch(`${opened.url}api/pr/context`)).json();
    assert.equal(context.mode, "pr");
    assert.equal(context.originalWorkspaceUrl, "http://127.0.0.1:9999/");
    assert.equal(context.pullRequest.number, 7);
    assert.equal(context.capabilities.refresh, false);
    const state = await (await fetch(`${opened.url}api/state`)).json();
    assert.equal(state.source.changeId.length, 32);
    assert.equal(state.parent.description, "Reviewed PR #7");
    assert.equal(
      state.files.length,
      1,
      "base-only advance is not in effective PR change",
    );
    const archive = await f.archive();
    assert.equal(archive.metadata.mergeBaseOid, f.mergeBase);
    assert.equal(
      await readFile(path.join(archive.workspace, "review.ts"), "utf8"),
      "head\n",
    );
    await assert.rejects(
      readFile(path.join(archive.workspace, "base-only.txt")),
    );
    const reviewedBefore = (
      await jj(archive.workspace, [
        "log",
        "--ignore-working-copy",
        "-r",
        "@-",
        "--no-graph",
        "-T",
        "commit_id",
      ])
    ).stdout;
    await jj(archive.workspace, [
      "squash",
      "--from",
      "@",
      "--into",
      "@-",
      "--keep-emptied",
      "--use-destination-message",
    ]);
    const reviewedAfter = (
      await jj(archive.workspace, [
        "log",
        "--ignore-working-copy",
        "-r",
        "@-",
        "--no-graph",
        "-T",
        "commit_id",
      ])
    ).stdout;
    assert.notEqual(reviewedBefore, reviewedAfter);
    await manager.close();
    const callsAtRestart = f.calls.length;
    await writeFile(
      f.data,
      JSON.stringify({ ...f.summary, headRefOid: "a".repeat(40) }),
    );
    manager = f.manager();
    const resumed = await manager.open("7");
    const resumedState = await (await fetch(`${resumed.url}api/state`)).json();
    assert.equal(resumedState.files.length, 0);
    assert.equal(resumedState.source.changeId, archive.metadata.sourceChangeId);
    assert.equal(
      (
        await jj(archive.workspace, [
          "log",
          "--ignore-working-copy",
          "-r",
          "@-",
          "--no-graph",
          "-T",
          "commit_id",
        ])
      ).stdout,
      reviewedAfter,
    );
    assert.equal(
      f.calls
        .slice(callsAtRestart)
        .some(
          (call) =>
            call.args.includes("fetch") ||
            (call.command === "gh" && call.args[0] === "pr"),
        ),
      false,
    );
    assert.equal(
      await readFile(path.join(f.repoPath, "untouched.txt"), "utf8"),
      "unsnapshotted original bytes\n",
    );
    assert.equal(
      (
        await jj(f.repoPath, [
          "op",
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "--limit",
          "1",
          "-T",
          "id",
        ])
      ).stdout,
      f.originalOperation,
    );
  } finally {
    await manager.close();
  }
});

test("archives fail closed after missing/corrupt metadata, without refetch or overwriting progress", async () => {
  const f = await fixture();
  let manager = f.manager();
  try {
    await manager.open("7");
    await manager.close();
    const archive = await f.archive();
    const metadata = path.join(archive.dir, "review.json");
    await writeFile(metadata, "{broken");
    const before = f.calls.length;
    manager = f.manager();
    await assert.rejects(
      manager.open("7"),
      /archive is missing, corrupt, or unsafe/,
    );
    assert.equal(await readFile(metadata, "utf8"), "{broken");
    assert.equal(
      f.calls.slice(before).some((call) => call.args.includes("fetch")),
      false,
    );
  } finally {
    await manager.close();
  }
});

test("schema 1 archives require manual migration and are never reset or rewritten", async () => {
  const f = await fixture();
  let manager = f.manager();
  try {
    await manager.open("7");
    await manager.close();
    const archive = await f.archive();
    const metadata = path.join(archive.dir, "review.json");
    const legacy = { ...archive.metadata, schema: 1 };
    delete legacy.branches;
    const bytes = JSON.stringify(legacy);
    await writeFile(metadata, bytes);
    const before = f.calls.length;
    manager = f.manager();
    await assert.rejects(
      manager.open("7"),
      /schema 1.*Manual migration is required; no automatic migration or reset/,
    );
    assert.equal(await readFile(metadata, "utf8"), bytes);
    assert.equal(
      f.calls
        .slice(before)
        .some(
          (call) =>
            call.args.includes("fetch") ||
            (call.command === "gh" && call.args[0] === "pr"),
        ),
      false,
    );
    assert.equal(
      await readFile(path.join(archive.workspace, "review.ts"), "utf8"),
      "head\n",
    );
  } finally {
    await manager.close();
  }
});

test("remote head move fails initialization, preserves partial archive, and does not retry fetch", async () => {
  const f = await fixture();
  await writeFile(
    f.data,
    JSON.stringify({ ...f.summary, headRefOid: "b".repeat(40) }),
  );
  const manager = f.manager();
  try {
    await assert.rejects(manager.open("7"), /PR moved during fetch/);
    await assert.rejects(
      manager.open("7"),
      /archive is missing, corrupt, or unsafe/,
    );
    assert.equal(
      f.calls.filter((call) => call.args.includes("fetch")).length,
      1,
    );
  } finally {
    await manager.close();
  }
});

test("separate reservation detects a missing whole archive without recreating it", async () => {
  const f = await fixture();
  let manager = f.manager();
  try {
    await manager.open("7");
    await manager.close();
    const archive = await f.archive();
    await rename(archive.dir, `${archive.dir}-saved`);
    manager = f.manager();
    await assert.rejects(manager.open("7"), /archive is missing or unsafe/);
    await assert.rejects(readFile(path.join(archive.dir, "review.json")));
  } finally {
    await manager.close();
  }
});

test("PR HTTP handlers enforce loopback mutations and leave the original service/server in place", async () => {
  const f = await fixture();
  const manager = f.manager();
  const original = await startLocalServer({
    service: new ReviewService({ repoPath: f.repoPath }),
    assetsDir: f.assetsDir,
    port: 0,
    pr: manager,
  });
  manager.setOriginalWorkspaceUrl(original.url);
  try {
    const context = await fetch(`${original.url}api/pr/context`);
    assert.equal(context.status, 200);
    assert.equal(context.headers.get("cache-control"), "no-store");
    assert.equal((await context.json()).mode, "workspace");
    assert.equal(f.calls.length, 0);
    const post = (body: string, headers: Record<string, string> = {}) =>
      fetch(`${original.url}api/pr/open`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      });
    assert.equal((await post('{"input":"7"}')).status, 403);
    assert.equal(
      (
        await post('{"input":"7"}', {
          "x-fold-request": "1",
          origin: "https://evil.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (await post('{"input":"7","extra":true}', { "x-fold-request": "1" }))
        .status,
      400,
    );
    assert.equal((await post("{bad", { "x-fold-request": "1" })).status, 400);
    const opened = await post('{"input":"7"}', { "x-fold-request": "1" });
    assert.equal(opened.status, 200);
    const child = (await opened.json()).url as string;
    assert.notEqual(child, original.url);
    const second = f.manager();
    try {
      await assert.rejects(second.open("7"), /review is locked/);
    } finally {
      await second.close();
    }
    assert.equal(
      (await (await fetch(`${original.url}api/pr/context`)).json()).mode,
      "workspace",
    );
    assert.equal(
      (await (await fetch(`${child}api/pr/context`)).json()).mode,
      "pr",
    );
    await manager.close();
    await assert.rejects(fetch(`${child}api/pr/context`));
    assert.equal((await fetch(`${original.url}api/pr/context`)).status, 200);
  } finally {
    await Promise.all([manager.close(), original.close()]);
  }
});

test("bundled --pr CLI opens a real managed review and gracefully closes both servers", async () => {
  const f = await fixture();
  const executable = path.join(f.directory, "cli.cjs");
  const client = path.join(f.directory, "client");
  const bin = path.join(f.directory, "bin");
  await mkdir(client);
  await mkdir(bin);
  await writeFile(path.join(client, "index.html"), "CLI fixture");
  await build({
    entryPoints: [fileURLToPath(new URL("../cli.ts", import.meta.url))],
    outfile: executable,
    platform: "node",
    target: "node24",
    format: "cjs",
    bundle: true,
    define: { __JJ_STAMP_VERSION__: '"test"', __JJ_STAMP_BUNDLED__: "true" },
  });
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const gh = path.join(bin, "gh");
  const git = path.join(bin, "git");
  await writeFile(
    gh,
    `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");const result=spawnSync(${JSON.stringify(process.execPath)},[${JSON.stringify(f.fakeGh)},${JSON.stringify(f.data)},...process.argv.slice(2)],{stdio:"inherit"});process.exit(result.status??99);\n`,
  );
  await writeFile(
    git,
    `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");const args=process.argv.slice(2).map(x=>x==="https://github.com/test-owner/test-repo"?${JSON.stringify(f.remote)}:x);const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exit(result.status??99);\n`,
  );
  await chmod(gh, 0o755);
  await chmod(git, 0o755);
  const child = spawn(
    process.execPath,
    [executable, "-R", f.repoPath, "--pr", "#7", "--no-open", "--port", "0"],
    {
      env: {
        ...process.env,
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        XDG_DATA_HOME: f.dataHome,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "",
    stderr = "";
  child.stdout.setEncoding("utf8").on("data", (text) => {
    stdout += text;
  });
  child.stderr.setEncoding("utf8").on("data", (text) => {
    stderr += text;
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const inspect = () => {
        const match =
          /^jj-stamp listening on (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(stdout);
        if (match) {
          child.stdout.off("data", inspect);
          resolve(match[1]!);
        }
      };
      child.stdout.on("data", inspect);
      void exited.then(
        () =>
          reject(
            new Error(`CLI exited before listening:\n${stdout}\n${stderr}`),
          ),
        reject,
      );
      inspect();
    });
    const root = /^Original workspace: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(
      stdout,
    )?.[1];
    assert.ok(root, stdout);
    assert.notEqual(root, url);
    assert.equal(
      (await (await fetch(`${url}api/pr/context`)).json()).mode,
      "pr",
    );
    assert.equal(
      (await (await fetch(`${root}api/pr/context`)).json()).mode,
      "workspace",
    );
    assert.equal(
      (
        await jj(f.repoPath, [
          "op",
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "--limit",
          "1",
          "-T",
          "id",
        ])
      ).stdout,
      f.originalOperation,
    );
    child.kill("SIGTERM");
    assert.equal(await exited, 0, stderr);
    await assert.rejects(fetch(url));
    await assert.rejects(fetch(root));
    const archive = await f.archive();
    await assert.rejects(readFile(path.join(archive.dir, "active.lock")));
  } finally {
    clearTimeout(watchdog);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  }
});
