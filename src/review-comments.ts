/** Reserved, whole-line opt-in annotations. Coordinates are physical file lines. */
export interface ReviewComment {
  id: string;
  body: string;
  markerLines: number[];
  startLine: number;
  anchorLine: number;
  endAnchorLine: number;
  endMarkerLine?: number;
}

export interface ReviewCommentsParseResult {
  comments: ReviewComment[];
  issues: string[];
  editable: boolean;
  reason?: string;
}

/** Code coordinates, never physical annotation-file coordinates. */
export interface ProjectedReviewComment {
  id: string;
  body: string;
  startLine: number;
  endLine: number;
  codeChangeId?: string;
}
export interface ReviewCommentOverlay {
  comments: ProjectedReviewComment[];
  unmapped: Array<{ id: string; body: string; reason: string }>;
  issues: string[];
  editable: boolean;
  reason?: string;
}

export type ReviewCommentMutation = { version: string; path: string } & (
  | { action: "add"; line: number; endLine?: number; body: string }
  | { action: "edit"; id: string; body: string }
  | { action: "remove"; id: string }
);

export const REVIEW_COMMENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Broader than parsing: malformed reserved lines and multiline examples count. */
export function containsReviewMarkers(contents: string): boolean {
  return /(?:^|\n)[ \t]*\/\/[ \t]*JJ-STAMP/.test(contents);
}

interface Marker {
  line: number;
  id: string;
  body?: string;
}

/** Parse reserved physical lines, not the surrounding source language. */
export function parseReviewComments(
  _path: string,
  contents: string,
): ReviewCommentsParseResult {
  const result: ReviewCommentsParseResult = {
    comments: [],
    issues: [],
    editable: false,
  };
  const physical = contents.split("\n");
  if (physical.at(-1) === "") physical.pop();
  const markers: Marker[] = [];
  for (let index = 0; index < physical.length; index++) {
    const line = index + 1;
    const text = physical[index].replace(/^[ \t]*/, "").replace(/\r$/, "");
    if (!/^\/\/[ \t]*JJ-STAMP/.test(text)) continue;
    const match = /^\/\/ JJ-STAMP\(([^)]+)\)(?:: ([^\r\n]*))?$/.exec(text);
    if (!match || !REVIEW_COMMENT_ID.test(match[1])) {
      result.issues.push(`Malformed review marker at line ${line}.`);
      continue;
    }
    markers.push({ line, id: match[1], body: match[2] });
  }
  const used = new Set<string>();
  const markerLines = new Set(markers.map((marker) => marker.line));
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i];
    if (used.has(start.id) || start.body === undefined) {
      result.issues.push(
        `Duplicate UUID or unmatched end at line ${start.line}.`,
      );
      continue;
    }
    used.add(start.id);
    const body = [start.body];
    const lines = [start.line];
    while (
      markers[i + 1]?.id === start.id &&
      markers[i + 1].body !== undefined &&
      markers[i + 1].line === lines.at(-1)! + 1
    ) {
      const continuation = markers[++i];
      body.push(continuation.body!);
      lines.push(continuation.line);
    }
    const anchorLine = lines.at(-1)! + 1;
    let endAnchorLine = anchorLine;
    let endMarkerLine: number | undefined;
    if (markers[i + 1]?.id === start.id && markers[i + 1].body === undefined) {
      endMarkerLine = markers[++i].line;
      endAnchorLine = endMarkerLine - 1;
      lines.push(endMarkerLine);
    }
    if (
      anchorLine > physical.length ||
      markerLines.has(anchorLine) ||
      endAnchorLine < anchorLine ||
      markerLines.has(endAnchorLine)
    ) {
      result.issues.push(
        `Review marker at line ${start.line} has no code anchor.`,
      );
      continue;
    }
    result.comments.push({
      id: start.id,
      body: body.join("\n"),
      markerLines: lines,
      startLine: start.line,
      anchorLine,
      endAnchorLine,
      ...(endMarkerLine === undefined ? {} : { endMarkerLine }),
    });
  }
  result.editable = result.issues.length === 0;
  if (!result.editable) {
    result.reason = result.issues.join(" ");
    // An invalid document must not offer partially valid edit/remove cards.
    result.comments = [];
  }
  return result;
}
