import express from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createServer as createViteServer } from "vite";
import api, { drainApi } from "./server/api.ts";

const app = express();
const server = createServer(app);
const port = Number(process.env.PORT || 8000);
app.disable("x-powered-by");
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api", (req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  if (!req.is("application/json") || req.headers["x-fold-request"] !== "1") {
    res
      .status(403)
      .json({
        error: "Use a same-origin jj-stamp request.",
        code: "FORBIDDEN",
      });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    const allowed = new Set([
      req.headers.host,
      "ethan-antithesis.exe.xyz",
      "ethan-antithesis.exe.xyz:8000",
      `localhost:${port}`,
      `127.0.0.1:${port}`,
    ]);
    try {
      if (!allowed.has(new URL(origin).host)) throw new Error();
    } catch {
      res.status(403).json({ error: "Origin not allowed.", code: "FORBIDDEN" });
      return;
    }
  }
  next();
});
app.use("/api", api);
app.use("/api", (_req, res) => {
  res.status(404).json({ error: "API route not found.", code: "NOT_FOUND" });
});
app.use(((
  error: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction,
) => {
  console.error(error);
  res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
    code: "SERVER_ERROR",
  });
}) as express.ErrorRequestHandler);
let vite: Awaited<ReturnType<typeof createViteServer>> | undefined;
if (process.env.NODE_ENV === "production") {
  app.use(express.static(resolve("dist")));
  app.get("/{*path}", (_req, res) => res.sendFile(resolve("dist/index.html")));
} else {
  vite = await createViteServer({
    server: { middlewareMode: true, hmr: { server } },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
server.listen(port, "0.0.0.0", () =>
  console.log(`jj-stamp listening on http://localhost:${port}`),
);

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // Stop accepting connections; do not interrupt a history rewrite, including
  // one whose client disconnected before its response was delivered.
  server.close(async () => {
    await drainApi();
    await vite?.close();
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
