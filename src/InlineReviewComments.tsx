import { useRef, useState } from "react";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import {
  containsReviewMarkers,
  parseReviewComments,
  type ReviewComment,
  type ReviewCommentMutation,
  type ReviewCommentsParseResult,
} from "./review-comments";
import "./InlineReviewComments.css";

export interface InlineCommentProps {
  /** The parent owns mutation serialization, version checking, and reloads. */
  onComment?: (input: ReviewCommentMutation) => Promise<void>;
  commentEditingEnabled?: boolean;
  commentBusy?: boolean;
}

export const commentSquashReason =
  "Files containing JJ-STAMP review markers cannot be squashed. Remove the comments first.";

export interface InlineCommentFile {
  old: ReviewCommentsParseResult;
  new: ReviewCommentsParseResult;
  hasMarkers: boolean;
  oldMarkerLines: Set<number>;
  newMarkerLines: Set<number>;
  copyContents: string;
}

function markerLines(parsed: ReviewCommentsParseResult): Set<number> {
  // Ambiguous or malformed markers remain literal code, never hidden.
  if (parsed.issues.length) return new Set();
  return new Set(
    parsed.comments.flatMap((comment) => [
      ...comment.markerLines,
      ...(comment.endMarkerLine ? [comment.endMarkerLine] : []),
    ]),
  );
}

export function readInlineCommentFile(
  path: string,
  files: FileDiffLoadedFiles,
): InlineCommentFile {
  const oldContents = files.oldFile?.contents ?? "";
  const newContents = files.newFile?.contents ?? "";
  const old = parseReviewComments(path, oldContents);
  const next = parseReviewComments(path, newContents);
  const oldMarkerLines = markerLines(old);
  const newMarkerLines = markerLines(next);
  return {
    old,
    new: next,
    oldMarkerLines,
    newMarkerLines,
    hasMarkers:
      containsReviewMarkers(oldContents) || containsReviewMarkers(newContents),
    // Preserve original line numbers and terminators for the existing copy
    // handler, but never leak hidden marker syntax into copied source.
    copyContents: (newContents.match(/[^\n]*\n|[^\n]+$/g) ?? [])
      .map((line, index) =>
        newMarkerLines.has(index + 1)
          ? line.endsWith("\r\n")
            ? "\r\n"
            : line.endsWith("\n")
              ? "\n"
              : ""
          : line,
      )
      .join(""),
  };
}

export function commentRange(
  range: SelectedLineRange | null,
  markers: Set<number>,
): { line: number; endLine: number } | null {
  if (
    !range ||
    (range.side ?? "additions") !== "additions" ||
    (range.endSide ?? range.side ?? "additions") !== "additions"
  )
    return null;
  const line = Math.min(range.start, range.end);
  const endLine = Math.max(range.start, range.end);
  if ([...markers].some((marker) => marker >= line && marker <= endLine))
    return null;
  return { line, endLine };
}

export type InlineCommentAnnotation =
  | { kind: "comment"; comment: ReviewComment; historical: boolean }
  | { kind: "compose"; line: number; endLine: number };

export function InlineCommentEditor({
  initialBody = "",
  label,
  busy,
  onSave,
  onCancel,
}: {
  initialBody?: string;
  label: string;
  busy: boolean;
  onSave: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState(initialBody);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const save = async () => {
    if (busy || submitting.current || !body.trim()) return;
    submitting.current = true;
    setPending(true);
    setError("");
    try {
      await onSave(body);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  };
  return (
    <form
      className="inline-review-comment inline-review-editor"
      aria-label={label}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // These are real editing controls, not diff keyboard commands.
        event.stopPropagation();
        if (event.key === "Escape" && !busy && !pending) {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        }
      }}
    >
      <label>
        <span>{label}</span>
        <textarea
          autoFocus
          aria-label="Comment body"
          rows={3}
          value={body}
          disabled={busy || pending}
          onChange={(event) => setBody(event.target.value)}
        />
      </label>
      {error && <div role="alert">{error}</div>}
      <div className="inline-review-actions">
        <button type="submit" disabled={busy || pending || !body.trim()}>
          {pending ? "Saving…" : "Save comment"}
        </button>
        <button type="button" disabled={busy || pending} onClick={onCancel}>
          Cancel
        </button>
        <span>Saved in the source file · not sent to GitHub</span>
      </div>
    </form>
  );
}

export function InlineReviewComment({
  comment,
  historical,
  editable,
  busy,
  onEdit,
  onRemove,
  onFocusDiff,
}: {
  comment: ReviewComment;
  historical: boolean;
  editable: boolean;
  busy: boolean;
  onEdit: (body: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onFocusDiff: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const finish = () => {
    setEditing(false);
    onFocusDiff();
  };
  if (editing && editable)
    return (
      <InlineCommentEditor
        label="Edit review comment"
        initialBody={comment.body}
        busy={busy}
        onCancel={finish}
        onSave={async (body) => {
          await onEdit(body);
          finish();
        }}
      />
    );
  return (
    <article
      className="inline-review-comment"
      aria-label={historical ? "Previous review comment" : "Review comment"}
      data-comment-id={comment.id}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <header>
        <strong>
          {historical ? "Previous review comment" : "Review comment"}
        </strong>
        <span>
          Line {comment.anchorLine}
          {comment.endAnchorLine !== comment.anchorLine
            ? `–${comment.endAnchorLine}`
            : ""}
          {historical ? " · read-only" : " · file-backed"}
        </span>
      </header>
      <p className="inline-review-body">{comment.body}</p>
      {error && <div role="alert">{error}</div>}
      {editable && !historical && (
        <div className="inline-review-actions">
          <button disabled={busy || removing} onClick={() => setEditing(true)}>
            Edit comment
          </button>
          <button
            disabled={busy || removing}
            onClick={async () => {
              setRemoving(true);
              setError("");
              try {
                await onRemove();
                onFocusDiff();
              } catch (error) {
                setError(
                  error instanceof Error ? error.message : String(error),
                );
              } finally {
                setRemoving(false);
              }
            }}
          >
            {removing ? "Removing…" : "Remove comment"}
          </button>
        </div>
      )}
    </article>
  );
}
