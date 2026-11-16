import express, { type Request, type Response, type Router } from "express";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  configPatchSchema,
  defaultConfig,
  type Config,
} from "../src/config.ts";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PENDING_TASKS = 64;

export function resolveConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  // XDG base directories must be absolute; an empty/relative value is ignored.
  const base =
    env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(home, ".config");
  return path.join(base, "jj-stamp", "config.json");
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code = "CONFIG_IO",
    readonly status = 500,
  ) {
    super(message);
  }
}

function ioError(error: unknown): ConfigError {
  if (error instanceof ConfigError) return error;
  return new ConfigError(
    "Could not access shared preferences. Check configuration directory permissions and available disk space.",
  );
}

async function load(file: string): Promise<Config> {
  let text: string;
  try {
    // O_NONBLOCK prevents an accidentally configured FIFO from hanging even
    // before fstat can reject it. Never read devices, directories or sockets.
    const handle = await open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        throw new ConfigError(
          "Shared preferences must be a regular JSON file.",
        );
      if (metadata.size > MAX_CONFIG_BYTES)
        throw new ConfigError(
          "Shared preferences exceed the 64 KiB limit. Reduce config.json before saving preferences.",
          "CONFIG_INVALID",
          409,
        );
      // Also cap reads if another process grows the file after fstat.
      const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > MAX_CONFIG_BYTES)
        throw new ConfigError(
          "Shared preferences exceed the 64 KiB limit. Reduce config.json before saving preferences.",
          "CONFIG_INVALID",
          409,
        );
      text = bytes.subarray(0, length).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...defaultConfig };
    throw ioError(error);
  }
  try {
    const partial = configPatchSchema.parse(JSON.parse(text));
    return { ...defaultConfig, ...partial };
  } catch {
    throw new ConfigError(
      "Shared preferences contain invalid JSON or unsupported values. Repair or remove config.json before saving preferences.",
      "CONFIG_INVALID",
      409,
    );
  }
}

interface Client {
  request: Request;
  response: Response;
  initialized: boolean;
  blocked: boolean;
  pending: string[];
  disconnect: () => void;
  drain: () => void;
}

function frame(event: string, value: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
}

/** One disk file, independent of the selected repository and its event scope. */
export class ConfigStore {
  private tail: Promise<unknown> = Promise.resolve();
  private pendingTasks = 0;
  private closed = false;
  private readonly clients = new Set<Client>();
  private timer?: NodeJS.Timeout;
  private polling = false;
  private heartbeat = 0;
  private snapshot: Config = { ...defaultConfig };
  private failure?: string;

  constructor(
    readonly file = resolveConfigPath(),
    private readonly maxClients = 32,
  ) {}

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(
        new ConfigError("jj-stamp is shutting down.", "SHUTTING_DOWN", 503),
      );
    if (this.pendingTasks >= MAX_PENDING_TASKS)
      return Promise.reject(
        new ConfigError(
          "Too many pending shared preference requests. Retry after existing requests finish.",
          "CONFIG_BUSY",
          503,
        ),
      );
    this.pendingTasks++;
    const task = this.tail.then(work);
    this.tail = task.then(
      () => {
        this.pendingTasks--;
      },
      () => {
        this.pendingTasks--;
      },
    );
    return task;
  }

  private async observe(): Promise<Config> {
    try {
      const config = await load(this.file);
      const changed =
        this.failure !== undefined ||
        JSON.stringify(config) !== JSON.stringify(this.snapshot);
      this.snapshot = config;
      this.failure = undefined;
      if (changed) this.broadcast(frame("config", config));
      return { ...config };
    } catch (error) {
      const safe = ioError(error);
      if (this.failure !== safe.message) {
        this.failure = safe.message;
        this.broadcast(frame("config-error", { error: safe.message }));
      }
      throw safe;
    }
  }

  read(): Promise<Config> {
    return this.enqueue(() => this.observe());
  }

  patch(value: unknown): Promise<Config> {
    const patch = configPatchSchema.parse(value);
    return this.enqueue(async () => {
      if (Object.keys(patch).length === 0) return this.observe();
      // Locking the read/merge/write (not just rename) preserves disjoint
      // patches from separate windows, server instances and processes.
      const lockPath = `${this.file}.lock`;
      let lock: Awaited<ReturnType<typeof open>> | undefined;
      let temporary: string | undefined;
      try {
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
        const deadline = Date.now() + 3000;
        while (!lock) {
          try {
            lock = await open(lockPath, "wx", 0o600);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (Date.now() >= deadline)
              throw new ConfigError(
                "Shared preferences are locked by another writer. Retry after it finishes; if a process crashed, remove config.json.lock only after all jj-stamp processes have stopped.",
                "CONFIG_BUSY",
                503,
              );
            await delay(25);
          }
        }
        const current = await this.observe();
        const next = { ...current, ...patch };
        if (JSON.stringify(current) === JSON.stringify(next)) return current;
        temporary = `${this.file}.${randomUUID()}.tmp`;
        const handle = await open(temporary, "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, this.file);
        temporary = undefined;
        this.snapshot = next;
        this.failure = undefined;
        this.broadcast(frame("config", next));
        return { ...next };
      } catch (error) {
        throw ioError(error);
      } finally {
        if (temporary) await unlink(temporary).catch(() => {});
        if (lock) {
          try {
            try {
              await lock.close();
            } finally {
              await unlink(lockPath);
            }
          } catch (error) {
            throw ioError(error);
          }
        }
      }
    });
  }

  connect(request: Request, response: Response): void {
    if (
      this.closed ||
      this.clients.size >= this.maxClients ||
      this.pendingTasks >= MAX_PENDING_TASKS
    ) {
      response.status(503).json({
        error: this.closed
          ? "jj-stamp is shutting down."
          : "Too many shared preference event clients.",
        code: this.closed ? "SHUTTING_DOWN" : "BUSY",
      });
      return;
    }
    response.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.flushHeaders();
    const client: Client = {
      request,
      response,
      initialized: false,
      blocked: false,
      pending: [],
      disconnect: () => this.remove(client),
      drain: () => {
        client.blocked = false;
        while (!client.blocked && client.pending.length)
          this.send(client, client.pending.shift()!);
      },
    };
    this.clients.add(client);
    request.once("aborted", client.disconnect);
    response.once("close", client.disconnect);
    void this.enqueue(async () => {
      await this.observe().catch(() => {});
      if (!this.clients.has(client)) return;
      client.initialized = true;
      this.send(client, frame("config", this.snapshot));
      if (this.failure)
        this.send(client, frame("config-error", { error: this.failure }));
    }).catch(() => {
      this.remove(client);
      response.destroy();
    });
    if (!this.timer) {
      this.heartbeat = Date.now();
      // Read the one file rather than watching its inode: atomic replacements,
      // deleted/recreated parent directories and missing files all recover.
      this.timer = setInterval(() => {
        if (!this.polling && this.pendingTasks === 0) {
          this.polling = true;
          void this.read()
            .catch(() => {})
            .finally(() => {
              this.polling = false;
            });
        }
        if (Date.now() - this.heartbeat >= 15_000) {
          this.heartbeat = Date.now();
          this.broadcast(": heartbeat\n\n");
        }
      }, 250);
      this.timer.unref();
    }
  }

  private send(client: Client, data: string): void {
    if (!this.clients.has(client)) return;
    if (client.response.destroyed || client.response.writableEnded) {
      this.remove(client);
      return;
    }
    if (client.blocked) {
      if (client.pending.length >= 16) {
        this.remove(client);
        client.response.destroy();
      } else client.pending.push(data);
    } else if (!client.response.write(data)) {
      client.blocked = true;
      client.response.once("drain", client.drain);
    }
  }

  private broadcast(data: string): void {
    for (const client of this.clients)
      if (client.initialized) this.send(client, data);
  }

  private remove(client: Client): void {
    this.clients.delete(client);
    client.request.removeListener("aborted", client.disconnect);
    client.response.removeListener("close", client.disconnect);
    client.response.removeListener("drain", client.drain);
    if (this.clients.size === 0) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  close(): void {
    this.closed = true;
    for (const client of this.clients) {
      this.remove(client);
      if (client.blocked || client.pending.length) client.response.destroy();
      else client.response.end();
    }
  }

  /** Accepted writes finish even when their HTTP clients disconnect. */
  async drain(): Promise<void> {
    await this.tail;
  }
}

export interface ConfigApiOptions {
  configPath?: string;
  maxEventClients?: number;
}

export interface ConfigRouter extends Router {
  close(): void;
  drain(): Promise<void>;
}

/** Mount at /api/config, behind the host/origin/mutation protections. */
export function createConfigApi(options: ConfigApiOptions = {}): ConfigRouter {
  const router = express.Router() as ConfigRouter;
  const store = new ConfigStore(options.configPath, options.maxEventClients);
  router.close = () => store.close();
  router.drain = () => store.drain();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "64kb" }));
  router.head("/events", (_req, res) => res.status(204).end());
  router.get("/events", (req, res) => store.connect(req, res));
  router.get("/", async (_req, res) => res.json(await store.read()));
  router.post("/", async (req, res) => res.json(await store.patch(req.body)));
  router.use(((error: unknown, _req, res, next) => {
    if (error instanceof ConfigError) {
      res.status(error.status).json({ error: error.message, code: error.code });
    } else if (error instanceof z.ZodError) {
      res.status(400).json({
        error:
          "Invalid preferences. Supply only supported preference names and values.",
        code: "INVALID_REQUEST",
      });
    } else if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({
        error: "Request body must be valid JSON.",
        code: "INVALID_REQUEST",
      });
    } else next(error);
  }) as express.ErrorRequestHandler);
  return router;
}
