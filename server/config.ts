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
  configSchema,
  defaultConfig,
  type Config,
} from "../src/config.ts";

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_PENDING_TASKS = 64;
const resetInvalidSchema = z.object({ confirm: z.literal(true) }).strict();

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

function invalid(message: string): ConfigError {
  return new ConfigError(
    `${message} Repair config.json or explicitly reset invalid preferences to defaults with an automatic backup.`,
    "CONFIG_INVALID",
    409,
  );
}

function notInvalid(): ConfigError {
  return new ConfigError(
    "Shared preferences are valid or missing. Only an existing invalid config.json can be reset.",
    "CONFIG_NOT_INVALID",
    409,
  );
}

async function readBytes(file: string): Promise<Buffer | undefined> {
  try {
    // O_NONBLOCK prevents an accidentally configured FIFO from hanging even
    // before fstat can reject it. Never read devices, directories or symlinks.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
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
      return bytes.subarray(0, length);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw ioError(error);
  }
}

interface ConfigDocument {
  config: Config;
  values: Record<string, unknown>;
  text?: string;
}

function parseBytes(bytes: Buffer): ConfigDocument {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw invalid("Shared preferences are not valid UTF-8.");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid("Shared preferences contain invalid JSON syntax.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw invalid("Shared preferences must be a JSON object.");
  const values = value as Record<string, unknown>;
  const config = { ...defaultConfig };
  // A newer release or another tool may understand keys/values we do not.
  // Validate fields independently so one unsupported value cannot block the
  // remaining settings, and never send unknown data to browser consumers.
  for (const key of Object.keys(defaultConfig) as (keyof Config)[]) {
    if (!Object.hasOwn(values, key)) continue;
    const result = configSchema.shape[key].safeParse(values[key]);
    if (result.success) Object.assign(config, { [key]: result.data });
  }
  return { config, values, text };
}

async function load(file: string): Promise<ConfigDocument> {
  const bytes = await readBytes(file);
  return bytes === undefined
    ? { config: { ...defaultConfig }, values: {} }
    : parseBytes(bytes);
}

function serializePatch(
  current: ConfigDocument,
  patch: Partial<Config>,
): string {
  const entries =
    current.text === undefined
      ? new Map(
          Object.entries(defaultConfig).map(([key, value]) => [
            key,
            JSON.stringify(value),
          ]),
        )
      : rawEntries(current.text);
  for (const [key, value] of Object.entries(patch))
    entries.set(key, JSON.stringify(value));
  const fields = [...entries].map(
    ([key, value]) => `${JSON.stringify(key)}: ${value}`,
  );
  const formatted = `{\n  ${fields.join(",\n  ")}\n}\n`;
  // Keep unknown values as raw slices, without a recursive reviver/stringifier.
  // This preserves large numeric literals and deeply nested future settings,
  // and cannot expand their formatting quadratically before checking the cap.
  return Buffer.byteLength(formatted) <= MAX_CONFIG_BYTES
    ? formatted
    : `{${[...entries].map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}\n`;
}

/** Extract values only after JSON.parse has validated a complete root object. */
function rawEntries(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  // Keys and string values share this escape-aware scanner. No string decoding
  // is needed except for keys, to match JSON.parse's last-duplicate-key rules.
  function stringEnd(start: number): number {
    let end = start + 1;
    while (end < text.length) {
      if (text[end] === "\\") end += 2;
      else if (text[end++] === '"') break;
    }
    return end;
  }
  function whitespace(start: number): number {
    while (
      text[start] === " " ||
      text[start] === "\t" ||
      text[start] === "\r" ||
      text[start] === "\n"
    )
      start++;
    return start;
  }
  let index = whitespace(text.indexOf("{") + 1);
  while (text[index] !== "}") {
    const end = stringEnd(index);
    const key: string = JSON.parse(text.slice(index, end));
    index = whitespace(end);
    // The colon is guaranteed by the preceding full-object JSON validation.
    const start = whitespace(index + 1);
    index = start;
    let depth = 0;
    while (index < text.length) {
      const char = text[index];
      if (char === '"') {
        index = stringEnd(index);
        continue;
      }
      if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (depth === 0) break;
        depth--;
      } else if (char === "," && depth === 0) break;
      index++;
    }
    entries.set(key, text.slice(start, index).trimEnd());
    if (text[index] !== ",") break;
    index = whitespace(index + 1);
  }
  return entries;
}

/** Never truncate an existing file; remove only our own incomplete creation. */
async function writePrivate(
  file: string,
  bytes: Buffer | string,
): Promise<void> {
  const handle = await open(file, "wx", 0o600);
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    await unlink(file).catch(() => {});
    throw error;
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
  private failure?: ConfigError;

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

  private async observe(): Promise<ConfigDocument> {
    try {
      const document = await load(this.file);
      const config = document.config;
      const changed =
        this.failure !== undefined ||
        JSON.stringify(config) !== JSON.stringify(this.snapshot);
      this.snapshot = config;
      this.failure = undefined;
      if (changed) this.broadcast(frame("config", config));
      return { ...document, config: { ...config } };
    } catch (error) {
      const safe = ioError(error);
      if (
        this.failure?.message !== safe.message ||
        this.failure?.code !== safe.code
      ) {
        this.failure = safe;
        this.broadcast(
          frame("config-error", { error: safe.message, code: safe.code }),
        );
      }
      throw safe;
    }
  }

  read(): Promise<Config> {
    return this.enqueue(async () => (await this.observe()).config);
  }

  patch(value: unknown): Promise<Config> {
    // Direct embedders can supply optional undefined fields even though JSON
    // clients cannot. Treat those as omitted, never serialize them as values.
    const patch = Object.fromEntries(
      Object.entries(configPatchSchema.parse(value)).filter(
        ([, value]) => value !== undefined,
      ),
    ) as Partial<Config>;
    return this.enqueue(async () => {
      if (Object.keys(patch).length === 0) return (await this.observe()).config;
      return this.withLock(async () => {
        const current = await this.observe();
        if (
          Object.entries(patch).every(
            ([key, value]) =>
              (Object.hasOwn(current.values, key)
                ? current.values[key]
                : defaultConfig[key as keyof Config]) === value,
          )
        )
          return current.config;
        const next = { ...current.config, ...patch };
        return this.replace(next, serializePatch(current, patch));
      }, true);
    });
  }

  resetInvalid(value: unknown): Promise<{ config: Config; backup: string }> {
    resetInvalidSchema.parse(value);
    return this.enqueue(() =>
      this.withLock(async () => {
        // Size, readability and file-type errors are deliberately outside the
        // parse catch: even CONFIG_INVALID oversized files cannot be reset.
        const bytes = await readBytes(this.file);
        if (bytes === undefined) throw notInvalid();
        try {
          parseBytes(bytes);
          throw notInvalid();
        } catch (error) {
          if (
            !(error instanceof ConfigError) ||
            error.code !== "CONFIG_INVALID"
          )
            throw error;
        }
        const backup = `${this.file}.${randomUUID()}.invalid.bak`;
        // Keep a completed backup even if replacing the config later fails.
        // A failed/incomplete backup never permits a replacement.
        await writePrivate(backup, bytes);
        const config = await this.replace({ ...defaultConfig });
        return { config, backup: path.basename(backup) };
      }),
    );
  }

  /** Shared by saves and recovery, covering the entire read/validate/write. */
  private async withLock<T>(
    work: () => Promise<T>,
    createDirectory = false,
  ): Promise<T> {
    const lockPath = `${this.file}.lock`;
    let lock: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (createDirectory)
        await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const deadline = Date.now() + 3000;
      while (!lock) {
        try {
          lock = await open(lockPath, "wx", 0o600);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "ENOENT" && !createDirectory) throw notInvalid();
          if (code !== "EEXIST") throw error;
          if (Date.now() >= deadline)
            throw new ConfigError(
              "Shared preferences are locked by another writer. Retry after it finishes; if a process crashed, remove config.json.lock only after all jj-stamp processes have stopped.",
              "CONFIG_BUSY",
              503,
            );
          await delay(25);
        }
      }
      return await work();
    } catch (error) {
      throw ioError(error);
    } finally {
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
  }

  private async replace(
    config: Config,
    text = `${JSON.stringify(config, null, 2)}\n`,
  ): Promise<Config> {
    if (Buffer.byteLength(text) > MAX_CONFIG_BYTES)
      throw new ConfigError(
        "Saving these preferences would exceed the 64 KiB limit. Reduce config.json before saving preferences.",
        "CONFIG_TOO_LARGE",
        409,
      );
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writePrivate(temporary, text);
    try {
      await rename(temporary, this.file);
    } finally {
      await unlink(temporary).catch(() => {});
    }
    this.snapshot = config;
    this.failure = undefined;
    this.broadcast(frame("config", config));
    return { ...config };
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
        this.send(
          client,
          frame("config-error", {
            error: this.failure.message,
            code: this.failure.code,
          }),
        );
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
  router.post("/reset-invalid", async (req, res) =>
    res.json(await store.resetInvalid(req.body)),
  );
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
