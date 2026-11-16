import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { startLocalServer } from "../server/http.ts";
import { jj } from "../server/process.ts";
import { ReviewService } from "../server/service.ts";

interface Frame {
  type: string;
  data?: string;
  pid?: number;
  shell?: string;
  exitCode?: number;
  message?: string;
}

async function fixture(t: TestContext, shell = "/bin/sh") {
  const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-terminal-"));
  const repo = path.join(root, "repo");
  const assetsDir = path.join(root, "assets");
  const configPath = path.join(root, "config.json");
  await mkdir(repo);
  await mkdir(assetsDir);
  await jj(repo, ["git", "init"]);
  await writeFile(configPath, JSON.stringify({ shell }));
  // Exercise root canonicalization from a nested directory and symlink.
  await mkdir(path.join(repo, "nested"));
  await symlink(path.join(repo, "nested"), path.join(root, "linked"));
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: path.join(root, "linked"),
    jjRunner: (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const local = await startLocalServer({
    service,
    assetsDir,
    configPath,
    port: 0,
  });
  t.after(async () => {
    await local.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    ...local,
    root,
    repo: await realpath(repo),
    configPath,
    calls,
    service,
  };
}

function client(t: TestContext, url: string, query = "?cols=80&rows=24") {
  const ws = new WebSocket(
    `${url.replace("http:", "ws:")}api/terminal${query}`,
    { origin: new URL(url).origin },
  );
  t.after(() => ws.terminate());
  const frames: Frame[] = [];
  let output = "";
  const changed = new Set<() => void>();
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    const frame = JSON.parse(raw.toString()) as Frame;
    frames.push(frame);
    if (frame.type === "data") output += frame.data;
    for (const listener of changed) listener();
  });
  const closed = new Promise<number>((resolve) =>
    ws.once("close", (code) => resolve(code)),
  );
  function wait<T>(read: () => T | undefined): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = () => {
        const result = read();
        if (result !== undefined) {
          clearTimeout(timer);
          changed.delete(check);
          resolve(result);
        }
      };
      const timer = setTimeout(() => {
        changed.delete(check);
        reject(
          new Error(
            `Timed out waiting for terminal: ${JSON.stringify({ frames, output }).slice(-3000)}`,
          ),
        );
      }, 8000);
      changed.add(check);
      check();
    });
  }
  return {
    ws,
    frames,
    closed,
    frame: (type: string) => wait(() => frames.find((f) => f.type === type)),
    output: (pattern: RegExp) => wait(() => output.match(pattern) ?? undefined),
    send: (value: object) => ws.send(JSON.stringify(value)),
    input: (data: string) => ws.send(JSON.stringify({ type: "input", data })),
  };
}

async function rejection(
  url: string,
  route: string,
  headers: Record<string, string | string[] | undefined> = {},
  includeOrigin = true,
) {
  return new Promise<number>((resolve, reject) => {
    const req = request(new URL(route, url), {
      headers: {
        Connection: "Upgrade",
        Upgrade: "websocket",
        "Sec-WebSocket-Version": "13",
        "Sec-WebSocket-Key": "SGVsbG9Xb3JsZEhlbGxvIQ==",
        ...(includeOrigin ? { Origin: new URL(url).origin } : {}),
        ...headers,
      },
    });
    req.on("response", (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("upgrade", (_res, socket) => {
      socket.destroy();
      reject(new Error("Unexpected accepted WebSocket upgrade."));
    });
    req.on("error", reject);
    req.end();
  });
}

async function alive(pid: number): Promise<boolean> {
  if (process.platform === "linux") {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2)[0] !== "Z";
    } catch {
      return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number) {
  for (let i = 0; i < 100; i++) {
    if (!(await alive(pid))) return;
    await delay(20);
  }
  assert.fail(`Terminal process ${pid} survived cleanup.`);
}

test("terminal is lazy, a real PTY in the canonical root, resizes and preserves shell state", async (t) => {
  const local = await fixture(t);
  assert.equal(
    local.calls.length,
    0,
    "merely serving HTTP must not start terminal work",
  );
  const c = client(t, local.url, "?cols=97&rows=31");
  const ready = await c.frame("ready");
  assert.equal(ready.shell, "/bin/sh");
  assert.ok(ready.pid! > 0);
  c.input(
    "printf 'CWD:%s\\n' \"$PWD\"; test -t 0 && printf 'IS_%s\\n' TTY; stty size\r",
  );
  await c.output(
    new RegExp(`CWD:${local.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );
  await c.output(/IS_TTY/);
  await c.output(/31 97/);
  c.send({ type: "resize", cols: 132, rows: 44 });
  c.input("stty size; export TERMINAL_TEST=persistent\r");
  await c.output(/44 132/);
  // Overlay visibility is deliberately not a server concept: keeping this
  // socket alive retains variables, cwd, history and foreground processes.
  c.input('cd nested; printf \'VALUE:%s CWD:%s\\n\' "$TERMINAL_TEST" "$PWD"\r');
  await c.output(/VALUE:persistent CWD:.*\/nested/);
  assert.ok(local.calls.length > 0);
  assert.ok(
    local.calls.every((args) => args.includes("--ignore-working-copy")),
    "terminal initialization must never snapshot jj",
  );
  c.input("exit 7\r");
  assert.equal((await c.frame("exit")).exitCode, 7);
  assert.equal(await c.closed, 1000);
  await gone(ready.pid!);
});

test("terminal input reaches foreground programs, including Ctrl-C", async (t) => {
  const local = await fixture(t);
  const c = client(t, local.url);
  await c.frame("ready");
  // Announce readiness from inside the foreground process, not a preceding
  // shell builtin (Ctrl-C could otherwise arrive before sleep's job starts).
  const node = process.execPath.replaceAll("'", "'\\''");
  c.input(
    `'${node}' -e 'process.stdout.write("START_"+"SLEEP\\n");setTimeout(()=>{},30000)'\r`,
  );
  await c.output(/START_SLEEP/);
  c.input("\x03");
  c.input("printf 'AFTER_%s\\n' INTERRUPT\r");
  await c.output(/AFTER_INTERRUPT/);
});

test("tabs have independent shells; disconnect terminates only its own PTY", async (t) => {
  const local = await fixture(t);
  const a = client(t, local.url);
  const b = client(t, local.url);
  const [first, second] = await Promise.all([
    a.frame("ready"),
    b.frame("ready"),
  ]);
  assert.notEqual(first.pid, second.pid);
  a.input("export TAB_VALUE=first\r");
  b.input("printf 'VALUE:%s:end\\n' \"$TAB_VALUE\"\r");
  await b.output(/VALUE::end/);
  a.ws.terminate();
  await a.closed;
  await gone(first.pid!);
  assert.equal(await alive(second.pid!), true);
  b.input("printf 'STILL_%s\\n' ALIVE\r");
  await b.output(/STILL_ALIVE/);
});

test("shutdown is idempotent, kills foreground jobs ignoring HUP/TERM, and awaits shell exit", async (t) => {
  const local = await fixture(t);
  const c = client(t, local.url);
  const ready = await c.frame("ready");
  const command = `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});console.log("CHILD:"+process.pid);setInterval(()=>{},1000)'\r`;
  c.input(command);
  const output = await c.output(/CHILD:(\d+)/);
  const child = Number(output[1]);
  const shutdown = local.close();
  assert.equal(local.close(), shutdown);
  await shutdown;
  await c.closed;
  assert.equal(await alive(ready.pid!), false);
  await gone(child);
});

test("disconnect also kills foreground jobs without waiting for application shutdown", async (t) => {
  const local = await fixture(t);
  const c = client(t, local.url);
  const ready = await c.frame("ready");
  c.input(
    `${JSON.stringify(process.execPath)} -e 'process.on("SIGHUP",()=>{});process.on("SIGTERM",()=>{});console.log("CHILD:"+process.pid);setInterval(()=>{},1000)'\r`,
  );
  const output = await c.output(/CHILD:(\d+)/);
  c.ws.terminate();
  await c.closed;
  await gone(ready.pid!);
  await gone(Number(output[1]));
});

test("upgrade enforces exact loopback Host, mandatory Origin, cross-site protection and routing", async (t) => {
  const local = await fixture(t);
  const endpoint = "/api/terminal?cols=80&rows=24";
  for (const headers of [
    { Host: "localhost" },
    { Host: `evil.invalid:${new URL(local.url).port}` },
    { Origin: "https://evil.invalid" },
    { Origin: "null" },
    { Origin: [new URL(local.url).origin, "https://evil.invalid"] },
    { Origin: `${new URL(local.url).origin}/` },
    { "Sec-Fetch-Site": "cross-site" },
    { Host: "evil.invalid", "X-Forwarded-Host": new URL(local.url).host },
    { Origin: "https://proxy.invalid", "X-Forwarded-Proto": "http" },
  ]) {
    assert.equal(await rejection(local.url, endpoint, headers), 403);
  }
  assert.equal(await rejection(local.url, endpoint, {}, false), 403);
  assert.equal(await rejection(local.url, "/api/other?cols=80&rows=24"), 404);
  assert.equal(await rejection(local.url, "/"), 404);
  assert.deepEqual(
    local.calls,
    [],
    "rejected upgrades must not start repo work or shells",
  );
});

test("initial geometry rejects missing, repeated, noninteger, oversized or unknown query values", async (t) => {
  const local = await fixture(t);
  for (const query of [
    "",
    "?cols=80",
    "?cols=0&rows=24",
    "?cols=501&rows=24",
    "?cols=80&rows=301",
    "?cols=80.5&rows=24",
    "?cols=8e1&rows=24",
    "?cols=80&rows=24&cols=90",
    "?cols=80&rows=24&shell=/bin/sh",
  ]) {
    assert.equal(
      await rejection(local.url, `/api/terminal${query}`),
      400,
      query,
    );
  }
  assert.deepEqual(local.calls, []);
});

test("malformed, binary, oversized, and invalid protocol messages close and reap the PTY", async (t) => {
  const local = await fixture(t);
  const cases: Array<string | Buffer> = [
    "not json",
    "null",
    "[]",
    JSON.stringify({ type: "input", data: 7 }),
    JSON.stringify({ type: "input", data: "x", extra: true }),
    JSON.stringify({ type: "input", data: "x".repeat(16 * 1024 + 1) }),
    JSON.stringify({ type: "resize", cols: 1.5, rows: 24 }),
    JSON.stringify({ type: "resize", cols: 80, rows: 0 }),
    JSON.stringify({ type: "exec", data: "echo forbidden" }),
    Buffer.from('{"type":"input","data":"binary"}'),
    "x".repeat(64 * 1024 + 1),
  ];
  for (const value of cases) {
    const c = client(t, local.url);
    const ready = await c.frame("ready");
    c.ws.send(value);
    const code = await c.closed;
    assert.ok(
      code === 1008 || code === 1009,
      `${String(value).slice(0, 80)}: ${code}`,
    );
    if (code === 1008)
      assert.ok(c.frames.some((frame) => frame.type === "error"));
    await gone(ready.pid!);
  }
});

test("session admission is bounded, including sessions awaiting disconnect cleanup", async (t) => {
  const local = await fixture(t);
  const clients = Array.from({ length: 8 }, () => client(t, local.url));
  await Promise.all(clients.map((c) => c.frame("ready")));
  assert.equal(
    await rejection(local.url, "/api/terminal?cols=80&rows=24"),
    503,
  );
  clients[0].ws.terminate();
  await clients[0].closed;
  // close() waits for cleanup of all admitted sessions, including this one.
  await local.close();
});

test("input floods close the socket and reap its PTY", async (t) => {
  const local = await fixture(t);
  const c = client(t, local.url);
  const ready = await c.frame("ready");
  for (let i = 0; i < 513; i++) c.send({ type: "resize", cols: 80, rows: 24 });
  assert.match((await c.frame("error")).message!, /rate exceeded/);
  assert.equal(await c.closed, 1008);
  await gone(ready.pid!);
});

test("literal configured executable paths can contain spaces; settings apply to new sessions only", async (t) => {
  const local = await fixture(t);
  const a = client(t, local.url);
  await a.frame("ready");
  const shell = path.join(local.root, "shell with spaces");
  await writeFile(
    shell,
    "#!/bin/sh\nprintf 'CUSTOM_%s\\n' SHELL\nexec /bin/sh\n",
  );
  await chmod(shell, 0o700);
  await writeFile(local.configPath, JSON.stringify({ shell }));
  const b = client(t, local.url);
  assert.equal((await b.frame("ready")).shell, shell);
  await b.output(/CUSTOM_SHELL/);
  a.input("printf 'ORIGINAL_%s\\n' SESSION\r");
  await a.output(/ORIGINAL_SESSION/);
});

test("bad shell executable fails explicitly without fallback, interpolation or retries", async (t) => {
  const local = await fixture(t, "/bin/sh -c touch terminal-must-not-exist");
  const c = client(t, local.url);
  const error = await c.frame("error");
  assert.match(error.message!, /Could not start terminal/);
  assert.equal(await c.closed, 1011);
  assert.equal(
    c.frames.some((frame) => frame.type === "ready"),
    false,
  );
  await assert.rejects(
    readFile(path.join(local.repo, "terminal-must-not-exist")),
    { code: "ENOENT" },
  );
});

test("empty shell preference uses the service user's SHELL without changing argv", async (t) => {
  const local = await fixture(t, "");
  const previous = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  t.after(() => {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  });
  const c = client(t, local.url);
  assert.equal((await c.frame("ready")).shell, "/bin/sh");
});

test("shutdown during pending startup waits for initialization but never spawns an abandoned shell", async (t) => {
  const local = await fixture(t);
  let finish!: (root: string) => void;
  const root = new Promise<string>((resolve) => (finish = resolve));
  t.mock.method(local.service, "getWatchRoot", () => root);
  const c = client(t, local.url);
  await once(c.ws, "open");
  let settled = false;
  const shutdown = local.close().then(() => (settled = true));
  await c.closed;
  assert.equal(settled, false);
  finish(local.repo);
  await shutdown;
  assert.equal(
    c.frames.some((frame) => frame.type === "ready"),
    false,
  );
  assert.deepEqual(local.calls, []);
});

test("slow output consumers are disconnected with bounded backlog and their PTY is killed", async (t) => {
  const local = await fixture(t);
  const c = client(t, local.url);
  const ready = await c.frame("ready");
  // Pause the actual TCP consumer, not a mocked PTY or WebSocket. The server's
  // socket send buffer fills, then its bounded WebSocket backlog closes it.
  const socket = (
    c.ws as unknown as { _socket: { pause(): void; resume(): void } }
  )._socket;
  socket.pause();
  c.input("yes terminal-backpressure\r");
  await gone(ready.pid!);
  socket.resume();
  await c.closed;
});
