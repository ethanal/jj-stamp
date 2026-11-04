import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  parseReviewComments,
  REVIEW_COMMENT_ID,
  type ReviewCommentMutation,
} from "../src/review-comments.ts";
import { ApiError } from "./errors.ts";

const body = z
  .string()
  .max(16000)
  .refine(
    (text) =>
      text.trim().length > 0 &&
      !/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/.test(text),
    "Use nonempty plain text with LF-separated body lines.",
  );
const common = {
  version: z.string().regex(/^[0-9a-f]{64}$/),
  path: z.string().min(1).max(4096),
};
const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(REVIEW_COMMENT_ID);
export const commentMutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      ...common,
      action: z.literal("add"),
      line,
      endLine: line.optional(),
      body,
    })
    .strict(),
  z.object({ ...common, action: z.literal("edit"), id, body }).strict(),
  z.object({ ...common, action: z.literal("remove"), id }).strict(),
]);

export function validateCommentMutation(
  input: unknown,
): asserts input is ReviewCommentMutation {
  if (!commentMutationSchema.safeParse(input).success)
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Supply a valid comment action, current version, exact path, UUID/line and nonempty plain-text body.",
    );
}

function unavailable(message: string): never {
  throw new ApiError(422, "COMMENTS_UNAVAILABLE", message);
}

/** No newline normalization, lossy decoding or automatic marker repair. */
export function mutateReviewComments(
  file: string,
  bytes: Buffer,
  input: ReviewCommentMutation,
): Buffer {
  const text = bytes.toString("utf8");
  if (
    !Buffer.from(text, "utf8").equals(bytes) ||
    text.includes("\0") ||
    text.startsWith("\ufeff") ||
    !text.endsWith("\n")
  )
    unavailable(
      "Review comments require lossless UTF-8 source without BOM/NUL and with a final newline.",
    );
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  if (
    text.replaceAll("\r\n", "").includes("\r") ||
    (newline === "\r\n" && text.replaceAll("\r\n", "").includes("\n"))
  )
    unavailable("Mixed or unsupported newlines cannot be edited safely.");
  const parsed = parseReviewComments(file, text);
  if (!parsed.editable)
    unavailable(parsed.reason ?? "Unsafe review annotations.");
  const lines = text.slice(0, -newline.length).split(newline);
  const markerLines = new Set(
    parsed.comments.flatMap((comment) => comment.markerLines),
  );
  let expectedId: string | undefined;
  let expectedBody: string | undefined;
  if (input.action === "add") {
    const end = input.endLine ?? input.line;
    if (input.line > lines.length || end > lines.length || end < input.line)
      throw new ApiError(
        400,
        "INVALID_LINE",
        "Choose an ordered source line range inside the pinned file.",
      );
    if (
      parsed.comments.some(
        (comment) =>
          input.line <= (comment.endMarkerLine ?? comment.endAnchorLine) &&
          end >= comment.startLine,
      )
    )
      unavailable("Overlapping review annotations are not supported.");
    expectedId = randomUUID();
    expectedBody = input.body;
    const prefix = /^[ \t]*/.exec(lines[input.line - 1])![0];
    const start = input.body
      .split("\n")
      .map((part) => `${prefix}// JJ-STAMP(${expectedId}): ${part}`);
    if (end > input.line)
      lines.splice(end, 0, `${prefix}// JJ-STAMP(${expectedId})`);
    lines.splice(input.line - 1, 0, ...start);
  } else {
    const comment = parsed.comments.find((comment) => comment.id === input.id);
    if (!comment)
      throw new ApiError(
        400,
        "INVALID_COMMENT",
        "The UUID is not a unique valid review comment in the pinned file.",
      );
    if (input.action === "remove") {
      const remove = new Set(comment.markerLines);
      for (let i = lines.length - 1; i >= 0; i--)
        if (remove.has(i + 1)) lines.splice(i, 1);
    } else {
      expectedId = comment.id;
      expectedBody = input.body;
      const prefix = /^[ \t]*/.exec(lines[comment.startLine - 1])![0];
      const startLines = comment.markerLines.filter(
        (n) => n !== comment.endMarkerLine,
      );
      lines.splice(
        comment.startLine - 1,
        startLines.length,
        ...input.body
          .split("\n")
          .map((part) => `${prefix}// JJ-STAMP(${comment.id}): ${part}`),
      );
    }
  }
  // In particular, a target inside a block comment cannot create an invisible
  // annotation; newly inserted text must round-trip as exactly one real card.
  const result = lines.join(newline) + (lines.length ? newline : "");
  const verified = parseReviewComments(file, result);
  if (
    !verified.editable ||
    (expectedId &&
      !verified.comments.some(
        (comment) => comment.id === expectedId && comment.body === expectedBody,
      )) ||
    (input.action === "add" && markerLines.has(input.line))
  )
    unavailable(
      "The annotation would not round-trip safely at these source lines.",
    );
  return Buffer.from(result, "utf8");
}
