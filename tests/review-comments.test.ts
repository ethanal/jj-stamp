import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ReviewService, ApiError, type State } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { startLocalServer } from "../server/http.ts";
import {
  captureReviewFile,
  replaceReviewFile,
} from "../server/review-comments.ts";
import {
  parseReviewComments,
  type ReviewCommentMutation,
} from "../src/review-comments.ts";

const filename = "src/main.ts";
const original = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const working = original.replace("b = 2", "b = 20");
async function fixture(t: TestContext, crlf = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-comments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await jj(root, ["git", "init", "--no-colocate", "."]);
  await jj(root, ["config", "set", "--repo", "user.name", "Review Tester"]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "review@example.test",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await mkdir(path.join(root, "src"));
  const file = path.join(root, filename);
  const encode = (text: string) =>
    crlf ? text.replaceAll("\n", "\r\n") : text;
  await writeFile(file, encode(original));
  await jj(root, ["commit", "-m", "Mutable parent"]);
  await writeFile(file, encode(working));
  await jj(root, ["describe", "-m", "Review working copy"]);
  const service = new ReviewService({ repoPath: root });
  const state = await service.getState();
  return { root, file, service, state, source: encode(working) };
}
const add = (state: State, extra = {}): ReviewCommentMutation => ({
  version: state.version,
  path: filename,
  action: "add",
  line: 2,
  body: "Please simplify",
  ...extra,
});
function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}
const selections = (state: State, file = filename) => {
  const hunk = state.files.find((entry) => entry.path === file)!.hunks[0];
  return [
    {
      id: hunk.id,
      lines: hunk.rows
        .filter((row) => /^[+-]/.test(row.raw))
        .map((row) => row.index),
    },
  ];
};

test("real-jj comment CRUD persists through restart, preserves mode/CRLF and invalidates previews", async (t) => {
  for (const crlf of [false, true]) {
    const { service, state, root, file, source } = await fixture(t, crlf);
    assert.equal(state.canEditComments, true);
    await chmod(file, 0o640);
    const preview = await service.preview({
      version: state.version,
      target: state.parent!.changeId,
      selections: selections(state),
    });
    const added = await service.comment(
      add(state, { endLine: 3, body: "First\nSecond" }),
    );
    assert.equal(added.state.canUndo, false);
    assert.equal(added.state.canEditComments, true);
    assert.equal(added.state.source.changeId, state.source.changeId);
    assert.notEqual(added.state.version, state.version);
    assert.equal((await lstat(file)).mode & 0o777, 0o640);
    const contents = await readFile(file, "utf8");
    const comment = parseReviewComments(filename, contents).comments[0];
    assert.equal(comment.body, "First\nSecond");
    assert.equal(comment.anchorLine, 4);
    assert.equal(comment.endAnchorLine, 5);
    assert.equal(comment.endMarkerLine, 6);
    if (crlf)
      assert.equal(contents.replaceAll("\r\n", "").includes("\n"), false);
    await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
    await rejectsCode(service.comment(add(state)), "STALE_STATE");
    const restarted = new ReviewService({ repoPath: root });
    const refreshed = await restarted.getState();
    assert.deepEqual(refreshed, added.state);
    const pinned = await restarted.getFile({
      version: refreshed.version,
      path: filename,
    });
    assert.equal(pinned.newFile!.contents, contents);
    assert.deepEqual(
      parseReviewComments(filename, pinned.newFile!.contents).comments[0],
      comment,
    );
    const edited = await restarted.comment({
      action: "edit",
      version: refreshed.version,
      path: filename,
      id: comment.id,
      body: "Changed",
    });
    assert.equal(
      parseReviewComments(filename, await readFile(file, "utf8")).comments[0]
        .body,
      "Changed",
    );
    const removed = await restarted.comment({
      action: "remove",
      version: edited.state.version,
      path: filename,
      id: comment.id,
    });
    assert.equal(await readFile(file, "utf8"), source);
    assert.equal(removed.state.canUndo, false);
    assert.equal((await lstat(file)).mode & 0o777, 0o640);
  }
});

test("comments only authorize live mutable conflict-free @, independent of graph filtering", async (t) => {
  const { root, file, state } = await fixture(t);
  const historical = new ReviewService({
    repoPath: root,
    revision: state.parent!.changeId,
  });
  const historyState = await historical.getState();
  assert.equal(historyState.canEditComments, false);
  await rejectsCode(
    historical.comment(add(historyState)),
    "COMMENTS_UNAVAILABLE",
  );
  assert.equal(await readFile(file, "utf8"), working);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "@",
  ]);
  const immutable = new ReviewService({ repoPath: root });
  const immutableState = await immutable.getState();
  assert.equal(immutableState.canEditComments, false);
  await rejectsCode(
    immutable.comment(add(immutableState)),
    "COMMENTS_UNAVAILABLE",
  );
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."immutable_heads()"',
    "root()",
  ]);
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."conflicts()"',
    "@",
  ]);
  const conflicted = new ReviewService({ repoPath: root });
  const conflictState = await conflicted.getState();
  assert.equal(conflictState.canEditComments, false);
  await rejectsCode(
    conflicted.comment(add(conflictState)),
    "COMMENTS_UNAVAILABLE",
  );
  await jj(root, [
    "config",
    "set",
    "--repo",
    'revset-aliases."conflicts()"',
    "none()",
  ]);
  // mine() excludes this source; it is still fully eligible for comments.
  await jj(root, [
    "config",
    "set",
    "--repo",
    "user.email",
    "someone-else@example.test",
  ]);
  const filtered = new ReviewService({ repoPath: root });
  const eligible = await filtered.getState();
  assert.equal(eligible.canEditComments, true);
  assert.ok(!(await filtered.getLog()).rows.some((row) => row.isWorkingCopy));
  assert.equal(
    (await filtered.comment(add(eligible))).state.canEditComments,
    true,
  );
});

test("serialized duplicate submissions write once; unsnapshotted edits and workspace movement stale requests", async (t) => {
  const { service, state, file, root } = await fixture(t);
  const results = await Promise.allSettled([
    service.comment(add(state)),
    service.comment(add(state)),
  ]);
  assert.equal(
    results.filter((result) => result.status === "fulfilled").length,
    1,
  );
  const failure = results.find((result) => result.status === "rejected");
  assert.ok(
    failure?.status === "rejected" && failure.reason.code === "STALE_STATE",
  );
  assert.equal(
    parseReviewComments(filename, await readFile(file, "utf8")).comments.length,
    1,
  );
  const fresh = await service.getState();
  await writeFile(
    file,
    (await readFile(file, "utf8")) + "const external = 1;\n",
  );
  await rejectsCode(service.comment(add(fresh)), "STALE_STATE");
  const pinned = await service.getState();
  await jj(root, ["new", "-m", "Different workspace change"]);
  await rejectsCode(service.comment(add(pinned)), "STALE_STATE");
});

test("exact captured bytes and inode identity reject external replacement, hardlinks, symlinks and traversal", async (t) => {
  const { root, file, service, state } = await fixture(t);
  const captured = await captureReviewFile(root, filename);
  await writeFile(file, "external edit\n");
  await rejectsCode(
    replaceReviewFile(captured, Buffer.from("must not overwrite\n")),
    "STALE_STATE",
  );
  assert.equal(await readFile(file, "utf8"), "external edit\n");
  await writeFile(file, working);
  await link(file, path.join(root, "hardlink.ts"));
  await rejectsCode(
    service.comment(add(await service.getState())),
    "COMMENTS_UNAVAILABLE",
  );
  await rm(path.join(root, "hardlink.ts"));
  await rm(file);
  await symlink(path.join(root, "target.ts"), file);
  await writeFile(path.join(root, "target.ts"), working);
  await rejectsCode(captureReviewFile(root, filename), "COMMENTS_UNAVAILABLE");
  for (const bad of [
    "../outside.ts",
    "/tmp/outside.ts",
    "src/../main.ts",
    ".jj/repo/config.toml",
    "src\\main.ts",
  ])
    await rejectsCode(captureReviewFile(root, bad), "INVALID_PATH");
  await rejectsCode(
    service.comment({ ...add(state), path: "../outside.ts" }),
    "STALE_STATE",
  );
});

test("pinned byte mismatch and interleaved metadata changes fail before comment writes", async (t) => {
  const { root, file } = await fixture(t);
  let race: "bytes" | "metadata" | undefined;
  let metadata = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      const result = await jj(cwd, args);
      if (race === "bytes" && args[0] === "file")
        return {
          ...result,
          stdout: result.stdout + "extra\n",
          stdoutBytes: Buffer.from(result.stdout + "extra\n"),
        };
      if (
        race === "metadata" &&
        args[0] === "log" &&
        args.includes("--no-graph") &&
        ++metadata === 2
      )
        await writeFile(file, working + "const external = 2;\n");
      return result;
    },
  });
  const state = await service.getState();
  race = "bytes";
  await rejectsCode(service.comment(add(state)), "STALE_STATE");
  assert.equal(await readFile(file, "utf8"), working);
  race = "metadata";
  await rejectsCode(service.comment(add(state)), "STALE_STATE");
  assert.doesNotMatch(await readFile(file, "utf8"), /JJ-STAMP/);
});

test("post-write refresh failures honestly report changed files without retries or rollback", async (t) => {
  const { root, file } = await fixture(t);
  let fail = false;
  let failures = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (
        fail &&
        args[0] === "log" &&
        (await readFile(file, "utf8")).includes("JJ-STAMP")
      ) {
        fail = false;
        failures++;
        throw new Error("simulated refresh failure");
      }
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  const preview = await service.preview({
    version: state.version,
    target: state.parent!.changeId,
    selections: selections(state),
  });
  fail = true;
  await assert.rejects(
    service.comment(add(state)),
    (error: unknown) =>
      error instanceof ApiError &&
      error.code === "PARTIAL_FAILURE" &&
      error.details?.fileMayHaveChanged === true &&
      /already changed/.test(error.message),
  );
  const changed = await readFile(file, "utf8");
  assert.equal(parseReviewComments(filename, changed).comments.length, 1);
  await service.getState();
  assert.equal(await readFile(file, "utf8"), changed);
  assert.equal(failures, 1);
  await rejectsCode(service.squash(preview.token), "STALE_PREVIEW");
});

test("post-write inode/mode changes are detected even when bytes remain identical", async (t) => {
  const { root, file } = await fixture(t);
  let race = false;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (
        race &&
        args[0] === "log" &&
        (await readFile(file, "utf8")).includes("JJ-STAMP")
      ) {
        race = false;
        await chmod(file, 0o600);
      }
      return jj(cwd, args);
    },
  });
  const state = await service.getState();
  race = true;
  await rejectsCode(service.comment(add(state)), "PARTIAL_FAILURE");
  assert.equal(
    parseReviewComments(filename, await readFile(file, "utf8")).comments.length,
    1,
  );
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
});

test("history guard ignores plain brand references but blocks malformed reserved source lines", async (t) => {
  const { file, service } = await fixture(t);
  await writeFile(file, working + "const name = 'JJ-STAMP';\n");
  const brand = await service.getState();
  await service.preview({
    version: brand.version,
    target: brand.parent!.changeId,
    selections: selections(brand),
  });
  await writeFile(file, working + "//JJ-STAMP(bad): reserved\n");
  const reserved = await service.getState();
  await rejectsCode(
    service.preview({
      version: reserved.version,
      target: reserved.parent!.changeId,
      selections: selections(reserved),
    }),
    "REVIEW_COMMENTS_PRESENT",
  );
});

test("squash and legacy preview block any marker-looking pinned side, without blocking other files", async (t) => {
  const { service, state, root, file } = await fixture(t);
  const annotated = (await service.comment(add(state))).state;
  const selected = selections(annotated);
  await rejectsCode(
    service.preview({
      version: annotated.version,
      target: annotated.parent!.changeId,
      selections: selected,
    }),
    "REVIEW_COMMENTS_PRESENT",
  );
  await rejectsCode(
    service.squashLines({ version: annotated.version, selections: selected }),
    "REVIEW_COMMENTS_PRESENT",
  );
  await writeFile(path.join(root, "other.ts"), "const other = 1;\n");
  const both = await service.getState();
  await service.squashLines({
    version: both.version,
    selections: selections(both, "other.ts"),
  });
  assert.match(await readFile(file, "utf8"), /JJ-STAMP/);
  // Move markers into the base, then remove them from source: source-only
  // scanning would silently allow their deletion during squash.
  await jj(root, ["commit", "-m", "Pinned annotations"]);
  await writeFile(file, working);
  const baseMarkers = new ReviewService({ repoPath: root });
  const next = await baseMarkers.getState();
  await rejectsCode(
    baseMarkers.squashLines({
      version: next.version,
      selections: selections(next),
    }),
    "REVIEW_COMMENTS_PRESENT",
  );
  await writeFile(file, "const markerLooking = 'JJ-STAMP(bad)';\n");
  const malformed = await baseMarkers.getState();
  await rejectsCode(
    baseMarkers.squashLines({
      version: malformed.version,
      selections: selections(malformed),
    }),
    "REVIEW_COMMENTS_PRESENT",
  );
});

test("HTTP comment validation, loopback protection and benign PR context fallback", async (t) => {
  const { service, state, root, file } = await fixture(t);
  const server = await startLocalServer({ service, assetsDir: root, port: 0 });
  t.after(() => server.close());
  const endpoint = new URL("api/comments", server.url);
  const request = (body: unknown, headers = {}) =>
    fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fold-Request": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const context = await fetch(new URL("api/pr/context", server.url));
  assert.equal(context.status, 200);
  assert.equal(await context.json(), null);
  for (const bad of [
    { ...add(state), action: "replace" },
    { ...add(state), line: 0 },
    { ...add(state), line: 1.5 },
    { ...add(state), body: "" },
    { ...add(state), body: "unsafe\r\ntext" },
    { ...add(state), body: "unsafe\u2028text" },
    { ...add(state), unknown: true },
    {
      version: state.version,
      path: filename,
      action: "remove",
      id: "not-a-uuid",
    },
    {
      version: state.version,
      path: filename,
      action: "edit",
      id: "12345678-1234-1234-1234-123456789abc",
      body: "x",
      line: 1,
    },
  ]) {
    const response = await request(bad);
    assert.equal(response.status, 400, JSON.stringify(bad));
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  assert.equal(
    (await request(add(state), { "X-Fold-Request": "0" })).status,
    403,
  );
  assert.equal(
    (await request(add(state), { Origin: "https://evil.example" })).status,
    403,
  );
  assert.equal(await readFile(file, "utf8"), working);
  const response = await request(add(state));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.state.version);
  assert.equal(result.state.canEditComments, true);
  assert.equal((await request(add(state))).status, 409);
});
