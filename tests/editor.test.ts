import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { ReviewService, ApiError } from "../server/service.ts";
import { jj, run, ProcessError } from "../server/process.ts";
import { startLocalServer } from "../server/http.ts";
import { createDemo } from "./fixtures.ts";

type Call = { command: string; args: string[]; cwd: string };
async function fixture(t: TestContext, runner?: typeof run) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "fold-editor-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const root = await createDemo(dataDir);
  const calls: Call[] = [];
  const service = new ReviewService({
    repoPath: root,
    editorRunner: async (command, args, cwd) => {
      calls.push({ command, args, cwd });
      return runner
        ? runner(command, args, cwd)
        : { stdout: "1\n", stderr: "" };
    },
  });
  const state = await service.getState();
  const input = { version: state.version, path: state.files[0].path, line: 17 };
  return { dataDir, root, calls, service, state, input };
}
function rejectsCode(promise: Promise<unknown>, code: string) {
  return assert.rejects(
    promise,
    (error: unknown) => error instanceof ApiError && error.code === code,
  );
}
function expressionData(call: Call) {
  assert.equal(call.command, "nvim");
  assert.deepEqual(call.args.slice(0, 3), [
    "--server",
    "127.0.0.1:4242",
    "--remote-expr",
  ]);
  assert.equal(call.args.length, 4);
  // Parse only the fixed expression structure and Vim single-quoted literals.
  // A filename that breaks out of its data literal makes this assertion fail.
  const expression =
    /^luaeval\('((?:[^']|'')*)', \['((?:[^']|'')*)', (\d+)\]\)$/.exec(
      call.args[3],
    );
  assert.ok(expression, call.args[3]);
  return {
    lua: expression[1].replaceAll("''", "'"),
    file: expression[2].replaceAll("''", "'"),
    line: Number(expression[3]),
  };
}

test("editor opens the absolute workspace file at its one-based line without rewriting history", async (t) => {
  const { service, state, input, calls, root } = await fixture(t);
  const contents = await readFile(path.join(root, input.path), "utf8");
  assert.deepEqual(await service.openEditor(input), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, root);
  const data = expressionData(calls[0]);
  assert.equal(data.file, path.join(root, input.path));
  assert.equal(data.line, 17);
  assert.match(data.lua, /vim\.fn\.bufadd\(a\[1\]\)/);
  assert.match(data.lua, /vim\.api\.nvim_win_set_cursor/);
  assert.match(
    data.lua,
    /math\.min\(a\[2\], vim\.api\.nvim_buf_line_count\(b\)\)/,
  );
  assert.doesNotMatch(data.lua, /vim\.cmd|execute|feedkeys/);
  assert.deepEqual(await service.getState(), state);
  assert.equal(await readFile(path.join(root, input.path), "utf8"), contents);
});

test("editor passes special filenames as literal data, including Vim and shell metacharacters", async (t) => {
  const { service, root, calls } = await fixture(t);
  const name = "+odd'|%#<CR>$(touch-PWNED);[x].txt";
  await writeFile(path.join(root, name), "one\ntwo\n");
  const state = await service.getState();
  assert.ok(state.files.some((file) => file.path === name));
  assert.deepEqual(
    await service.openEditor({ version: state.version, path: name, line: 2 }),
    { ok: true },
  );
  assert.equal(expressionData(calls[0]).file, path.join(root, name));
  assert.equal(expressionData(calls[0]).line, 2);
  assert.match(calls[0].args[3], /odd''\|/);
});

test("editor rejects malformed inputs, traversal and non-diff paths without invoking Neovim", async (t) => {
  const { service, input, calls } = await fixture(t);
  for (const override of [
    { line: 0 },
    { line: -1 },
    { line: 1.5 },
    { line: Infinity },
    { line: Number.MAX_SAFE_INTEGER + 1 },
    { line: "1" },
    { path: "../outside" },
    { path: "/etc/passwd" },
    { path: "src/../src/notifications.ts" },
    { path: "src//notifications.ts" },
    { path: "./src/notifications.ts" },
    { path: "src/notifications.ts\u0000" },
    { path: "src/a\n:!touch PWNED" },
    { version: "invalid" },
    { target: "elsewhere" },
  ]) {
    await rejectsCode(
      service.openEditor({ ...input, ...override } as typeof input),
      "INVALID_REQUEST",
    );
  }
  await rejectsCode(
    service.openEditor({ ...input, path: "not-in-diff.txt" }),
    "INVALID_PATH",
  );
  await rejectsCode(
    service.openEditor({ ...input, version: "0".repeat(64) }),
    "STALE_STATE",
  );
  assert.equal(calls.length, 0);
});

test("editor rejects versions invalidated by source rewrites or revision selection", async (t) => {
  const { service, input, calls, root } = await fixture(t);
  await jj(root, ["describe", "-m", "rewritten"]);
  await rejectsCode(service.openEditor(input), "STALE_STATE");
  const state = await service.getState();
  await service.selectRevision({
    version: state.version,
    changeId: state.targets[0].changeId,
  });
  await rejectsCode(
    service.openEditor({ ...input, version: state.version }),
    "STALE_STATE",
  );
  assert.equal(calls.length, 0);
});

test("editor does not snapshot unsaved workspace edits and keeps a non-working-copy source selected", async (t) => {
  const { service, input, root, state, calls } = await fixture(t);
  await jj(root, ["new", "-m", "new workspace change"]);
  const selected = await service.getState();
  assert.equal(selected.source.changeId, state.source.changeId);
  await writeFile(
    path.join(root, input.path),
    "workspace bytes different from selected source\n",
  );
  assert.deepEqual(
    await service.openEditor({ ...input, version: selected.version }),
    { ok: true },
  );
  assert.equal(expressionData(calls[0]).file, path.join(root, input.path));
  const operation = (
    await jj(root, [
      "op",
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-n",
      "1",
      "-T",
      "self.id()",
    ])
  ).stdout.trim();
  assert.equal(
    operation,
    selected.operation,
    "editor must not snapshot or rewrite jj history",
  );
});

test("editor revalidates repository metadata immediately before dispatch", async (t) => {
  const { root } = await fixture(t);
  let race = false;
  let metadataReads = 0;
  let editorCalls = 0;
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      if (race && args[0] === "log" && ++metadataReads === 3)
        await jj(root, ["describe", "-m", "intervening rewrite"]);
      return jj(cwd, args);
    },
    editorRunner: async () => {
      editorCalls++;
      return { stdout: "1", stderr: "" };
    },
  });
  const state = await service.getState();
  race = true;
  await rejectsCode(
    service.openEditor({
      version: state.version,
      path: state.files[0].path,
      line: 1,
    }),
    "STALE_STATE",
  );
  assert.equal(editorCalls, 0);
});

test("cold editor validation never snapshots jj or invokes the hunk tool", async (t) => {
  const { root, input, state } = await fixture(t);
  await writeFile(path.join(root, input.path), "unsnapshotted contents\n");
  const commands: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: async (cwd, args) => {
      commands.push(args);
      return jj(cwd, args);
    },
    toolRunner: async () => {
      assert.fail("editor must never invoke the hunk tool");
    },
    editorRunner: async () => ({ stdout: "1", stderr: "" }),
  });
  assert.deepEqual(await service.openEditor(input), { ok: true });
  assert.ok(commands.length > 0);
  assert.ok(
    commands.every((args) => args.includes("--ignore-working-copy")),
    JSON.stringify(commands),
  );
  const operation = (
    await jj(root, [
      "op",
      "log",
      "--ignore-working-copy",
      "--no-graph",
      "-n",
      "1",
      "-T",
      "self.id()",
    ])
  ).stdout.trim();
  assert.equal(operation, state.operation);
});

test("editor rejects deleted files even if recreated in the workspace", async (t) => {
  const { service, root, input, calls } = await fixture(t);
  await rm(path.join(root, input.path));
  const state = await service.getState();
  assert.match(
    state.files.find((file) => file.path === input.path)!.patch,
    /deleted file mode/,
  );
  await writeFile(path.join(root, input.path), "recreated\n");
  await rejectsCode(
    service.openEditor({ ...input, version: state.version }),
    "EDITOR_FILE_UNAVAILABLE",
  );
  assert.equal(calls.length, 0);
});

test("editor rejects absent files, directories, file symlinks, and directory symlinks inside or outside the workspace", async (t) => {
  const { service, root, input, calls, dataDir } = await fixture(t);
  const file = path.join(root, input.path);
  const original = await readFile(file);
  await rm(file);
  await rejectsCode(service.openEditor(input), "EDITOR_FILE_UNAVAILABLE");
  await mkdir(file);
  await rejectsCode(service.openEditor(input), "EDITOR_FILE_UNAVAILABLE");
  await rm(file, { recursive: true });
  for (const target of [
    path.join(root, "src/preferences.ts"),
    path.join(dataDir, "outside.txt"),
  ]) {
    await writeFile(target, "symlink target\n");
    await symlink(target, file);
    await rejectsCode(service.openEditor(input), "EDITOR_FILE_UNAVAILABLE");
    await rm(file);
  }
  await writeFile(file, original);
  const src = path.join(root, "src");
  for (const target of [
    path.join(root, "moved-src"),
    path.join(dataDir, "outside-src"),
  ]) {
    await rename(src, target);
    await symlink(target, src);
    await rejectsCode(service.openEditor(input), "EDITOR_FILE_UNAVAILABLE");
    await rm(src);
    await rename(target, src);
  }
  assert.equal(calls.length, 0);
});

test("editor failures explain the required executable and existing listening session", async (t) => {
  let failure: unknown = Object.assign(new Error("spawn nvim ENOENT"), {
    code: "ENOENT",
  });
  const { service, input } = await fixture(t, async () => {
    if (failure) throw failure;
    return { stdout: "", stderr: "E5108: failed to open buffer" };
  });
  for (const problem of [
    failure,
    new ProcessError(
      "nvim",
      [],
      { stdout: "", stderr: "connection refused" },
      1,
    ),
    null,
  ]) {
    failure = problem;
    await assert.rejects(service.openEditor(input), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "EDITOR_UNAVAILABLE");
      assert.match(error.message, /PATH.*nvim --listen 127\.0\.0\.1:4242/);
      assert.match(
        error.message,
        /ENOENT|connection refused|failed to open buffer/,
      );
      return true;
    });
  }
});

test("editor dispatch remains in the shared serialized queue until Neovim responds", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { service, input, calls } = await fixture(t, async () => {
    started();
    await gate;
    return { stdout: "1", stderr: "" };
  });
  const first = service.openEditor(input);
  await entered;
  const second = service.openEditor({ ...input, line: 2 });
  let readFinished = false;
  const read = service.getState().then(() => {
    readFinished = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.length, 1);
  assert.equal(readFinished, false);
  release();
  await Promise.all([first, second, read]);
  assert.equal(calls.length, 2);
});

test("editor HTTP endpoint requires protected same-origin JSON and strictly validates its body", async (t) => {
  const { service, input, calls, dataDir } = await fixture(t);
  const server = await startLocalServer({ service, assetsDir: dataDir });
  t.after(() => server.close());
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(new URL("api/editor", server.url), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Fold-Request": "1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const forbiddenHeaders: Record<string, string>[] = [
    { "X-Fold-Request": "" },
    { "Content-Type": "text/plain" },
    { Origin: "https://evil.example" },
    { "Sec-Fetch-Site": "cross-site" },
  ];
  for (const headers of forbiddenHeaders) {
    assert.equal(
      (await post(input, headers)).status,
      403,
      JSON.stringify(headers),
    );
  }
  const wrongHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const req = request(
        new URL("api/editor", server.url),
        {
          method: "POST",
          headers: {
            Host: "evil.example",
            "Content-Type": "application/json",
            "X-Fold-Request": "1",
          },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify(input));
    },
  );
  assert.equal(wrongHostStatus, 403);
  for (const override of [
    { line: 0 },
    { line: 1.5 },
    { line: "2" },
    { line: null },
    { extra: true },
    { version: "bad" },
  ]) {
    const response = await post({ ...input, ...override });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "INVALID_REQUEST");
  }
  assert.equal(calls.length, 0);
  const response = await post(input);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 1);
});
