// Development-only preview. Always uses a disposable fixture repository,
// never the source checkout or a user-supplied repository.
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import express from "express";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { createDemo } from "../tests/fixtures.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8092" },
    "public-origin": { type: "string" },
  },
});
const port = Number(values.port);
if (
  !/^\d+$/.test(values.port) ||
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535
)
  throw new Error("--port must be an integer from 1 to 65535");
const origins = new Map([
  [`127.0.0.1:${port}`, `http://127.0.0.1:${port}`],
  [`localhost:${port}`, `http://localhost:${port}`],
]);
if (values["public-origin"]) {
  const url = new URL(values["public-origin"]);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error(
      "--public-origin must be an HTTP(S) origin, without a path",
    );
  origins.set(url.host, url.origin);
}
const root = path.resolve(import.meta.dirname, "..");
const assets = path.join(root, "dist/client");
await access(path.join(assets, "index.html")).catch(() => {
  throw new Error("Build first with npm run build, then run the PR prototype.");
});
const repoPath = await createDemo(path.join(root, ".data/pr-prototype"));
const service = new ReviewService({ repoPath });
await service.getState();
const api = createApi(service);
const app = express();
app.disable("x-powered-by");
let closing = false;
app.use((req, res, next) => {
  const expectedOrigin = origins.get(req.headers.host ?? "");
  if (
    !expectedOrigin ||
    (req.headers.origin !== undefined &&
      req.headers.origin !== expectedOrigin) ||
    req.headers["sec-fetch-site"] === "cross-site"
  ) {
    res
      .status(403)
      .json({ error: "Only same-origin prototype requests are allowed." });
    return;
  }
  if (closing) {
    res.status(503).json({ error: "The prototype is shutting down." });
    return;
  }
  res.setHeader("Cache-Control", "no-store");
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
    !["GET", "HEAD"].includes(req.method) &&
    (!req.is("application/json") || req.headers["x-fold-request"] !== "1")
  ) {
    res
      .status(403)
      .json({ error: "Use the prototype UI for fixture operations." });
    return;
  }
  next();
});
app.use("/api", api);
app.use("/api", (_req, res) =>
  res.status(404).json({ error: "API route not found." }),
);
app.use(express.static(assets, { etag: false, lastModified: false }));
app.use((_req, res) => res.status(404).type("text").send("Not found"));
const server = createServer(app);
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});
console.log(`PR prototype: http://127.0.0.1:${port}/?pr-prototype=1`);
console.log(`Disposable jj fixture: ${repoPath}`);
console.log(
  "PR data is simulated; ordinary squash/undo affects only this fixture.",
);
function stop() {
  if (closing) return;
  closing = true;
  api.closeEvents();
  server.close((error) => {
    void service.drain().then(() => {
      if (error) console.error(error);
      process.exitCode = error ? 1 : 0;
    });
  });
  server.closeIdleConnections();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
