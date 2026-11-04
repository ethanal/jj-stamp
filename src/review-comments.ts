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
  supported: boolean;
  lexicalSafe: boolean;
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

/** Deliberately no # languages: multiline/embedded string rules differ. */
export function commentSyntax(path: string): "//" | null {
  return /\.(?:[cm]?[jt]sx?|go|rs|c|h|cc|hh|cpp|hpp|cxx|hxx|java)$/.test(
    path.toLowerCase(),
  )
    ? "//"
    : null;
}

/** Broader than parsing: malformed reserved lines and multiline examples count. */
export function containsReviewMarkers(contents: string): boolean {
  return /^[ \t]*\/\/[ \t]*JJ-STAMP/m.test(contents);
}

interface Marker {
  line: number;
  id: string;
  body?: string;
}

/**
 * Small fail-closed lexical filter, NOT a language parser. Multiline literals,
 * template/Go raw strings, C++ raw strings, regex/division ambiguity and source
 * line continuations disable editing for the entire file. Block/string contents
 * are never interpreted as annotations. Rust nested block comments are tracked.
 */
function wholeLineComments(contents: string): {
  lines: Map<number, string>;
  safe: boolean;
} {
  const lines = new Map<number, string>();
  let block = 0;
  let line = 1;
  let onlyWhitespace = true;
  for (let i = 0; i < contents.length; i++) {
    const c = contents[i];
    const n = contents[i + 1];
    if (c === "\n") {
      line++;
      onlyWhitespace = true;
      continue;
    }
    if (block) {
      if (c === "/" && n === "*") {
        block++;
        i++;
      } else if (c === "*" && n === "/") {
        block--;
        i++;
      }
      onlyWhitespace = false;
      continue;
    }
    if (c === "/" && n === "/") {
      const end = contents.indexOf("\n", i);
      const text = contents
        .slice(i, end < 0 ? undefined : end)
        .replace(/\r$/, "");
      if (onlyWhitespace) lines.set(line, text);
      if (text.endsWith("\\")) return { lines, safe: false };
      if (end < 0) break;
      i = end - 1;
      continue;
    }
    if (c === "/" && n === "*") {
      block++;
      i++;
      onlyWhitespace = false;
      continue;
    }
    if (
      c === "`" ||
      c === "/" ||
      c === "\\" ||
      (c === "R" && n === '"') ||
      (c === "r" && (n === "#" || n === '"'))
    )
      return { lines, safe: false };
    if (c === "'" || c === '"') {
      const quote = c;
      let closed = false;
      for (i++; i < contents.length; i++) {
        if (contents[i] === "\n" || contents[i] === "\r")
          return { lines, safe: false };
        if (contents[i] === "\\") {
          i++;
          if (contents[i] === "\n" || contents[i] === "\r")
            return { lines, safe: false };
        } else if (contents[i] === quote) {
          closed = true;
          break;
        }
      }
      if (!closed) return { lines, safe: false };
    }
    if (!/[ \t\r]/.test(c)) onlyWhitespace = false;
  }
  return { lines, safe: block === 0 };
}

export function parseReviewComments(
  path: string,
  contents: string,
): ReviewCommentsParseResult {
  const supported = commentSyntax(path) !== null;
  const result: ReviewCommentsParseResult = {
    comments: [],
    issues: [],
    supported,
    lexicalSafe: false,
    editable: false,
  };
  if (!supported) {
    result.reason =
      "Review comments currently support only // source languages.";
    return result;
  }
  const lexed =
    /[\u2028\u2029]/.test(contents) ||
    contents.includes("??/") ||
    (/\.[jt]sx$/i.test(path) && /<[A-Za-z/!]/.test(contents))
      ? { lines: new Map<number, string>(), safe: false }
      : wholeLineComments(contents);
  result.lexicalSafe = lexed.safe;
  if (!lexed.safe) {
    result.reason =
      "This file contains ambiguous or multiline lexical constructs; review comment editing is disabled.";
    return result;
  }
  const markers: Marker[] = [];
  for (const [line, text] of lexed.lines) {
    if (!/^\/\/\s*JJ-STAMP/.test(text)) continue;
    const match = /^\/\/ JJ-STAMP\(([^)]+)\)(?:: (.*))?$/.exec(text);
    if (!match || !REVIEW_COMMENT_ID.test(match[1])) {
      result.issues.push(`Malformed review marker at line ${line}.`);
      continue;
    }
    markers.push({ line, id: match[1], body: match[2] });
  }
  const physical = contents.split("\n");
  if (physical.at(-1) === "") physical.pop();
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
