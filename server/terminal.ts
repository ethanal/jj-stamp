import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import path from "node:path";
import { constants } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import * as pty from "node-pty";
import { WebSocket, WebSocketServer } from "ws";
import { ConfigStore } from "./config.ts";
import { shellExecutable } from "./shell.ts";
import type { ReviewService } from "./service.ts";
import {
  BoundedPtyInput,
  PtyInputBacklogError,
  PtyInputCompatibilityError,
} from "./terminal-input.ts";

const MAX_SESSIONS = 8;
const MAX_PAYLOAD = 64 * 1024;
const MAX_OUTPUT = 1024 * 1024;
const MAX_INPUT = 16 * 1024;

function geometry(cols: unknown, rows: unknown): boolean {
  return (
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    (cols as number) >= 1 &&
    (cols as number) <= 500 &&
    (rows as number) >= 1 &&
    (rows as number) <= 300
  );
}

function oneHeader(req: IncomingMessage, name: string): boolean {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === name) count++;
  return count === 1;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.on("error", () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  // A peer need not acknowledge our FIN.
  const timer = setTimeout(() => socket.destroy(), 250);
  timer.unref();
  socket.once("close", () => clearTimeout(timer));
}

async function executablePath(shell: string, cwd: string): Promise<string> {
  const candidates = shell.includes("/")
    ? [path.resolve(cwd, shell)]
    : (process.env.PATH ?? "/usr/bin:/bin")
        .split(path.delimiter)
        .map((directory) => path.resolve(cwd, directory, shell));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // PATH lookup is not an execution attempt; only one executable is run.
    }
  }
  throw new Error("Shell executable is unavailable.");
}

interface Member {
  pid: number;
  start: string;
}

async function member(
  pid: number,
  session: number,
): Promise<Member | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesized and may itself contain spaces and parentheses.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(fields[3]) === session && fields[0] !== "Z")
      return { pid, start: fields[19] };
  } catch {
    // A process that disappeared needs no further signals.
  }
}

/** Snapshot only this PTY's Linux session, including separate foreground job
 * groups. Recheck both session and start time before signaling to avoid PID
 * reuse. No background process observer or dependency on an external ps tool. */
async function sessionMembers(session: number): Promise<Member[]> {
  if (process.platform !== "linux") return [];
  const names = await readdir("/proc").catch(() => []);
  const pids = names.filter((name) => /^\d+$/.test(name)).slice(0, 32768);
  const result: Member[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < pids.length) {
        const found = await member(Number(pids[next++]), session);
        if (found) result.push(found);
      }
    }),
  );
  return result;
}

async function terminate(
  terminal: pty.IPty,
  exited: Promise<void>,
  hasExited: () => boolean,
): Promise<void> {
  const members = await sessionMembers(terminal.pid);
  async function signal(name: NodeJS.Signals) {
    if (process.platform === "linux") {
      for (const previous of members) {
        const current = await member(previous.pid, terminal.pid);
        if (current?.start !== previous.start) continue;
        try {
          process.kill(previous.pid, name);
        } catch {
          // Exit can race a signal.
        }
      }
    } else if (!hasExited()) {
      // node-pty's POSIX child is a session/process-group leader. Interactive
      // shells forward HUP to their jobs; group signaling also covers children
      // that have not enabled job control.
      try {
        process.kill(-terminal.pid, name);
      } catch {
        terminal.kill(name);
      }
    }
    // The /proc snapshot can race the initial exec. Always signal a shell
    // which node-pty has not reaped yet, but never signal a reaped PID.
    if (!hasExited()) terminal.kill(name);
  }
  await signal("SIGHUP");
  await Promise.race([exited, delay(200)]);
  // Even an exited shell can have left a foreground/background job behind.
  await signal("SIGTERM");
  await delay(150);
  await signal("SIGKILL");
  await Promise.race([
    exited,
    delay(1500).then(() => {
      throw new Error("Terminal shell did not exit after SIGKILL.");
    }),
  ]);
}

export function createTerminalServer(
  server: Server,
  service: Pick<ReviewService, "getWatchRoot">,
  configPath?: string,
) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PAYLOAD,
    perMessageDeflate: false,
    clientTracking: false,
  });
  const config = new ConfigStore(configPath);
  const sessions = new Set<{ stop: () => Promise<void> }>();
  let closing = false;
  let shutdown: Promise<void> | undefined;

  function connect(ws: WebSocket, cols: number, rows: number) {
    let terminal: pty.IPty | undefined;
    let input: BoundedPtyInput | undefined;
    let stopped = false;
    let didExit = false;
    let finishExit!: () => void;
    const exited = new Promise<void>((resolve) => (finishExit = resolve));
    let cleanup: Promise<void> | undefined;
    let closeTimer: NodeJS.Timeout | undefined;
    let dataListener: pty.IDisposable | undefined;
    let exitListener: pty.IDisposable | undefined;
    let windowStart = Date.now();
    let inputBytes = 0;
    let messages = 0;

    function send(value: object): boolean {
      if (ws.readyState !== WebSocket.OPEN) return false;
      const frame = JSON.stringify(value);
      if (ws.bufferedAmount + Buffer.byteLength(frame) > MAX_OUTPUT) {
        ws.terminate();
        void stop();
        return false;
      }
      ws.send(frame, (error) => {
        if (error) {
          ws.terminate();
          void stop();
        }
      });
      return true;
    }
    function close(code: number, reason: string) {
      if (ws.readyState === WebSocket.OPEN) ws.close(code, reason);
      closeTimer ??= setTimeout(() => ws.terminate(), 250);
      closeTimer.unref();
      void stop();
    }
    function fail(message: string, code = 1008) {
      send({ type: "error", message });
      close(code, message);
    }
    function stop(): Promise<void> {
      stopped = true;
      // Stop native input retries/drop pending command bytes before waiting on
      // asynchronous startup or shell termination. Never replay them.
      input?.dispose();
      cleanup ??= (async () => {
        await initialized;
        try {
          if (terminal) await terminate(terminal, exited, () => didExit);
        } finally {
          dataListener?.dispose();
          exitListener?.dispose();
          sessions.delete(session);
        }
      })();
      // Preserve rejection for shutdown(), without an unhandled rejection on
      // normal browser disconnect. A failed kill is visible in the owner log.
      void cleanup.catch((error: unknown) =>
        console.error("[jj-stamp terminal]", error),
      );
      return cleanup;
    }
    const session = {
      stop: () => {
        ws.terminate();
        return stop();
      },
    };
    sessions.add(session);
    ws.on("error", () => {
      ws.terminate();
      void stop();
    });
    ws.on("close", () => {
      clearTimeout(closeTimer);
      void stop();
    });
    ws.on("message", (raw, binary) => {
      if (stopped) return;
      if (Date.now() - windowStart >= 1000) {
        windowStart = Date.now();
        inputBytes = messages = 0;
      }
      inputBytes +=
        raw instanceof ArrayBuffer
          ? raw.byteLength
          : Array.isArray(raw)
            ? raw.reduce((total, part) => total + part.length, 0)
            : raw.length;
      if (++messages > 512 || inputBytes > 256 * 1024) {
        fail("Terminal input rate exceeded.");
        return;
      }
      try {
        if (binary) throw new Error();
        const value: unknown = JSON.parse(raw.toString());
        if (!value || typeof value !== "object" || Array.isArray(value))
          throw new Error();
        const message = value as Record<string, unknown>;
        if (
          message.type === "input" &&
          Object.keys(message).length === 2 &&
          typeof message.data === "string" &&
          Buffer.byteLength(message.data) <= MAX_INPUT
        ) {
          if (!input) throw new Error();
          input.write(message.data);
        } else if (
          message.type === "resize" &&
          Object.keys(message).length === 3 &&
          geometry(message.cols, message.rows)
        ) {
          cols = message.cols as number;
          rows = message.rows as number;
          terminal?.resize(cols, rows);
        } else throw new Error();
      } catch (error) {
        if (error instanceof PtyInputBacklogError) fail(error.message);
        else if (error instanceof PtyInputCompatibilityError)
          fail(error.message, 1011);
        else fail("Invalid terminal message.");
      }
    });

    const initialized = Promise.resolve().then(async () => {
      try {
        if (stopped || closing) return;
        const [cwd, preferences] = await Promise.all([
          service.getWatchRoot(),
          config.read(),
        ]);
        if (stopped || closing || ws.readyState !== WebSocket.OPEN) return;
        const shell = shellExecutable(preferences.shell);
        const executable = await executablePath(shell, cwd);
        if (stopped || closing || ws.readyState !== WebSocket.OPEN) return;
        terminal = pty.spawn(executable, [], {
          cwd,
          cols,
          rows,
          name: "xterm-256color",
          handleFlowControl: false,
          env: { ...process.env, TERM: "xterm-256color", PWD: cwd },
        });
        exitListener = terminal.onExit(({ exitCode }) => {
          didExit = true;
          finishExit();
          if (!stopped) {
            send({ type: "exit", exitCode });
            close(1000, "Shell exited.");
          }
        });
        input = new BoundedPtyInput(terminal);
        dataListener = terminal.onData((data) => {
          if (!stopped) send({ type: "data", data });
        });
        send({ type: "ready", shell, pid: terminal.pid });
      } catch (error) {
        if (!stopped)
          fail(
            error instanceof PtyInputCompatibilityError
              ? error.message
              : "Could not start terminal. Check the configured shell and repository.",
            1011,
          );
      }
    });
  }

  server.on("upgrade", (req, socket, head) => {
    // Upgrade requests bypass Express. Do not trust forwarded headers or proxy
    // origins, and require Origin even though ordinary HTTP reads may omit it.
    const address = server.address();
    const authority =
      address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    if (
      !oneHeader(req, "host") ||
      !oneHeader(req, "origin") ||
      req.headers.host !== authority ||
      req.headers.origin !== `http://${authority}` ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      reject(socket, 403, "Forbidden");
      return;
    }
    if (closing) {
      reject(socket, 503, "Service Unavailable");
      return;
    }
    let url: URL;
    try {
      if (!req.url?.startsWith("/")) throw new Error();
      url = new URL(req.url, `http://${authority}`);
    } catch {
      reject(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== "/api/terminal") {
      reject(socket, 404, "Not Found");
      return;
    }
    const params = [...url.searchParams];
    const cols = Number(url.searchParams.get("cols"));
    const rows = Number(url.searchParams.get("rows"));
    if (
      params.length !== 2 ||
      !params.every(
        ([key, value]) =>
          (key === "cols" || key === "rows") && /^[1-9]\d{0,2}$/.test(value),
      ) ||
      url.searchParams.getAll("cols").length !== 1 ||
      url.searchParams.getAll("rows").length !== 1 ||
      !geometry(cols, rows)
    ) {
      reject(socket, 400, "Bad Request");
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      reject(socket, 503, "Service Unavailable");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => connect(ws, cols, rows));
  });

  return {
    close(): Promise<void> {
      if (!shutdown) {
        closing = true;
        config.close();
        const stopped = [...sessions].map((session) => session.stop());
        shutdown = Promise.all([
          ...stopped,
          config.drain(),
          new Promise<void>((resolve) => wss.close(() => resolve())),
        ]).then(() => undefined);
      }
      return shutdown;
    },
  };
}
