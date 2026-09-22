import express from "express";
import { z } from "zod";
import { ApiError, ReviewService } from "./service.ts";
import { processFailureOutput, ProcessError } from "./process.ts";

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

/** Factory lets integration tests use isolated real repositories. */
export function createApi(service: ReviewService): express.Router {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  router.use(express.json({ limit: "512kb" }));
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
        changeId: z.string().regex(/^[k-z]{1,64}$/),
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
