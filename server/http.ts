import express from "express";
import { createServer } from "node:http";
import path from "node:path";
import { createApi } from "./api.ts";
import type { ReviewService } from "./service.ts";

export interface LocalServerOptions {
  service: ReviewService;
  assetsDir: string;
  port?: number;
}

/** A loopback-only UI; no externally reachable host or proxy configuration. */
export async function startLocalServer({
  service,
  assetsDir,
  port = 0,
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
  app.use(express.static(path.resolve(assetsDir), { etag: true }));
  app.use((_req, res) => res.status(404).send("Not found"));

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
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
