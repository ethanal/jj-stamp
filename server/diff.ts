/** Parse and reconcile jj diffs with jj-hunk-tool's one-based patch-body rows. */
export interface Row {
  raw: string;
  oldLine?: number;
  newLine?: number;
  hunk: number;
  index: number;
}
export interface Hunk {
  header: string;
  rows: Row[];
}
export interface FileDiff {
  path: string;
  hunks: Hunk[];
}
export interface ToolHunk {
  id: string;
  rows: string[];
}

/** Reject patch formats the upstream tool cannot safely round-trip. */
function assertSupported(patch: string): void {
  if (
    /^(?:rename (?:from|to)|copy (?:from|to)|(?:old|new) mode|similarity index|dissimilarity index) /m.test(
      patch,
    )
  ) {
    throw new Error(
      "Renames, copies, and mode changes are not supported by jj-hunk-tool.",
    );
  }
  if (/^(?:new|deleted) file mode (?!100644$)/m.test(patch)) {
    throw new Error("Only regular, non-executable text files are supported.");
  }
  if (/^index [0-9a-f]+\.\.[0-9a-f]+ (?!100644$)\d+/m.test(patch)) {
    throw new Error("Only regular, non-executable text files are supported.");
  }
  if (/^\\ No newline at end of file/m.test(patch)) {
    throw new Error(
      "Files without a final newline are not supported safely by jj-hunk-tool. Add a newline and refresh first.",
    );
  }
  if (/^(?:GIT binary patch|Binary files |@@@)/m.test(patch)) {
    throw new Error(
      "Binary files and combined merge patches are not supported.",
    );
  }
}

/** Read unquoted Git file headers; quoted/control-character paths fail closed. */
function readPath(header: string, prefix: string): string | null {
  const value = header.slice(4);
  if (value === "/dev/null") return null;
  if (!value.startsWith(prefix) || /[\s\x00-\x1f\x7f"\\]/.test(value)) {
    throw new Error(
      "Whitespace, quoted, or control-character file paths are not supported safely by jj-hunk-tool.",
    );
  }
  return value.slice(prefix.length);
}

/** Parse one file, checking hunk counts so malformed output can never select other rows. */
export function parseFile(patch: string, path: string): FileDiff {
  assertSupported(patch);
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let cursor = 0;
  for (; cursor < lines.length && !lines[cursor].startsWith("@@ "); cursor++) {
    if (lines[cursor].startsWith("--- "))
      oldPath = readPath(lines[cursor], "a/");
    if (lines[cursor].startsWith("+++ "))
      newPath = readPath(lines[cursor], "b/");
  }
  if (
    oldPath === undefined ||
    newPath === undefined ||
    (newPath ?? oldPath) !== path
  ) {
    throw new Error("Patch file headers do not match the selected file.");
  }
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    throw new Error("Renamed files are not supported.");
  }
  while (cursor < lines.length) {
    const header = lines[cursor++];
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(
      header,
    );
    if (!match) throw new Error("Expected a unified-diff hunk header.");
    let oldLine = Number(match[1]);
    let newLine = Number(match[3]);
    let oldRemaining = Number(match[2] ?? 1);
    let newRemaining = Number(match[4] ?? 1);
    if (
      ![
        oldLine,
        newLine,
        oldRemaining,
        newRemaining,
        oldLine + oldRemaining,
        newLine + newRemaining,
      ].every(Number.isSafeInteger) ||
      (oldRemaining > 0 && oldLine === 0) ||
      (newRemaining > 0 && newLine === 0) ||
      oldRemaining + newRemaining === 0
    ) {
      throw new Error("Diff hunk has invalid or unsafe line coordinates.");
    }
    const hunk: Hunk = { header, rows: [] };
    while (oldRemaining > 0 || newRemaining > 0) {
      const raw = lines[cursor++];
      if (raw === undefined || !/^[ +\-]/.test(raw))
        throw new Error("Incomplete or malformed diff hunk.");
      // git-surgeon currently misreads these body rows as file headers.
      if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
        throw new Error(
          "This patch contains header-like code lines that jj-hunk-tool cannot parse safely.",
        );
      }
      const row: Row = { raw, hunk: hunks.length, index: hunk.rows.length + 1 };
      if (raw[0] !== "+") {
        row.oldLine = oldLine++;
        oldRemaining--;
      }
      if (raw[0] !== "-") {
        row.newLine = newLine++;
        newRemaining--;
      }
      if (oldRemaining < 0 || newRemaining < 0)
        throw new Error("Diff hunk line counts disagree.");
      hunk.rows.push(row);
    }
    hunks.push(hunk);
  }
  if (!hunks.length) throw new Error("No text hunks selected.");
  return { path, hunks };
}

/** A malformed file is quarantined without hiding valid hunks in other files. */
export type RevisionListing = Map<string, ToolHunk[] | Error>;

/**
 * Parse one non-compact, whole-revision listing. Pass ALL diff paths, including
 * unsupported files: the tool prints an unescaped path followed by optional
 * function context, so choosing a prefix (or the longest prefix) is unsafe.
 * Unknown/ambiguous paths and duplicate IDs invalidate the entire listing.
 * Other malformed entries invalidate their whole file, never just one hunk.
 */
export function parseRevisionListing(
  output: string,
  paths: Iterable<string>,
): RevisionListing {
  const known = new Set<string>();
  for (const path of paths) {
    if (!path || known.has(path))
      throw new Error("Empty or duplicate file path in source diff.");
    known.add(path);
  }
  const listing: RevisionListing = new Map();
  const ids = new Set<string>();
  let current:
    | {
        path: string;
        hunk: ToolHunk;
        additions: number;
        deletions: number;
        actualAdditions: number;
        actualDeletions: number;
      }
    | undefined;
  const fail = (message: string) => {
    if (!current) throw new Error(message);
    listing.set(current.path, new Error(message));
  };
  const finish = () => {
    if (
      current &&
      (!current.hunk.rows.length ||
        current.actualAdditions !== current.additions ||
        current.actualDeletions !== current.deletions)
    ) {
      fail("jj-hunk-tool listing line counts disagree.");
    }
  };
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const head = /^([0-9a-f]{7}(?:-\d+)?) (.*) \(\+(\d+) -(\d+)\)$/.exec(line);
    if (head) {
      finish();
      const label = head[2];
      let path: string | undefined;
      // Set lookups avoid scanning every file for every hunk. A boundary is
      // either the entire label or an ASCII space before function context.
      for (let end = label.indexOf(" "); ; end = label.indexOf(" ", end + 1)) {
        const candidate = end === -1 ? label : label.slice(0, end);
        if (known.has(candidate)) {
          if (path !== undefined)
            throw new Error("Ambiguous file in jj-hunk-tool output.");
          path = candidate;
        }
        if (end === -1) break;
      }
      if (path === undefined)
        throw new Error("Unexpected file in jj-hunk-tool output.");
      if (ids.has(head[1]))
        throw new Error("Duplicate hunk ID in tool output.");
      ids.add(head[1]);
      current = {
        path,
        hunk: { id: head[1], rows: [] },
        additions: Number(head[3]),
        deletions: Number(head[4]),
        actualAdditions: 0,
        actualDeletions: 0,
      };
      const previous = listing.get(path);
      if (!(previous instanceof Error)) {
        if (previous) previous.push(current.hunk);
        else listing.set(path, [current.hunk]);
      }
      const suffix = head[1].split("-")[1];
      if (
        suffix !== undefined &&
        (!/^[1-9]\d*$/.test(suffix) ||
          !Number.isSafeInteger(Number(suffix)) ||
          Number(suffix) < 2)
      ) {
        fail("jj-hunk-tool listing has an invalid hunk ID suffix.");
      }
      if (
        !Number.isSafeInteger(current.additions) ||
        !Number.isSafeInteger(current.deletions) ||
        current.additions + current.deletions === 0
      ) {
        fail("jj-hunk-tool listing has invalid or unsafe line counts.");
      }
      continue;
    }
    const body = /^ *(\d+):([ +\-].*)$/.exec(line);
    if (!body || !current || Number(body[1]) !== current.hunk.rows.length + 1) {
      fail("Unrecognized jj-hunk-tool output; refusing to guess hunk IDs.");
      continue;
    }
    current.hunk.rows.push(body[2]);
    if (body[2][0] === "+") current.actualAdditions++;
    if (body[2][0] === "-") current.actualDeletions++;
  }
  finish();
  return listing;
}

/** Reconcile ordered hunks and every body row; absent or quarantined files fail. */
export function reconcileListing(
  file: FileDiff,
  listing: RevisionListing,
): ToolHunk[] {
  const hunks = listing.get(file.path);
  if (hunks instanceof Error) throw hunks;
  if (
    !hunks ||
    hunks.length !== file.hunks.length ||
    hunks.some(
      (hunk, i) =>
        hunk.rows.length !== file.hunks[i].rows.length ||
        hunk.rows.some((row, j) => row !== file.hunks[i].rows[j].raw),
    )
  ) {
    throw new Error(
      "Tool hunks disagree with the source diff. This file cannot be safely selected.",
    );
  }
  return hunks;
}

/** Compatibility wrapper for callers requesting exactly one file. */
export function parseListing(output: string, path: string): ToolHunk[] {
  const hunks = parseRevisionListing(output, [path]).get(path);
  if (hunks instanceof Error) throw hunks;
  return hunks ?? [];
}

/** Compress sorted one-based patch-body row numbers into the tool's range syntax. */
export function ranges(indices: number[]): string {
  const spans: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    let end = start;
    while (indices[i + 1] === end + 1) end = indices[++i];
    spans.push(start === end ? `${start}` : `${start}-${end}`);
  }
  return spans.join(",");
}

interface PreviewHunk {
  oldHeader: string | undefined;
  newHeader: string | undefined;
  oldStart: number;
  newStart: number;
  rows: string[];
}

/**
 * Match the packaged tool's outer-context normalization, not arbitrary context
 * removal: retain min(3, leading, trailing) rows on EACH side. Symmetry avoids
 * GNU patch treating a shorter side as a false BOF/EOF hint. Zero context is
 * allowed only when the selected body already has no context on one side.
 * Internal context (including unselected deletions) is never removed.
 */
function normalizePreviewContext(
  hunk: PreviewHunk,
  originalHeader: string,
): PreviewHunk {
  const first = hunk.rows.findIndex((row) => row[0] !== " ");
  const last = hunk.rows.findLastIndex((row) => row[0] !== " ");
  if (first === -1)
    throw new Error("Tool preview contains no selected changes.");
  const context = Math.min(3, first, hunk.rows.length - last - 1);
  const leading = first - context;
  const rows = hunk.rows.slice(leading, last + 1 + context);
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
    originalHeader,
  )!;
  // A zero-count range is anchored BEFORE the insertion, not at its first
  // line. The original counts matter when a partial deletion revives context
  // on a formerly empty side, or trimming removes the last context rows.
  const start = (coordinate: number, originalCount: number, count: number) =>
    coordinate + Number(originalCount === 0) + leading - Number(count === 0);
  return {
    ...hunk,
    oldStart: start(
      hunk.oldStart,
      Number(header[2] ?? 1),
      rows.filter((row) => row[0] !== "+").length,
    ),
    newStart: start(
      hunk.newStart,
      Number(header[4] ?? 1),
      rows.filter((row) => row[0] !== "-").length,
    ),
    rows,
  };
}

/** Exact changes and locations, allowing only the packaged tool's context trim. */
export function assertExactPreview(
  preview: string,
  selected: Array<{ patch: string; path: string; hunk: Hunk; lines: number[] }>,
): void {
  const expected = selected.map(({ patch, hunk, lines }) => {
    const chosen = new Set(lines);
    const rows = hunk.rows.flatMap((row) =>
      row.raw[0] === "+" && !chosen.has(row.index)
        ? []
        : [
            row.raw[0] === "-" && !chosen.has(row.index)
              ? ` ${row.raw.slice(1)}`
              : row.raw,
          ],
    );
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header)!;
    const legacy = {
      oldHeader: patch.match(/^--- .*$/m)?.[0],
      newHeader: patch.match(/^\+\+\+ .*$/m)?.[0],
      oldStart: Number(header[1]),
      newStart: Number(header[2]),
      rows,
    };
    // The service uses a bare hunk ID when all changes are selected; the
    // packaged tool normalizes only explicit partial row selections.
    const wholeHunk =
      lines.length === hunk.rows.filter((row) => row.raw[0] !== " ").length;
    return {
      legacy,
      normalized: wholeHunk
        ? legacy
        : normalizePreviewContext(legacy, hunk.header),
    };
  });
  const sections = preview.split(/(?=^--- )/m).filter(Boolean);
  const actual = sections.map((section) => {
    const old = /^--- .*$/m.exec(section)?.[0];
    const next = /^\+\+\+ .*$/m.exec(section)?.[0];
    const name = next === "+++ /dev/null" ? old?.slice(6) : next?.slice(6);
    if (!name) throw new Error("Malformed tool preview file headers.");
    const file = parseFile(section, name);
    if (file.hunks.length !== 1)
      throw new Error("Unexpected hunk grouping in tool preview.");
    const hunk = file.hunks[0];
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header)!;
    return {
      oldHeader: old,
      newHeader: next,
      oldStart: Number(header[1]),
      newStart: Number(header[2]),
      rows: hunk.rows.map((row) => row.raw),
    };
  });
  // parseFile has verified every actual header count. Compare the whole body
  // and both coordinates, rather than stripping context from actual output:
  // canonicalizing it would hide altered or missing matching context. Keep the
  // exact legacy form for non-Nix installations of the unpatched pinned tool.
  if (
    actual.length !== expected.length ||
    actual.some((hunk, index) => {
      const serialized = JSON.stringify(hunk);
      return (
        serialized !== JSON.stringify(expected[index].legacy) &&
        serialized !== JSON.stringify(expected[index].normalized)
      );
    })
  ) {
    throw new Error(
      "Tool preview differs from the exact selected rows or their locations; nothing was squashed.",
    );
  }
}
