import express from "express";
import type { Request, Response, Router } from "express";
import { z } from "zod";
import { ApiError, ReviewService } from "./service.ts";
import { processFailureOutput, ProcessError } from "./process.ts";
import { watchFailure, type WatchFailure } from "./watch-errors.ts";
import {
  watchFilesystemEvents,
  type FilesystemChange,
  type FilesystemEventBackend,
  type FilesystemEventWatcher,
} from "./fs-events.ts";

const version = z.string().regex(/^[0-9a-f]{64}$/);
const previewSchema = z
  .object({
    version,
    target: z.string().regex(/^[k-z]{1,64}$/),
    selections: z
      .array(
        z
          .object({
            id: z.string().regex(/^[0-9a-f]{7}(?:-\d+)?$/),
            lines: z.array(z.number().int().positive()).min(1).max(100000),
          })
          .strict(),
      )
      .min(1)
      .max(2000),
  })
  .strict();

const MAX_EVENT_CLIENTS = 32;
const MAX_PENDING_EVENT_FRAMES = 16;
const MAX_EVENT_HEADS = 64;
const EVENT_HEAD_ID = /^[0-9a-f]{32,128}$/;
const HEARTBEAT_MS = 15_000;

interface EventClient {
  response: Response;
  pending: string[];
  blocked: boolean;
  closed: boolean;
}

export interface ApiRouter extends Router {
  closeEvents(): void;
}

export interface ApiOptions {
  eventBackend?: FilesystemEventBackend;
  maxEventClients?: number;
}

function eventFrame(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function boundedChange(change: FilesystemChange): FilesystemChange {
  if (change.heads === null)
    return { workspace: change.workspace === true, heads: null };
  const heads = [...new Set(change.heads)];
  return {
    workspace: change.workspace === true,
    heads:
      heads.length <= MAX_EVENT_HEADS &&
      heads.every((head) => EVENT_HEAD_ID.test(head))
        ? heads.sort()
        : null,
  };
}

class EventHub {
  private readonly clients = new Set<EventClient>();
  private watcher?: FilesystemEventWatcher;
  private starting?: AbortController;
  private heartbeat?: NodeJS.Timeout;
  private generation = 0;
  private running = false;
  private failure?: WatchFailure;
  private closed = false;
  private pendingChange?: FilesystemChange;
  private unsubscribePaths?: () => void;

  constructor(
    private readonly service: ReviewService,
    private readonly backend: FilesystemEventBackend,
    private readonly maxClients: number,
  ) {}

  connect(request: Request, response: Response) {
    if (this.closed) {
      response.status(503).json({
        error: "jj-stamp is shutting down.",
        code: "SHUTTING_DOWN",
      });
      return;
    }
    if (this.clients.size >= this.maxClients) {
      response.status(503).json({
        error: "Too many filesystem event clients.",
        code: "BUSY",
      });
      return;
    }
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    const client: EventClient = {
      response,
      pending: [],
      blocked: false,
      closed: false,
    };
    const disconnected = () => this.remove(client);
    request.once("aborted", disconnected);
    response.once("close", disconnected);
    if (this.failure) {
      response.end(eventFrame("unavailable", this.failure));
      return;
    }
    this.clients.add(client);
    if (this.running) this.send(client, eventFrame("ready", {}));
    else this.start();
  }

  private start() {
    if (this.starting || this.running || this.failure || this.closed) return;
    const controller = new AbortController();
    const generation = ++this.generation;
    this.starting = controller;
    this.unsubscribePaths = this.service.subscribeWatchPaths((paths) => {
      this.updatePaths(generation, paths);
    });
    void this.service
      .getWatchRoot()
      .then((root) => {
        if (
          controller.signal.aborted ||
          generation !== this.generation ||
          this.clients.size === 0
        )
          throw Object.assign(new Error("Event setup cancelled."), {
            name: "AbortError",
          });
        return this.backend(
          root,
          {
            change: (change) => this.changed(generation, change),
            unavailable: (error) => this.unavailable(generation, error),
          },
          controller.signal,
          this.service.getWatchPaths(),
        );
      })
      .then((watcher) => {
        if (
          controller.signal.aborted ||
          generation !== this.generation ||
          this.clients.size === 0 ||
          this.closed
        ) {
          watcher.close();
          return;
        }
        this.watcher = watcher;
        // A successful state read/selection may have changed scope while native
        // setup was in flight. Install the latest paths before publishing ready.
        this.updatePaths(generation, this.service.getWatchPaths());
        if (generation !== this.generation || this.closed || this.failure)
          return;
        this.running = true;
        this.starting = undefined;
        for (const client of this.clients)
          this.send(client, eventFrame("ready", {}));
        if (this.pendingChange) {
          const pending = this.pendingChange;
          this.pendingChange = undefined;
          this.broadcast(eventFrame("change", pending));
        }
        this.heartbeat = setInterval(
          () => this.broadcast(": heartbeat\n\n"),
          HEARTBEAT_MS,
        );
        this.heartbeat.unref?.();
      })
      .catch((error: unknown) => {
        if (
          (error instanceof Error && error.name === "AbortError") ||
          controller.signal.aborted ||
          generation !== this.generation
        )
          return;
        this.unavailable(generation, error);
      });
  }

  private updatePaths(generation: number, paths: string[]) {
    if (generation !== this.generation || this.closed || this.failure) return;
    try {
      this.watcher?.setPaths(paths);
    } catch (error) {
      this.unavailable(generation, error);
    }
  }

  private changed(generation: number, rawChange: FilesystemChange) {
    if (generation !== this.generation || this.closed || this.failure) return;
    const change = boundedChange(rawChange);
    if (!this.running) {
      this.pendingChange = this.pendingChange
        ? {
            workspace: this.pendingChange.workspace || change.workspace,
            heads: change.heads,
          }
        : change;
      return;
    }
    this.broadcast(eventFrame("change", change));
  }

  private unavailable(generation: number, error?: unknown) {
    if (generation !== this.generation || this.closed || this.failure) return;
    this.failure = watchFailure(error);
    this.stopWatcher();
    // Report once, including the original filesystem error in the owner's
    // terminal. Reconnecting clients receive the same sanitized diagnosis.
    try {
      console.warn(
        `[jj-stamp watch] ${this.failure.code}: ${this.failure.message}`,
        error,
      );
    } catch {
      /* Diagnostics must never prevent stream/watcher cleanup. */
    }
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) {
      client.closed = true;
      if (client.blocked || client.pending.length > 0)
        client.response.destroy();
      else client.response.end(eventFrame("unavailable", this.failure));
    }
  }

  private send(client: EventClient, frame: string) {
    if (
      client.closed ||
      client.response.destroyed ||
      client.response.writableEnded
    ) {
      this.remove(client);
      return;
    }
    if (client.blocked) {
      if (client.pending.length >= MAX_PENDING_EVENT_FRAMES) {
        this.remove(client);
        client.response.destroy();
      } else {
        client.pending.push(frame);
      }
      return;
    }
    if (!client.response.write(frame)) {
      client.blocked = true;
      client.response.once("drain", () => this.flush(client));
    }
  }

  private flush(client: EventClient) {
    if (client.closed) return;
    client.blocked = false;
    while (!client.blocked && client.pending.length > 0) {
      const frame = client.pending.shift()!;
      if (!client.response.write(frame)) client.blocked = true;
    }
    if (client.blocked) client.response.once("drain", () => this.flush(client));
  }

  private broadcast(frame: string) {
    for (const client of this.clients) this.send(client, frame);
  }

  private remove(client: EventClient) {
    if (client.closed) return;
    client.closed = true;
    this.clients.delete(client);
    if (this.clients.size === 0 && !this.failure) this.stopWatcher();
  }

  private stopWatcher() {
    this.generation++;
    this.unsubscribePaths?.();
    this.unsubscribePaths = undefined;
    this.starting?.abort();
    this.starting = undefined;
    this.watcher?.close();
    this.watcher = undefined;
    this.running = false;
    this.pendingChange = undefined;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopWatcher();
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) {
      client.closed = true;
      if (client.blocked || client.pending.length > 0)
        client.response.destroy();
      else client.response.end();
    }
  }
}

/** Factory lets integration tests use isolated real repositories. */
export function createApi(
  service: ReviewService,
  options: ApiOptions = {},
): ApiRouter {
  const router = express.Router() as ApiRouter;
  const events = new EventHub(
    service,
    options.eventBackend ?? watchFilesystemEvents,
    options.maxEventClients ?? MAX_EVENT_CLIENTS,
  );
  router.closeEvents = () => events.close();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "512kb" }));
  // Express otherwise routes HEAD through GET and would allocate a watcher for
  // a response that can never consume an event stream.
  router.head("/events", (_req, res) => res.status(204).end());
  router.get("/events", (req, res) => events.connect(req, res));
  router.get("/state", async (_req, res) => {
    res.json(await service.getState());
  });
  // This is local revision-graph data, not an event/telemetry logging endpoint.
  router.get("/graph", async (_req, res) => {
    const { version, rows } = await service.getLog({ includeOutput: false });
    res.json({ version, rows });
  });
  router.get("/log", async (req, res) => {
    const format = z
      .enum(["full", "rows"])
      .default("full")
      .parse(req.query.format);
    const result = await service.getLog({ includeOutput: format === "full" });
    res.json(
      format === "rows"
        ? { version: result.version, rows: result.rows }
        : result,
    );
  });
  router.post("/revision", async (req, res) => {
    const input = z
      .object({
        version,
        changeId: z.union([z.literal("@"), z.string().regex(/^[k-z]{1,64}$/)]),
      })
      .strict()
      .parse(req.body);
    res.json(await service.selectRevision(input));
  });
  router.post("/editor", async (req, res) => {
    const input = z
      .object({
        version,
        path: z.string().min(1).max(4096),
        line: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      })
      .strict()
      .parse(req.body);
    res.json(await service.openEditor(input));
  });
  const commitId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
  router.post("/commit", async (req, res) => {
    res.json(
      await service.getCommit(z.object({ commitId }).strict().parse(req.body)),
    );
  });
  router.post("/commit-file", async (req, res) => {
    res.json(
      await service.getCommitFile(
        z
          .object({ commitId, path: z.string().min(1).max(4096) })
          .strict()
          .parse(req.body),
      ),
    );
  });
  router.post("/file", async (req, res) => {
    const input = z
      .object({ version, path: z.string().min(1).max(4096) })
      .strict()
      .parse(req.body);
    res.json(await service.getFile(input));
  });
  router.post("/squash-lines", async (req, res) => {
    res.json(
      await service.squashLines(
        previewSchema.omit({ target: true }).parse(req.body),
      ),
    );
  });
  router.post("/preview", async (req, res) => {
    res.json(await service.preview(previewSchema.parse(req.body)));
  });
  router.post("/squash", async (req, res) => {
    const { token } = z
      .object({ token: z.string().regex(/^[0-9a-f]{64}$/) })
      .strict()
      .parse(req.body);
    res.json(await service.squash(token));
  });
  router.post("/undo", async (req, res) => {
    const input = z.object({ version }).strict().parse(req.body);
    res.json(await service.undo(input.version));
  });
  router.use(((error: unknown, _req, res, _next) => {
    if (error instanceof ApiError) {
      res
        .status(error.status)
        .json({ error: error.message, code: error.code, ...error.details });
      return;
    }
    if (error instanceof ProcessError) {
      res.status(500).json({
        error: error.message,
        code: "TOOL_FAILED",
        output: processFailureOutput(error),
      });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error:
          "Invalid request. Supply the current version and valid changed-line selections.",
        code: "INVALID_REQUEST",
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      res.status(400).json({
        error: "Request body must be valid JSON.",
        code: "INVALID_REQUEST",
      });
      return;
    }
    console.error("Review API:", error);
    res.status(500).json({
      error:
        error instanceof Error ? error.message : "Unexpected repository error.",
      code: "SERVER_ERROR",
    });
  }) as express.ErrorRequestHandler);
  return router;
}
