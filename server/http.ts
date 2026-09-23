import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { createApi } from "./api.ts";
import type { ReviewService } from "./service.ts";

export const DEFAULT_PORT = 8000;

export interface LocalServerOptions {
  service: ReviewService;
  assetsDir: string;
  port?: number;
}

/** A loopback-only UI; no externally reachable host or proxy configuration. */
export async function startLocalServer({
  service,
  assetsDir,
  port,
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
  app.use("/api", (req, res, next) => {
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
  });
  app.use("/api", createApi(service));
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found.", code: "NOT_FOUND" });
  });
  const clientDir = path.resolve(assetsDir);
  // Content-hashed build assets can retain normal conditional caching.
  app.use("/assets", express.static(path.join(clientDir, "assets")));
  // Nix builds normalize mtimes, and successive index files often have the
  // same size. Stat-based ETags / Last-Modified can therefore falsely validate
  // an old page whose hashed assets no longer exist. Do not cache or revalidate
  // unversioned files, including validators sent by browsers on older builds.
  app.use(
    express.static(clientDir, {
      etag: false,
      lastModified: false,
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    }),
  );
  app.use((_req, res) =>
    res
      .status(404)
      .set("Cache-Control", "no-store")
      .type("text")
      .send("Not found"),
  );

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
        shutdown = new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeIdleConnections();
        }).then(() => service.drain());
      }
      return shutdown;
    },
  };
}
