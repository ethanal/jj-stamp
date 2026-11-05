import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { createApi } from "./api.ts";
import type { ReviewService } from "./service.ts";
import { createPrRouter, type PrHandlers } from "./pr-review.ts";

export const DEFAULT_PORT = 8000;

export interface LocalServerOptions {
  service: ReviewService;
  assetsDir: string;
  port?: number;
  pr?: PrHandlers;
}

/** A loopback-only UI; no externally reachable host or proxy configuration. */
export async function startLocalServer({
  service,
  assetsDir,
  port,
  pr,
}: LocalServerOptions) {
  const app = express();
  const server = createServer(app);
  let closing = false;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const address = server.address();
    const authority =
      address && typeof address !== "string" ? `127.0.0.1:${address.port}` : "";
    // Checking Host as well as Origin blocks DNS rebinding. Even reads can
    // snapshot a jj workspace, so apply this before static assets and the API.
    if (
      req.headers.host !== authority ||
      (req.headers.origin !== undefined &&
        req.headers.origin !== `http://${authority}`) ||
      req.headers["sec-fetch-site"] === "cross-site"
    ) {
      res.status(403).json({
        error: "Only same-origin loopback requests are allowed.",
        code: "FORBIDDEN",
      });
      return;
    }
    if (closing) {
      res
        .status(503)
        .json({ error: "jj-stamp is shutting down.", code: "SHUTTING_DOWN" });
      return;
    }
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
    next();
  });
  const mutationProtection: express.RequestHandler = (req, res, next) => {
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      (!req.is("application/json") || req.headers["x-fold-request"] !== "1")
    ) {
      res.status(403).json({
        error: "Use the jj-stamp UI for mutations.",
        code: "FORBIDDEN",
      });
      return;
    }
    next();
  };
  const apiNotFound: express.RequestHandler = (_req, res) => {
    res.status(404).json({ error: "API route not found.", code: "NOT_FOUND" });
  };
  const staticNotFound: express.RequestHandler = (_req, res) =>
    res
      .status(404)
      .set("Cache-Control", "no-store")
      .type("text")
      .send("Not found");
  const contexts = new Map<string, ReturnType<typeof createContext>>();
  const services = new Set([service]);
  function createContext(service: ReviewService, pr?: PrHandlers) {
    const router = express.Router({ strict: true });
    const api = createApi(service);
    services.add(service);
    router.use("/api", mutationProtection);
    if (pr) router.use("/api", createPrRouter(pr));
    router.use("/api", api, apiNotFound);
    return { router, api };
  }
  const root = createContext(service, pr);
  app.use(root.router);
  const clientDir = path.resolve(assetsDir);
  // Nix builds normalize mtimes, and successive index files often have the
  // same size. Never revalidate unversioned files against stat-based validators.
  const unversionedFiles = express.static(clientDir, {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
  });
  app.use((req, res, next) => {
    let decodedPath = req.path;
    try {
      decodedPath = decodeURIComponent(req.path);
    } catch {
      // Malformed escapes under the reserved prefix still fail closed below.
    }
    if (!/^\/reviews(?:\/|$)/i.test(decodedPath)) {
      next();
      return;
    }
    // Match the raw path, not decoded route parameters: encoded, uppercase,
    // partial and unloaded IDs must never reach the original workspace.
    const match = /^\/reviews\/([0-9a-f]{64})\/.*$/.exec(req.path);
    const workspace = match && pr?.workspace?.(match[1]);
    if (!match || !workspace) {
      staticNotFound(req, res, next);
      return;
    }
    let context = contexts.get(match[1]);
    if (!context) {
      context = createContext(workspace.service, workspace.pr);
      contexts.set(match[1], context);
    }
    // Keep query strings intact while routing this request in its own context.
    req.url = req.url.slice("/reviews/".length + match[1].length);
    if ((req.method === "GET" || req.method === "HEAD") && req.path === "/") {
      unversionedFiles(req, res, (error?: unknown) => {
        if (error) next(error);
        else staticNotFound(req, res, next);
      });
      return;
    }
    context.router(req, res, (error?: unknown) => {
      if (error) next(error);
      else staticNotFound(req, res, next);
    });
  });
  // Content-hashed build assets can retain normal conditional caching.
  app.use("/assets", express.static(path.join(clientDir, "assets")));
  app.use(unversionedFiles);
  app.use(staticNotFound);

  const listen = (requestedPort: number) =>
    new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => {
        server.removeListener("listening", ready);
        reject(error);
      };
      const ready = () => {
        server.removeListener("error", failed);
        resolve();
      };
      server.once("error", failed);
      server.once("listening", ready);
      server.listen(requestedPort, "127.0.0.1");
    });
  try {
    await listen(port ?? DEFAULT_PORT);
  } catch (error) {
    // Keep the browser origin (and its preferences) stable whenever possible.
    // Only the implicit default may fall back; explicit ports fail as requested.
    if (
      port !== undefined ||
      (error as NodeJS.ErrnoException).code !== "EADDRINUSE"
    )
      throw error;
    await listen(0);
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No listening address");
  let shutdown: Promise<void> | undefined;
  return {
    server,
    url: `http://127.0.0.1:${address.port}/`,
    close(): Promise<void> {
      if (!shutdown) {
        closing = true;
        // End long-lived SSE responses before server.close(), otherwise they
        // would keep graceful shutdown open indefinitely.
        root.api.closeEvents();
        for (const context of contexts.values()) context.api.closeEvents();
        shutdown = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        }).then(async () => {
          await Promise.all([...services].map((service) => service.drain()));
        });
      }
      return shutdown;
    },
  };
}
