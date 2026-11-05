import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { PrReviewStore, type PrMetadata } from "../server/pr-review-store.ts";
import { resolveRepoDirectory } from "../server/fs-events.ts";

async function fixture(host = "github.com", colocate = true) {
  const repositoryUrl = `https://${host}/test-owner/test-repo`;
  const directory = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-real-pr-"));
  const original = path.join(directory, "original");
  const remote = path.join(directory, "remote");
  const assetsDir = path.join(directory, "assets");
  await mkdir(original);
  await mkdir(remote);
  await mkdir(assetsDir);
  await writeFile(path.join(assetsDir, "index.html"), "PR fixture");
  await jj(original, [
    "git",
    "init",
    colocate ? "--colocate" : "--no-colocate",
  ]);
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
  const originalChange = (
    await jj(original, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      "change_id",
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
    url: `${repositoryUrl}/pull/7`,
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
if (args[0] === "pr" && args[args.indexOf("--repo") + 1] !== ${JSON.stringify(`${host}/test-owner/test-repo`)}) { console.error("Wrong GitHub host/repo", args); process.exit(99); }
if (args[0] === "api" && args[args.indexOf("--hostname") + 1] !== ${JSON.stringify(host)}) { console.error("Wrong GitHub API host", args); process.exit(99); }
if (args[0] === "pr" && args[1] === "list" && (args[args.indexOf("--search") + 1] !== "review-involves:@me -is:merged" || args[args.indexOf("--state") + 1] !== "all")) { console.error("Wrong review queue filter", args); process.exit(99); }
if (args[0] === "repo" && args[1] === "view") console.log(JSON.stringify({owner:{login:"test-owner"},name:"test-repo",nameWithOwner:"test-owner/test-repo",url:${JSON.stringify(repositoryUrl)}}));
else if (args[0] === "api" && args.at(-1) === "meta") console.log(JSON.stringify({installed_version:"3.23.0"}));
else if (args[0] === "pr" && args[1] === "list") console.log(JSON.stringify([summary]));
else if (args[0] === "pr" && args[1] === "view" && args[2] === String(summary.number)) console.log(JSON.stringify(summary));
else { console.error("Forbidden fake gh invocation", args); process.exit(99); }
`,
  );
  const calls: { command: string; args: string[]; cwd: string }[] = [];
  const runner: PrRunner = async (command, args, cwd, limits) => {
    calls.push({ command, args: [...args], cwd });
    if (command === "gh")
      return run(process.execPath, [fakeGh, data, ...args], cwd, limits);
    if (command === "git" && args.includes("fetch")) {
      args = args.map((arg) => (arg === repositoryUrl ? remote : arg));
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
    repositoryUrl,
    mergeBase,
    head,
    base,
    summary,
    calls,
    data,
    fakeGh,
    originalOperation,
    originalChange,
    async manager(
      overrides: Partial<ConstructorParameters<typeof PrReviewManager>[0]> = {},
    ) {
      const manager = new PrReviewManager({ ...options, ...overrides });
      const local = await startLocalServer({
        service: new ReviewService({ repoPath: original }),
        assetsDir,
        port: 0,
        pr: manager,
      });
      manager.setOriginalWorkspaceUrl(local.url);
      const close = manager.close.bind(manager);
      manager.close = async () => {
        await Promise.all([local.close(), close()]);
      };
      return Object.assign(manager, { rootUrl: local.url });
    },
    async archive(number = 7) {
      const root = new PrReviewStore(
        options.dataHome,
        await resolveRepoDirectory(original),
      ).root;
      const identity = `${host === "github.com" ? "" : `${host}/`}test-owner/test-repo#${number}`;
      const entry = createHash("sha256").update(identity).digest("hex");
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

test("Enterprise PRs list, open by URL, fetch the right host, and resume locally", async () => {
  const f = await fixture("github.enterprise.example");
  let manager = await f.manager();
  try {
    const listed = await manager.list();
    assert.equal(listed.repository.url, f.repositoryUrl);
    assert.equal(listed.pullRequests[0]?.url, f.summary.url);
    const beforeForeign = f.calls.length;
    await assert.rejects(
      manager.open("https://github.com/test-owner/test-repo/pull/7"),
      /current repository/,
    );
    assert.equal(f.calls.length, beforeForeign, "foreign URLs run no commands");
    const opened = await manager.open(f.summary.url);
    const context = await (await fetch(`${opened.url}api/pr/context`)).json();
    assert.equal(context.repository.url, f.repositoryUrl);
    assert.equal(context.pullRequest.url, f.summary.url);
    const fetches = f.calls.filter(
      (call) => call.command === "git" && call.args.includes("fetch"),
    );
    assert.equal(fetches.length, 1);
    assert.ok(fetches[0]!.args.includes(f.repositoryUrl));
    assert.ok(
      fetches[0]!.args.includes("credential.helper=!gh auth git-credential"),
    );
    const { metadata } = await f.archive();
    assert.equal(metadata.repository.url, f.repositoryUrl);
    assert.notEqual(
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
    assert.equal(
      (
        await jj(f.repoPath, [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          "@",
          "-T",
          "change_id",
        ])
      ).stdout,
      f.originalChange,
    );
    await manager.close();
    manager = await f.manager();
    const beforeResume = f.calls.length;
    const resumed = await manager.open("#7");
    assert.equal(
      (await (await fetch(`${resumed.url}api/pr/context`)).json()).repository
        .url,
      f.repositoryUrl,
    );
    assert.equal(
      f.calls
        .slice(beforeResume)
        .filter(
          (call) =>
            (call.command === "gh" && call.args[0] === "pr") ||
            (call.command === "git" && call.args.includes("fetch")),
        ).length,
      0,
      "resume uses local progress without PR lookup or fetch",
    );
  } finally {
    await manager.close();
  }
});

test("closed unmerged PRs can start a review, but merged PRs cannot", async () => {
  for (const state of ["CLOSED", "MERGED"] as const) {
    const f = await fixture();
    await writeFile(f.data, JSON.stringify({ ...f.summary, state }));
    const manager = await f.manager();
    try {
      const listed = await manager.list();
      assert.deepEqual(
        listed.pullRequests.map((pr) => pr.state),
        state === "MERGED" ? [] : ["CLOSED"],
      );
      if (state === "MERGED") {
        await assert.rejects(manager.open("7"), /Merged pull requests/);
        assert.equal(
          f.calls.some(
            (call) => call.command === "git" && call.args.includes("fetch"),
          ),
          false,
        );
      } else {
        const opened = await manager.open("7");
        const context = await (
          await fetch(`${opened.url}api/pr/context`)
        ).json();
        assert.equal(context.pullRequest.state, "CLOSED");
      }
    } finally {
      await manager.close();
    }
  }
});

test("a PR merged during import is rejected after fetching without creating review metadata", async () => {
  const f = await fixture();
  const manager = await f.manager({
    runner: async (command, args, cwd, limits) => {
      const result = await f.runner(command, args, cwd, limits);
      if (command === "git" && args.includes("fetch"))
        await writeFile(
          f.data,
          JSON.stringify({ ...f.summary, state: "MERGED" }),
        );
      return result;
    },
  });
  try {
    await assert.rejects(manager.open("7"), /PR changed during initialization/);
    await assert.rejects(f.archive(), /ENOENT/);
  } finally {
    await manager.close();
  }
});

test("independent comments branches survive annotating, squashing the same code, and managed restart", async () => {
  const f = await fixture();
  let manager = await f.manager();
  const headers = { "content-type": "application/json", "x-fold-request": "1" };
  try {
    const opened = await manager.open("#7");
    const state = await (await fetch(`${opened.url}api/state`)).json();
    assert.equal(state.canEditComments, true);
    const archive = await f.archive();
    assert.equal(archive.metadata.schema, 3);
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
    manager = await f.manager();
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
    manager = await f.manager();
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
  let manager = await f.manager();
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
    manager = await f.manager();
    await assert.rejects(manager.open("7"), /working copy no longer edits/);
  } finally {
    await manager.close();
  }
});

test("real PR opens a linked workspace on the same server and resumes local squash without remote imports", async () => {
  const f = await fixture();
  let manager = await f.manager();

  try {
    assert.equal(manager.context().mode, "workspace");
    assert.equal(manager.context().repository, null);
    assert.equal(f.calls.length, 0, "workspace context does not invoke gh");
    const list = await manager.list();
    assert.equal(list.scope, "review-involves");
    assert.deepEqual(list.pullRequests, [f.summary]);
    const opened = await manager.open("7");
    assert.equal(new URL(opened.url).origin, new URL(manager.rootUrl).origin);
    assert.match(new URL(opened.url).pathname, /^\/reviews\/[0-9a-f]{64}\/$/);
    assert.deepEqual(
      await manager.open("https://github.com/test-owner/test-repo/pull/7"),
      opened,
    );
    const context = await (await fetch(`${opened.url}api/pr/context`)).json();
    assert.equal(context.mode, "pr");
    assert.equal(context.originalWorkspaceUrl, manager.rootUrl);
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
    manager = await f.manager();
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
    assert.notEqual(
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
    assert.equal(
      (
        await jj(f.repoPath, [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          "@",
          "-T",
          "change_id",
        ])
      ).stdout,
      f.originalChange,
    );
  } finally {
    await manager.close();
  }
});

test("archives fail closed after missing/corrupt metadata, without refetch or overwriting progress", async () => {
  const f = await fixture();
  let manager = await f.manager();
  try {
    await manager.open("7");
    await manager.close();
    const archive = await f.archive();
    const metadata = path.join(archive.dir, "review.json");
    await writeFile(metadata, "{broken");
    const before = f.calls.length;
    manager = await f.manager();
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
  let manager = await f.manager();
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
    manager = await f.manager();
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
  const manager = await f.manager();
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
  let manager = await f.manager();
  try {
    await manager.open("7");
    await manager.close();
    const archive = await f.archive();
    await rename(archive.dir, `${archive.dir}-saved`);
    manager = await f.manager();
    await assert.rejects(manager.open("7"), /archive is missing or unsafe/);
    await assert.rejects(readFile(path.join(archive.dir, "review.json")));
  } finally {
    await manager.close();
  }
});

test("PR HTTP handlers enforce loopback mutations and leave the original service/server in place", async () => {
  const f = await fixture();
  const manager = new PrReviewManager(f);
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
    assert.equal(new URL(child).origin, new URL(original.url).origin);
    const second = await f.manager();
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
    assert.equal((await fetch(`${child}api/pr/context`)).status, 404);
    assert.equal((await fetch(`${original.url}api/pr/context`)).status, 200);
  } finally {
    await Promise.all([manager.close(), original.close()]);
  }
});

test("bundled CLI opens a linked review through the same server and gracefully closes all routes", async () => {
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
    `#!${process.execPath}\nconst {spawnSync}=require("node:child_process");const args=process.argv.slice(2).map(x=>x===${JSON.stringify(f.repositoryUrl)}?${JSON.stringify(f.remote)}:x);const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:"inherit"});process.exit(result.status??99);\n`,
  );
  await chmod(gh, 0o755);
  await chmod(git, 0o755);
  const child = spawn(
    process.execPath,
    [executable, "-R", f.repoPath, "--no-open", "--port", "0"],
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
    const root = await new Promise<string>((resolve, reject) => {
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
    assert.equal(
      (await (await fetch(`${root}api/pr/context`)).json()).mode,
      "workspace",
    );
    // Shared repository operations change history, not the original files or @.
    const originalOperation = (
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
    ).stdout;
    const opened = await fetch(`${root}api/pr/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
      body: JSON.stringify({ input: "#7" }),
    });
    assert.equal(opened.status, 200, await opened.clone().text());
    const { url } = await opened.json();
    assert.notEqual(root, url);
    assert.equal(new URL(url).origin, new URL(root).origin);
    assert.equal(
      (await (await fetch(`${url}api/pr/context`)).json()).mode,
      "pr",
    );
    assert.equal(
      (await (await fetch(`${root}api/pr/context`)).json()).mode,
      "workspace",
    );
    assert.notEqual(
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
      originalOperation,
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

type PrFixture = Awaited<ReturnType<typeof fixture>>;

async function fixtureGitDirectory(f: PrFixture) {
  return path.resolve(
    f.repoPath,
    (
      await jj(f.repoPath, ["git", "root", "--ignore-working-copy"])
    ).stdout.trim(),
  );
}

async function recordedWorkspace(workspace: string) {
  return (
    await jj(workspace, [
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-r",
      "@",
      "-T",
      'change_id ++ "\\t" ++ commit_id',
    ])
  ).stdout;
}

async function latestOperation(workspace: string) {
  return (
    await jj(workspace, [
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
}

async function assertLinkedWorkspace(f: PrFixture, number = 7) {
  const archive = await f.archive(number);
  const sharedRepository = await resolveRepoDirectory(f.repoPath);
  const id = path.basename(archive.dir);
  assert.equal(
    (await lstat(path.join(archive.workspace, ".jj", "repo"))).isFile(),
    true,
  );
  assert.equal(await resolveRepoDirectory(archive.workspace), sharedRepository);
  assert.equal(archive.metadata.schema, 3);
  assert.equal(archive.metadata.sharedRepository, sharedRepository);
  assert.equal(archive.metadata.workspaceName, `jj-stamp-pr-${id}`);
  const names = (
    await jj(f.repoPath, [
      "workspace",
      "list",
      "--ignore-working-copy",
      "-T",
      'name ++ "\\n"',
    ])
  ).stdout
    .trim()
    .split("\n");
  assert.ok(names.includes(archive.metadata.workspaceName));
  await assert.rejects(lstat(path.join(archive.workspace, ".git")), {
    code: "ENOENT",
  });
  return archive;
}

for (const colocate of [true, false]) {
  test(`cached shared Git objects open without fetching (${colocate ? "colocated" : "noncolocated"} original)`, async () => {
    const f = await fixture("github.com", colocate);
    const gitDirectory = await fixtureGitDirectory(f);
    // Seed dangling objects, not jj-visible bookmarks: initialization must make
    // cached commits visible to jj without a fetch or a colocated review .git.
    await run(
      "git",
      [
        `--git-dir=${gitDirectory}`,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        f.remote,
        f.head,
        f.base,
      ],
      f.repoPath,
    );
    const before = await recordedWorkspace(f.repoPath);
    const gitHead = await readFile(path.join(gitDirectory, "HEAD"));
    const manager = await f.manager();
    try {
      const opened = await manager.open("7");
      const archive = await assertLinkedWorkspace(f);
      assert.equal(new URL(opened.url).origin, new URL(manager.rootUrl).origin);
      assert.equal(
        new URL(opened.url).pathname,
        `/reviews/${path.basename(archive.dir)}/`,
      );
      assert.equal(
        f.calls.filter(
          (call) => call.command === "git" && call.args.includes("fetch"),
        ).length,
        0,
      );
      assert.equal(
        f.calls.filter(
          (call) =>
            call.command === "gh" &&
            call.args[0] === "pr" &&
            call.args[1] === "view",
        ).length,
        2,
      );
      const response = await fetch(`${opened.url}api/state`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(
        (await response.json()).source.changeId,
        archive.metadata.sourceChangeId,
      );
      assert.equal(await recordedWorkspace(f.repoPath), before);
      assert.deepEqual(
        await readFile(path.join(gitDirectory, "HEAD")),
        gitHead,
      );
      assert.equal(
        await readFile(path.join(f.repoPath, "untouched.txt"), "utf8"),
        "unsnapshotted original bytes\n",
      );
      await assert.rejects(lstat(path.join(f.repoPath, "review.ts")), {
        code: "ENOENT",
      });
      assert.notEqual(await latestOperation(f.repoPath), f.originalOperation);
      assert.ok(
        f.calls
          .filter((call) => call.command === "jj" && call.cwd === f.repoPath)
          .every((call) => call.args.includes("--ignore-working-copy")),
      );
      assert.ok(
        f.calls
          .filter((call) => call.command === "git")
          .every((call) => call.args.includes(`--git-dir=${gitDirectory}`)),
      );
      if (!colocate)
        await assert.rejects(lstat(path.join(f.repoPath, ".git")), {
          code: "ENOENT",
        });
    } finally {
      await manager.close();
    }
  });
}

test("two PR workspaces reuse shared objects, keep unique refs and route independent services on one origin", async () => {
  const f = await fixture();
  const gitDirectory = await fixtureGitDirectory(f);
  const before = await recordedWorkspace(f.repoPath);
  const gitHead = await readFile(path.join(gitDirectory, "HEAD"));
  const originalCommit = before.trim().split("\t")[1]!;
  const userRefs = [
    "refs/heads/pr-review-base",
    "refs/heads/pr-review-head",
    "refs/heads/user-owned",
  ];
  for (const ref of userRefs)
    await run(
      "git",
      [`--git-dir=${gitDirectory}`, "update-ref", ref, originalCommit],
      f.repoPath,
    );
  const manager = await f.manager();
  try {
    const first = await manager.open("7");
    const firstArchive = await assertLinkedWorkspace(f);
    assert.equal(
      f.calls.filter(
        (call) => call.command === "git" && call.args.includes("fetch"),
      ).length,
      1,
    );
    await writeFile(
      f.data,
      JSON.stringify({
        ...f.summary,
        number: 8,
        url: `${f.repositoryUrl}/pull/8`,
        title: "Same objects, independent review",
      }),
    );
    // There is deliberately no remote refs/pull/8/head: the object cache alone
    // suffices, while gh still revalidates PR #8 twice.
    const second = await manager.open("8");
    const secondArchive = await assertLinkedWorkspace(f, 8);
    assert.equal(
      f.calls.filter(
        (call) => call.command === "git" && call.args.includes("fetch"),
      ).length,
      1,
    );
    assert.equal(
      f.calls.filter(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "view" &&
          call.args[2] === "8",
      ).length,
      2,
    );
    assert.notEqual(first.url, second.url);
    assert.equal(new URL(first.url).origin, new URL(manager.rootUrl).origin);
    assert.equal(new URL(second.url).origin, new URL(manager.rootUrl).origin);
    assert.notEqual(
      firstArchive.metadata.workspaceName,
      secondArchive.metadata.workspaceName,
    );
    assert.notEqual(
      firstArchive.metadata.sourceChangeId,
      secondArchive.metadata.sourceChangeId,
    );
    assert.notEqual(
      manager.workspace(path.basename(firstArchive.dir))!.service,
      manager.workspace(path.basename(secondArchive.dir))!.service,
    );
    const getState = async (url: string) => {
      const response = await fetch(`${url}api/state`);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
    const firstState = await getState(first.url);
    const secondState = await getState(second.url);
    assert.equal(
      firstState.source.changeId,
      firstArchive.metadata.sourceChangeId,
    );
    assert.equal(
      secondState.source.changeId,
      secondArchive.metadata.sourceChangeId,
    );
    assert.equal(firstState.parent.description, "Reviewed PR #7");
    assert.equal(secondState.parent.description, "Reviewed PR #8");
    for (const [opened, number] of [
      [first, 7],
      [second, 8],
    ] as const)
      assert.equal(
        (await (await fetch(`${opened.url}api/pr/context`)).json()).pullRequest
          .number,
        number,
      );
    const selected = await fetch(`${first.url}api/revision`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
      body: JSON.stringify({
        version: firstState.version,
        changeId: firstArchive.metadata.reviewedChangeId,
      }),
    });
    assert.equal(selected.status, 200, await selected.clone().text());
    assert.equal(
      (await getState(first.url)).source.changeId,
      firstArchive.metadata.reviewedChangeId,
    );
    assert.equal(
      (await getState(second.url)).source.changeId,
      secondState.source.changeId,
    );
    const refs = (
      await run(
        "git",
        [
          `--git-dir=${gitDirectory}`,
          "for-each-ref",
          "--format=%(refname)%09%(objectname)",
          "refs/heads/jj-stamp/",
        ],
        f.repoPath,
      )
    ).stdout
      .trim()
      .split("\n");
    for (const archive of [firstArchive, secondArchive]) {
      const ownRefs = refs.filter((ref) =>
        ref.startsWith(`refs/heads/jj-stamp/${path.basename(archive.dir)}/`),
      );
      assert.equal(ownRefs.length, 2);
      assert.ok(ownRefs.some((ref) => ref.endsWith(`/base\t${f.base}`)));
      assert.ok(ownRefs.some((ref) => ref.endsWith(`/head\t${f.head}`)));
    }
    for (const ref of userRefs)
      assert.equal(
        (
          await run(
            "git",
            [`--git-dir=${gitDirectory}`, "rev-parse", ref],
            f.repoPath,
          )
        ).stdout.trim(),
        originalCommit,
      );
    assert.deepEqual(await readFile(path.join(gitDirectory, "HEAD")), gitHead);
    assert.equal(await recordedWorkspace(f.repoPath), before);
    assert.equal(
      await readFile(path.join(f.repoPath, "untouched.txt"), "utf8"),
      "unsnapshotted original bytes\n",
    );
  } finally {
    await manager.close();
  }
});

for (const cached of ["head", "base"] as const) {
  test(`only the missing PR ${cached === "head" ? "base" : "head"} is fetched into a unique namespaced ref`, async () => {
    const f = await fixture();
    const gitDirectory = await fixtureGitDirectory(f);
    await run(
      "git",
      [
        `--git-dir=${gitDirectory}`,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        f.remote,
        cached === "head" ? f.head : f.base,
      ],
      f.repoPath,
    );
    const userRefs = [
      "refs/heads/pr-review-base",
      "refs/heads/pr-review-head",
      "refs/heads/user-owned",
    ];
    for (const ref of userRefs)
      await run(
        "git",
        [`--git-dir=${gitDirectory}`, "update-ref", ref, f.mergeBase],
        f.repoPath,
      );
    const gitHead = await readFile(path.join(gitDirectory, "HEAD"));
    const before = await recordedWorkspace(f.repoPath);
    const manager = await f.manager();
    try {
      await manager.open("7");
      const archive = await f.archive();
      const fetches = f.calls.filter(
        (call) => call.command === "git" && call.args.includes("fetch"),
      );
      assert.equal(fetches.length, 1);
      const refspecs = fetches[0]!.args.filter((arg) =>
        arg.includes(":refs/heads/"),
      );
      assert.equal(
        refspecs.length,
        1,
        "do not fetch the already cached commit",
      );
      const [source, destination] = refspecs[0]!.split(":");
      assert.equal(source, cached === "head" ? f.base : "refs/pull/7/head");
      assert.ok(
        destination!.startsWith(
          `refs/heads/jj-stamp/${path.basename(archive.dir)}/`,
        ),
      );
      assert.ok(destination!.endsWith(cached === "head" ? "/base" : "/head"));
      assert.ok(fetches[0]!.args.includes(`--git-dir=${gitDirectory}`));
      assert.ok(fetches[0]!.args.includes("--no-write-fetch-head"));
      assert.equal(
        (
          await run(
            "git",
            [`--git-dir=${gitDirectory}`, "rev-parse", destination!],
            f.repoPath,
          )
        ).stdout.trim(),
        cached === "head" ? f.base : f.head,
      );
      for (const ref of userRefs)
        assert.equal(
          (
            await run(
              "git",
              [`--git-dir=${gitDirectory}`, "rev-parse", ref],
              f.repoPath,
            )
          ).stdout.trim(),
          f.mergeBase,
        );
      assert.deepEqual(
        await readFile(path.join(gitDirectory, "HEAD")),
        gitHead,
      );
      assert.equal(await recordedWorkspace(f.repoPath), before);
      assert.equal(
        await readFile(path.join(f.repoPath, "untouched.txt"), "utf8"),
        "unsnapshotted original bytes\n",
      );
    } finally {
      await manager.close();
    }
  });
}

test("existing schema-2 isolated review resumes unchanged through the original server without remote refresh", async () => {
  const f = await fixture();
  const repository = {
    owner: "test-owner",
    name: "test-repo",
    nameWithOwner: "test-owner/test-repo",
    url: f.repositoryUrl,
  };
  const legacy = await new PrReviewStore(f.dataHome).acquire(repository, 7);
  let metadata: Extract<PrMetadata, { schema: 2 }>;
  let annotated: string;
  try {
    // Construct a real old-style isolated archive instead of relabeling a linked
    // workspace. It has separate Git objects, independent jj history and drafts.
    await jj(f.repoPath, ["git", "init", "--colocate", legacy.workspace]);
    const gitDirectory = path.join(legacy.workspace, ".git");
    await run(
      "git",
      [
        `--git-dir=${gitDirectory}`,
        "fetch",
        "--no-tags",
        "--no-write-fetch-head",
        f.remote,
        `${f.head}:refs/heads/pr-review-head`,
        `${f.base}:refs/heads/pr-review-base`,
      ],
      legacy.workspace,
    );
    await jj(legacy.workspace, ["git", "import"]);
    await jj(legacy.workspace, [
      "new",
      `commit_id("${f.mergeBase}")`,
      "-m",
      "Reviewed PR #7",
    ]);
    const change = async (revision: string) =>
      (
        await jj(legacy.workspace, [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          revision,
          "-T",
          "change_id",
        ])
      ).stdout.trim();
    const reviewedChangeId = await change("@");
    await jj(legacy.workspace, [
      "new",
      "@",
      "-m",
      "Remaining PR #7: legacy local review",
    ]);
    await jj(legacy.workspace, ["restore", "--from", `commit_id("${f.head}")`]);
    const sourceChangeId = await change("@");
    const branches = [];
    for (const [codeChangeId, label] of [
      [reviewedChangeId, "Reviewed"],
      [sourceChangeId, "Remaining"],
    ]) {
      await jj(legacy.workspace, [
        "new",
        "--no-edit",
        "-r",
        `change_id("${codeChangeId}")`,
        "-m",
        `COMMENTS ${label} PR #7`,
      ]);
      branches.push({
        codeChangeId,
        commentsChangeId: await change(
          `children(change_id("${codeChangeId}")) & description(substring:"COMMENTS ${label} PR #7")`,
        ),
      });
    }
    metadata = {
      schema: 2,
      repository,
      pullRequest: f.summary,
      mergeBaseOid: f.mergeBase,
      headTreeOid: (
        await run(
          "git",
          [`--git-dir=${gitDirectory}`, "rev-parse", `${f.head}^{tree}`],
          legacy.workspace,
        )
      ).stdout.trim(),
      sourceChangeId,
      reviewedChangeId,
      branches,
    };
    await legacy.create(metadata);
    const service = new ReviewService({
      repoPath: legacy.workspace,
      revision: `change_id("${sourceChangeId}")`,
      comments: metadata,
    });
    try {
      const state = await service.getState();
      await service.comment({
        action: "add",
        version: state.version,
        path: "review.ts",
        line: 1,
        body: "Preserved schema-2 draft",
      });
    } finally {
      await service.drain();
    }
    annotated = (
      await jj(legacy.workspace, [
        "file",
        "show",
        "--ignore-working-copy",
        "-r",
        `change_id("${branches[1]!.commentsChangeId}")`,
        "--",
        'root-file:"review.ts"',
      ])
    ).stdout;
    assert.match(annotated, /Preserved schema-2 draft/);
  } finally {
    await legacy.release();
  }
  const metadataPath = path.join(legacy.directory, "review.json");
  const metadataBytes = await readFile(metadataPath);
  const legacyOperation = await latestOperation(legacy.workspace);
  const original = await recordedWorkspace(f.repoPath);
  const sharedRepository = await resolveRepoDirectory(f.repoPath);
  const scopedRoot = new PrReviewStore(f.dataHome, sharedRepository).root;
  assert.notEqual(
    await resolveRepoDirectory(legacy.workspace),
    sharedRepository,
  );
  await writeFile(
    f.data,
    JSON.stringify({
      ...f.summary,
      state: "MERGED",
      headRefOid: "a".repeat(40),
    }),
  );
  const callsBefore = f.calls.length;
  const manager = await f.manager({
    runner: async (command, args, cwd, limits) => {
      assert.ok(
        !(command === "git" && args.includes("fetch")),
        "legacy resume never fetches",
      );
      assert.ok(
        !(command === "gh" && args[0] === "pr"),
        "legacy resume never revalidates remote PR state",
      );
      return f.runner(command, args, cwd, limits);
    },
  });
  try {
    const opened = await manager.open("7");
    assert.equal(opened.url, `${manager.rootUrl}reviews/${legacy.key}/`);
    assert.equal(new URL(opened.url).origin, new URL(manager.rootUrl).origin);
    const context = await (await fetch(`${opened.url}api/pr/context`)).json();
    assert.equal(context.mode, "pr");
    assert.equal(
      context.pullRequest.state,
      "OPEN",
      "use archived metadata, not the merged remote PR",
    );
    assert.equal(context.originalWorkspaceUrl, manager.rootUrl);
    const stateResponse = await fetch(`${opened.url}api/state`);
    assert.equal(stateResponse.status, 200, await stateResponse.clone().text());
    const state = await stateResponse.json();
    assert.equal(state.source.changeId, metadata.sourceChangeId);
    assert.equal(state.canEditComments, true);
    const overlayResponse = await fetch(`${opened.url}api/comments/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
      body: JSON.stringify({ version: state.version, path: "review.ts" }),
    });
    assert.equal(
      overlayResponse.status,
      200,
      await overlayResponse.clone().text(),
    );
    assert.equal(
      (await overlayResponse.json()).comments[0].body,
      "Preserved schema-2 draft",
    );
    assert.equal(
      (
        await jj(legacy.workspace, [
          "file",
          "show",
          "--ignore-working-copy",
          "-r",
          `change_id("${metadata.branches[1]!.commentsChangeId}")`,
          "--",
          'root-file:"review.ts"',
        ])
      ).stdout,
      annotated,
    );
    assert.deepEqual(await readFile(metadataPath), metadataBytes);
    assert.equal(await latestOperation(legacy.workspace), legacyOperation);
    assert.equal(await recordedWorkspace(f.repoPath), original);
    assert.equal(
      await readFile(path.join(f.repoPath, "untouched.txt"), "utf8"),
      "unsnapshotted original bytes\n",
    );
    assert.equal(
      (await lstat(path.join(legacy.workspace, ".jj", "repo"))).isDirectory(),
      true,
    );
    await assert.rejects(lstat(scopedRoot), { code: "ENOENT" });
    assert.equal(
      f.calls
        .slice(callsBefore)
        .some(
          (call) =>
            call.args.includes("fetch") ||
            (call.command === "gh" && call.args[0] === "pr"),
        ),
      false,
    );
  } finally {
    await manager.close();
  }
  assert.deepEqual(await readFile(metadataPath), metadataBytes);
  await assert.rejects(lstat(path.join(legacy.directory, "active.lock")), {
    code: "ENOENT",
  });
});
