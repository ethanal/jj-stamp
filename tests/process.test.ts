import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  formatCommand,
  processFailureOutput,
  ProcessError,
  run,
} from "../server/process.ts";

test("failed commands retain all arguments with copyable POSIX shell quoting", () => {
  assert.equal(
    formatCommand("jj-hunk-tool", [
      "squash",
      "abc1234:2-4,7",
      "--from",
      "123abc",
    ]),
    "jj-hunk-tool squash abc1234:2-4,7 --from 123abc",
  );
  assert.equal(
    formatCommand("/path with spaces/tool", []),
    "'/path with spaces/tool'",
  );
  const args = [
    "",
    "two words",
    "it's quoted",
    '"double"',
    "$(printf injected)",
    "`printf injected`",
    "a;b",
    "*",
    "a\\b",
    "line\nbreak",
  ];
  const command = formatCommand(process.execPath, [
    "-e",
    "console.log(JSON.stringify(process.argv.slice(1)))",
    ...args,
  ]);
  const result = spawnSync("sh", ["-c", command], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("process failures include cwd and command without losing any tool output", async () => {
  const cwd = os.tmpdir();
  const args = [
    "-e",
    "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(1)",
  ];
  await assert.rejects(run(process.execPath, args, cwd), (error: unknown) => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.cwd, cwd);
    assert.equal(
      processFailureOutput(error),
      `Working directory: ${cwd}\nFailed command:\n${formatCommand(process.execPath, args)}\n\nout\nerr\n`,
    );
    return true;
  });
  assert.equal(
    processFailureOutput(
      new ProcessError(
        "jj-hunk-tool",
        ["squash"],
        { stdout: "", stderr: "" },
        1,
      ),
    ),
    "Failed command:\njj-hunk-tool squash\n\n",
  );
});

test("packaged hunk tool executes and reports its pinned wrapper path, not ambient PATH", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pinned-tool-"));
  const wrapper = path.join(
    root,
    "store path's wrapper",
    "bin",
    "jj-hunk-tool",
  );
  const ambient = path.join(root, "ambient", "jj-hunk-tool");
  await mkdir(path.dirname(wrapper), { recursive: true });
  await mkdir(path.dirname(ambient));
  await writeFile(
    wrapper,
    `#!${process.execPath}\nconsole.log(JSON.stringify(process.argv.slice(2))); console.error('pinned failure'); process.exit(1);\n`,
  );
  await writeFile(
    ambient,
    `#!${process.execPath}\nconsole.error('WRONG ambient tool'); process.exit(2);\n`,
  );
  await chmod(wrapper, 0o755);
  await chmod(ambient, 0o755);
  const oldPath = process.env.PATH;
  const oldTool = process.env.JJ_STAMP_HUNK_TOOL;
  t.after(async () => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldTool === undefined) delete process.env.JJ_STAMP_HUNK_TOOL;
    else process.env.JJ_STAMP_HUNK_TOOL = oldTool;
    await rm(root, { recursive: true });
  });
  process.env.PATH = path.dirname(ambient);
  process.env.JJ_STAMP_HUNK_TOOL = wrapper;
  const args = [
    "squash",
    "273b22d:20-21,24-29",
    "--from",
    "abc",
    "--into",
    "def",
    "--use-destination-message",
    "--keep-emptied",
  ];
  await assert.rejects(run("jj-hunk-tool", args, root), (error: unknown) => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.command, wrapper);
    assert.equal(error.exitCode, 1);
    assert.deepEqual(JSON.parse(error.result.stdout), args);
    assert.equal(error.result.stderr, "pinned failure\n");
    assert.equal(
      processFailureOutput(error),
      `Working directory: ${root}\nFailed command:\n${formatCommand(wrapper, args)}\n\n${error.result.stdout}${error.result.stderr}`,
    );
    // The printed command runs the same wrapper without the launcher's env.
    const copied = spawnSync(
      "/bin/sh",
      ["-c", formatCommand(error.command, error.args)],
      { cwd: root, encoding: "utf8", env: { PATH: path.dirname(ambient) } },
    );
    assert.equal(copied.status, 1, copied.stderr);
    assert.deepEqual(JSON.parse(copied.stdout), args);
    assert.equal(copied.stderr, error.result.stderr);
    return true;
  });
  // Non-Nix execution still uses PATH when there is no packaged override.
  delete process.env.JJ_STAMP_HUNK_TOOL;
  await assert.rejects(run("jj-hunk-tool", args, root), (error: unknown) => {
    assert.ok(error instanceof ProcessError);
    assert.equal(error.command, "jj-hunk-tool");
    assert.equal(error.exitCode, 2);
    assert.match(error.result.stderr, /WRONG ambient tool/);
    return true;
  });
});

async function waitFile(file: string): Promise<string> {
  for (let attempt = 0; attempt < 250; attempt++) {
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test(
  "run children survive terminal process-group signals and remain awaited through graceful shutdown",
  {
    skip:
      process.platform === "win32"
        ? "POSIX process groups are not available"
        : false,
    timeout: 15_000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-signals-"));
    const ready = path.join(root, "ready.json");
    const release = path.join(root, "release");
    const signalFile = path.join(root, "signal");
    const harness = path.join(root, "harness.mjs");
    const childScript = `
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ pid: process.pid }));
    const timer = setInterval(() => {
      if (fs.existsSync(${JSON.stringify(release)})) {
        clearInterval(timer);
        clearTimeout(deadline);
        process.stdout.write('mutation finished');
      }
    }, 20);
    const deadline = setTimeout(() => process.exit(71), 10000);
  `;
    await writeFile(
      harness,
      `
    import { writeFileSync } from 'node:fs';
    import { run } from ${JSON.stringify(pathToFileURL(path.resolve("server/process.ts")).href)};
    const signals = [];
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      signals.push(signal);
      writeFileSync(${JSON.stringify(signalFile)}, JSON.stringify(signals));
    });
    const result = await run(process.execPath, ['-e', ${JSON.stringify(childScript)}], ${JSON.stringify(root)});
    console.log(JSON.stringify({ signals, result }));
  `,
    );
    // A separate group protects this test runner when simulating a terminal's
    // broadcast. run() must create another group for the history-writing child.
    const parent = spawn(process.execPath, ["--import", "tsx", harness], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      closed = false,
      childPid: number | undefined;
    parent.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    parent.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    const finished = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      parent.once("error", reject);
      parent.once("close", (code, signal) => {
        closed = true;
        resolve({ code, signal });
      });
    });
    t.after(() => {
      if (!closed) {
        for (const pid of [parent.pid, childPid]) {
          if (!pid) continue;
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* Already exited. */
          }
        }
      }
    });
    childPid = JSON.parse(await waitFile(ready)).pid;
    assert.ok(parent.pid);
    process.kill(-parent.pid, "SIGINT");
    for (
      let i = 0;
      i < 100 && !(await waitFile(signalFile)).includes("SIGINT");
      i++
    )
      await delay(10);
    process.kill(-parent.pid, "SIGTERM");
    for (
      let i = 0;
      i < 100 && !(await waitFile(signalFile)).includes("SIGTERM");
      i++
    )
      await delay(10);
    assert.equal(
      closed,
      false,
      "parent must still be awaiting the in-flight child",
    );
    await writeFile(release, "finish");
    assert.deepEqual(await finished, { code: 0, signal: null }, stderr);
    assert.deepEqual(JSON.parse(stdout), {
      signals: ["SIGINT", "SIGTERM"],
      result: { stdout: "mutation finished", stderr: "" },
    });
  },
);
