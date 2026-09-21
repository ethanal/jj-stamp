import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { jj, run } from "../server/process.ts";
import type { State } from "../server/service.ts";
import { createDemo } from "./fixtures.ts";

const executable = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const packageVersion = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean | Promise<boolean>,
  message: () => string,
  timeout = 15_000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, message());
    await pause(20);
  }
}
async function exists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function sandbox(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-cli-"));
  // Register cleanup first: subsequent child cleanup hooks are explicitly run below
  // before this directory is removed.
  const children: ReturnType<typeof launch>[] = [];
  const bin = path.join(root, "bin");
  const opened = path.join(root, "opened-urls");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "xdg-open"),
    '#!/bin/sh\nprintf "%s\\n" "$1" >> "$JJ_STAMP_TEST_OPENED"\n',
  );
  await chmod(path.join(bin, "xdg-open"), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    XDG_STATE_HOME: path.join(root, "state"),
    JJ_STAMP_TEST_OPENED: opened,
  };
  // Keep a forced-cleanup handle for the deliberately blocked subprocess. Real
  // jj commands run in isolated process groups to survive terminal signals.
  const blockedGroups = new Set<number>();
  const releaseGates: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const release of releaseGates) await release();
    for (const child of children) await child.cleanup();
    for (const pid of blockedGroups) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    bin,
    opened,
    blockedGroups,
    releaseGates,
    start(args: string[], cwd = root, overrides: NodeJS.ProcessEnv = {}) {
      const child = launch(args, cwd, { ...env, ...overrides });
      children.push(child);
      return child;
    },
  };
}

function launch(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  // Execute the actual package bin, including its shebang, not a source import.
  // A dedicated process group also lets failed tests clean up jj descendants.
  const child: ChildProcess = spawn(executable, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "",
    stderr = "",
    ended = false;
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    child.once("error", (error) => {
      ended = true;
      reject(error);
    });
    child.once("close", (code, signal) => {
      ended = true;
      resolve({ code, signal });
    });
  });
  // Attach a rejection observer immediately, including when a startup wait fails.
  void exit.catch(() => {});
  child.stdout!.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr!.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });
  const diagnostics = () =>
    `CLI ${JSON.stringify(args)}\nstdout: ${stdout}\nstderr: ${stderr}`;
  const killGroup = () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
  };
  // Independent watchdog: a timed-out test cannot leave a server or jj child alive.
  const watchdog = setTimeout(killGroup, 45_000);
  watchdog.unref();
  return {
    child,
    exit,
    diagnostics,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    get ended() {
      return ended;
    },
    async done() {
      await until(() => ended, diagnostics);
      return exit;
    },
    async url() {
      await until(
        () =>
          ended ||
          /jj-stamp listening on (http:\/\/127\.0\.0\.1:\d+\/)/.test(stdout),
        diagnostics,
      );
      assert.equal(ended, false, diagnostics());
      const url = stdout.match(
        /jj-stamp listening on (http:\/\/127\.0\.0\.1:\d+\/)/,
      )![1];
      assert.ok(Number(new URL(url).port) > 0);
      return url;
    },
    async stop(signal: NodeJS.Signals) {
      assert.equal(child.kill(signal), true, diagnostics());
      assert.deepEqual(
        await this.done(),
        { code: 0, signal: null },
        diagnostics(),
      );
      assert.match(stdout, /Stopping jj-stamp/);
    },
    async cleanup() {
      if (!ended) {
        child.kill("SIGTERM");
        try {
          await until(() => ended, diagnostics, 3_000);
        } catch {
          killGroup();
        }
      }
      // Kill lingering descendants even if the CLI itself already exited.
      killGroup();
      await exit.catch(() => {});
      clearTimeout(watchdog);
    },
  };
}

function request(
  url: string,
  pathname: string,
  options: {
    method?: string;
    headers?: http.OutgoingHttpHeaders;
    body?: string;
  } = {},
) {
  return new Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
  }>((resolve, reject) => {
    const req = http.request(
      new URL(pathname, url),
      {
        method: options.method ?? "GET",
        headers: options.headers,
        agent: false,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(15_000, () =>
      req.destroy(new Error("HTTP request timed out")),
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const revisionId = async (repo: string) =>
  (
    await jj(repo, ["log", "--no-graph", "-r", "@", "-T", "change_id"])
  ).stdout.trim();

test(
  "built CLI help and version work outside a repository without running jj or opening a browser",
  { timeout: 30_000 },
  async (t) => {
    const box = await sandbox(t);
    // Make tool invocations observable, and fatal, even when real tools are on PATH.
    const invoked = path.join(box.root, "invoked-tools");
    for (const name of ["jj", "jj-hunk-tool"]) {
      await writeFile(
        path.join(box.bin, name),
        `#!/bin/sh\nprintf '%s\\n' '${name}' >> '${invoked}'\nexit 91\n`,
      );
      await chmod(path.join(box.bin, name), 0o755);
    }
    for (const flag of ["--help", "-h", "--version", "-V"]) {
      const cli = box.start([flag]);
      assert.deepEqual(
        await cli.done(),
        { code: 0, signal: null },
        cli.diagnostics(),
      );
      assert.equal(cli.stderr, "");
      if (flag.includes("help") || flag === "-h")
        assert.match(cli.stdout, /Usage: jj-stamp/);
      else assert.equal(cli.stdout.trim(), `jj-stamp ${packageVersion}`);
      assert.doesNotMatch(cli.stdout, /listening on/);
    }
    assert.equal(await exists(invoked), false);
    assert.equal(await exists(box.opened), false);
    assert.equal(await exists(path.join(box.root, "state")), false);
  },
);

test(
  "invalid arguments, ports, revisions and non-repositories fail before serving or opening",
  { timeout: 60_000 },
  async (t) => {
    const box = await sandbox(t);
    const repo = await createDemo(box.root);
    const cases: Array<{ args: string[]; error: RegExp }> = [
      { args: [], error: /repo|workspace/ },
      { args: ["--unknown-option"], error: /Unknown option/ },
      {
        args: ["--repository"],
        error: /argument missing|requires an argument/,
      },
      { args: ["--port"], error: /argument missing|requires an argument/ },
      { args: ["one", "two"], error: /one change ID/ },
      { args: [""], error: /one change ID/ },
      ...["-1", "65536", "1.5", "abc", "1e3", "", " 123", "Infinity"].map(
        (port) => ({
          args: [`--port=${port}`],
          error: /--port must be an integer/,
        }),
      ),
      {
        args: ["--repository", repo, "does_not_exist_12345"],
        error: /requested revision cannot be resolved/,
      },
      {
        args: ["--repository", repo, "all()"],
        error: /exactly one|multiple|single/i,
      },
      { args: ["--repository", box.root], error: /repo|workspace/ },
      {
        args: ["--repository", path.join(box.root, "missing")],
        error: /ENOENT/,
      },
    ];
    for (const { args, error } of cases) {
      await t.test(JSON.stringify(args), async () => {
        const cli = box.start(args);
        assert.deepEqual(
          await cli.done(),
          { code: 1, signal: null },
          cli.diagnostics(),
        );
        assert.match(cli.stderr, error);
        assert.doesNotMatch(cli.stdout, /listening on|http:\/\//);
        assert.equal(await exists(box.opened), false);
      });
    }
  },
);

test(
  "non-@ change serves packaged UI from a foreign cwd and enforces loopback request security",
  { timeout: 60_000 },
  async (t) => {
    const box = await sandbox(t);
    const repo = await createDemo(box.root);
    const selectedId = await revisionId(repo);
    await jj(repo, ["new", "-m", "Descendant outside this review"]);
    assert.notEqual(await revisionId(repo), selectedId);
    const cli = box.start([
      "--repository",
      repo,
      "--port",
      "0",
      "--no-open",
      selectedId,
    ]);
    const url = await cli.url();
    assert.match(cli.stdout, /Polish notification delivery/);
    const page = await request(url, "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-type"]!, /text\/html/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    const assets = [
      ...page.body.matchAll(/(?:src|href)="([^"?#]+\.(?:js|css))"/g),
    ].map((match) => match[1]);
    assert.ok(
      assets.some((asset) => asset.endsWith(".js")),
      page.body,
    );
    assert.ok(
      assets.some((asset) => asset.endsWith(".css")),
      page.body,
    );
    for (const asset of assets) {
      const response = await request(url, asset);
      assert.equal(response.status, 200, asset);
      assert.ok(response.body.length > 0);
      assert.match(
        response.headers["content-type"]!,
        asset.endsWith(".js") ? /javascript/ : /text\/css/,
      );
      assert.doesNotMatch(response.body.slice(0, 100), /<!doctype html/i);
    }
    const initial = await request(url, "/api/state", {
      headers: { Origin: new URL(url).origin },
    });
    assert.equal(initial.status, 200, initial.body);
    const state: State = JSON.parse(initial.body);
    assert.equal(state.source.changeId, selectedId);
    assert.equal(state.source.description, "Polish notification delivery");
    assert.equal(state.repo.path, repo);
    assert.equal(state.files.length, 3);
    // Moving @ after launch must not silently retarget this review.
    await jj(repo, ["new", "-m", "Another descendant"]);
    const next = await request(url, "/api/state");
    assert.equal(next.status, 200, next.body);
    assert.equal(JSON.parse(next.body).source.changeId, selectedId);

    const forbiddenOrigins: Record<string, string>[] = [
      { Host: "attacker.example" },
      { Host: `localhost:${new URL(url).port}` },
      { Origin: "https://attacker.example" },
      { Origin: "null" },
      { Origin: "http://127.0.0.1:1" },
      { "Sec-Fetch-Site": "cross-site" },
    ];
    for (const headers of forbiddenOrigins) {
      for (const route of ["/", "/api/state"]) {
        const response = await request(url, route, { headers });
        assert.equal(
          response.status,
          403,
          `${route} ${JSON.stringify(headers)}`,
        );
        assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
      }
    }
    const forbiddenMutationHeaders: Record<string, string>[] = [
      { "Content-Type": "application/json" },
      { "Content-Type": "application/json", "X-Fold-Request": "wrong" },
      { "Content-Type": "text/plain", "X-Fold-Request": "1" },
      { "X-Fold-Request": "1" },
    ];
    for (const headers of forbiddenMutationHeaders) {
      const response = await request(url, "/api/undo", {
        method: "POST",
        headers,
        body: "{}",
      });
      assert.equal(response.status, 403);
      assert.equal(JSON.parse(response.body).code, "FORBIDDEN");
    }
    const mutationHeaders = {
      "Content-Type": "application/json",
      "X-Fold-Request": "1",
      Origin: new URL(url).origin,
    };
    const allowed = await request(url, "/api/file", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({
        version: JSON.parse(next.body).version,
        path: state.files[0].path,
      }),
    });
    assert.equal(allowed.status, 200, allowed.body);
    assert.ok(JSON.parse(allowed.body).newFile.contents.length > 0);
    const removed = await request(url, "/api/reset", {
      method: "POST",
      headers: mutationHeaders,
      body: JSON.stringify({ version: state.version }),
    });
    assert.equal(removed.status, 404, removed.body);
    assert.equal(JSON.parse(removed.body).code, "NOT_FOUND");
    assert.equal((await request(url, "/api/not-a-route")).status, 404);
    assert.equal(
      await exists(box.opened),
      false,
      "--no-open never invokes opener",
    );
    await cli.stop("SIGINT");
    await assert.rejects(request(url, "/api/state"));
  },
);

test(
  "default launch opens exactly its printed loopback URL and SIGTERM stops it",
  { timeout: 45_000, skip: process.platform !== "linux" },
  async (t) => {
    const box = await sandbox(t);
    const repo = await createDemo(box.root);
    const expected = await revisionId(repo);
    const cli = box.start([], repo);
    const url = await cli.url();
    await until(
      async () =>
        (await exists(box.opened)) &&
        (await readFile(box.opened, "utf8")) === `${url}\n`,
      cli.diagnostics,
    );
    assert.equal(await readFile(box.opened, "utf8"), `${url}\n`);
    const state = await request(url, "/api/state");
    assert.equal(state.status, 200, state.body);
    assert.equal(JSON.parse(state.body).source.changeId, expected);
    await cli.stop("SIGTERM");
    await assert.rejects(request(url, "/"));
  },
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(
    `${signal} drains an accepted request without interrupting its jj child`,
    { timeout: 45_000, skip: process.platform !== "linux" },
    async (t) => {
      const box = await sandbox(t);
      const repo = await createDemo(box.root);
      // Resolve the real executable before putting a gate in front of it. The gate
      // blocks only a post-startup invocation; all actual repository work is real jj.
      const jjPath = (
        await run("sh", ["-c", "command -v jj"], repo)
      ).stdout.trim();
      const arm = path.join(box.root, "arm");
      const entered = path.join(box.root, "entered");
      const release = path.join(box.root, "release");
      const interrupted = path.join(box.root, "interrupted");
      await writeFile(
        path.join(box.bin, "jj"),
        `#!/bin/sh
if [ -f '${arm}' ]; then
  rm '${arm}'
  trap 'echo interrupted > "${interrupted}"; exit 99' INT TERM
  echo "$$" > '${entered}'
  while [ ! -f '${release}' ]; do sleep 0.05; done
fi
exec '${jjPath}' "$@"
`,
      );
      await chmod(path.join(box.bin, "jj"), 0o755);
      const cli = box.start(["--no-open"], repo);
      const url = await cli.url();
      // Release even on a test timeout so cleanup can drain instead of kill.
      box.releaseGates.push(() => writeFile(release, "release"));
      try {
        await writeFile(arm, "armed");
        const pending = request(url, "/api/state");
        void pending.catch(() => {});
        await until(
          async () =>
            (await exists(entered)) &&
            /^[1-9]\d*\n$/.test(await readFile(entered, "utf8")),
          cli.diagnostics,
        );
        const blockedPid = Number((await readFile(entered, "utf8")).trim());
        assert.ok(Number.isSafeInteger(blockedPid) && blockedPid > 1);
        box.blockedGroups.add(blockedPid);
        // Terminal Ctrl-C reaches the foreground process group, not only the
        // Node launcher. jj must be isolated from that group to drain safely.
        assert.equal(process.kill(-cli.child.pid!, signal), true);
        await until(
          () => cli.stdout.includes("Stopping jj-stamp"),
          cli.diagnostics,
        );
        assert.equal(
          cli.ended,
          false,
          "shutdown must wait for the blocked request",
        );
        assert.equal(await exists(interrupted), false);
        // The listener must stop accepting work while the accepted request drains.
        await assert.rejects(request(url, "/api/state"));
        await writeFile(release, "release");
        const response = await pending;
        assert.equal(response.status, 200, response.body);
        assert.equal(
          JSON.parse(response.body).source.description,
          "Polish notification delivery",
        );
        assert.deepEqual(
          await cli.done(),
          { code: 0, signal: null },
          cli.diagnostics(),
        );
        assert.equal(await exists(interrupted), false);
        assert.equal(await exists(box.opened), false);
      } finally {
        await writeFile(release, "release");
      }
    },
  );
}

test(
  "an occupied port fails clearly without opening a browser",
  { timeout: 30_000 },
  async (t) => {
    const box = await sandbox(t);
    const repo = await createDemo(box.root);
    const occupied = http.createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = occupied.address();
      assert.ok(address && typeof address !== "string");
      const cli = box.start(["-R", repo, "--port", String(address.port)]);
      assert.deepEqual(
        await cli.done(),
        { code: 1, signal: null },
        cli.diagnostics(),
      );
      assert.match(cli.stderr, /port is already in use/);
      assert.doesNotMatch(cli.stdout, /listening on/);
      assert.equal(await exists(box.opened), false);
    } finally {
      await new Promise<void>((resolve, reject) =>
        occupied.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
