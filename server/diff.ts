/** Parse pinned jj diffs into exact, one-based patch-body rows. */
export interface Row {
  raw: string;
  /** The row's file line has no LF terminator; the marker is not a row. */
  noNewline?: boolean;
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
  /** Validated rename source; path is always the destination. */
  oldPath?: string;
  hunks: Hunk[];
}
/** Native-editor scope: regular UTF-8 text only. */
function assertSupported(patch: string): void {
  if (
    /^(?:copy (?:from|to)|(?:old|new) mode|dissimilarity index) /m.test(patch)
  ) {
    throw new Error(
      "Copies and mode changes are not supported by the native diff editor.",
    );
  }
  if (/^(?:new|deleted) file mode (?!100644$)/m.test(patch)) {
    throw new Error("Only regular, non-executable text files are supported.");
  }
  if (/^index [0-9a-f]+\.\.[0-9a-f]+ (?!100644$)\d+/m.test(patch)) {
    throw new Error("Only regular, non-executable text files are supported.");
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
      "Whitespace, quoted, or control-character file paths are not supported safely by the native diff editor.",
    );
  }
  const relative = value.slice(prefix.length);
  if (
    relative.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Patch paths must be canonical and repository-relative.");
  return relative;
}

/** Validate the complete envelope, especially all independent rename path claims. */
function readEnvelope(lines: string[], path: string) {
  let oldPath: string | null | undefined;
  let newPath: string | null | undefined;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let gitPaths: [string, string] | undefined;
  let similarity: number | undefined;
  let index: string | undefined;
  let fileMode = false;
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!match || gitPaths)
        throw new Error("Malformed or duplicate Git file header.");
      gitPaths = [
        readPath(`--- a/${match[1]}`, "a/")!,
        readPath(`+++ b/${match[2]}`, "b/")!,
      ];
    } else if (line.startsWith("--- ")) {
      if (oldPath !== undefined)
        throw new Error(
          "Duplicate old file header makes file existence ambiguous.",
        );
      oldPath = readPath(line, "a/");
    } else if (line.startsWith("+++ ")) {
      if (newPath !== undefined)
        throw new Error(
          "Duplicate new file header makes file existence ambiguous.",
        );
      newPath = readPath(line, "b/");
    } else if (line.startsWith("rename from ")) {
      if (renameFrom !== undefined) throw new Error("Duplicate rename source.");
      renameFrom = readPath(`--- a/${line.slice(12)}`, "a/")!;
    } else if (line.startsWith("rename to ")) {
      if (renameTo !== undefined)
        throw new Error("Duplicate rename destination.");
      renameTo = readPath(`+++ b/${line.slice(10)}`, "b/")!;
    } else if (/^similarity index (?:100|[1-9]?\d)%$/.test(line)) {
      if (similarity !== undefined)
        throw new Error("Duplicate rename similarity.");
      similarity = Number(line.slice(17, -1));
    } else if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: 100644)?$/.test(line)) {
      if (index !== undefined) throw new Error("Duplicate file index.");
      index = line.split(" ")[1];
    } else if (/^(?:new|deleted) file mode 100644$/.test(line)) {
      if (fileMode) throw new Error("Duplicate file mode.");
      fileMode = true;
    } else {
      throw new Error("Malformed or unsupported patch metadata.");
    }
  }
  const renamed = renameFrom !== undefined || renameTo !== undefined;
  if (renamed) {
    if (
      renameFrom === undefined ||
      renameTo === undefined ||
      renameFrom === renameTo ||
      renameTo !== path ||
      !gitPaths ||
      gitPaths[0] !== renameFrom ||
      gitPaths[1] !== renameTo ||
      fileMode ||
      ((oldPath !== undefined || newPath !== undefined) &&
        (oldPath !== renameFrom || newPath !== renameTo))
    )
      throw new Error("Rename metadata and file headers do not match.");
  } else if (
    similarity !== undefined ||
    (gitPaths && (gitPaths[0] !== path || gitPaths[1] !== path))
  ) {
    throw new Error("Patch Git headers require matching rename metadata.");
  }
  return {
    oldPath,
    newPath,
    renameFrom,
    contentChanged:
      (similarity !== undefined && similarity !== 100) ||
      (index !== undefined && index.split("..")[0] !== index.split("..")[1]),
  };
}

/** Parse one file, checking hunk counts so malformed output can never select other rows. */
export function parseFile(patch: string, path: string): FileDiff {
  assertSupported(patch);
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const hunks: Hunk[] = [];

  let oldEOF: number | undefined;
  let newEOF: number | undefined;
  let cursor = 0;
  for (; cursor < lines.length && !lines[cursor].startsWith("@@ "); cursor++) {
    if (lines[cursor].startsWith("\\"))
      throw new Error("Misplaced or malformed no-newline marker.");
  }
  const { oldPath, newPath, renameFrom, contentChanged } = readEnvelope(
    lines.slice(0, cursor),
    path,
  );
  // jj emits just diff/rename headers for an unchanged move (no ---/+++).
  if (
    renameFrom !== undefined &&
    oldPath === undefined &&
    newPath === undefined &&
    cursor === lines.length
  ) {
    if (contentChanged)
      throw new Error(
        "A modified rename requires complete text file headers and hunks.",
      );
    return { path, oldPath: renameFrom, hunks };
  }
  if (
    oldPath === undefined ||
    newPath === undefined ||
    (newPath ?? oldPath) !== path
  ) {
    throw new Error("Patch file headers do not match the selected file.");
  }
  if (
    oldPath !== null &&
    newPath !== null &&
    oldPath !== newPath &&
    renameFrom === undefined
  ) {
    throw new Error("Renamed file headers require matching rename metadata.");
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
    if (
      (oldEOF !== undefined && (oldRemaining > 0 || oldLine > oldEOF)) ||
      (newEOF !== undefined && (newRemaining > 0 || newLine > newEOF))
    ) {
      throw new Error("Diff hunk continues beyond a no-newline EOF marker.");
    }
    const hunk: Hunk = { header, rows: [] };
    while (oldRemaining > 0 || newRemaining > 0) {
      const raw = lines[cursor++];
      if (raw === undefined || !/^[ +\-]/.test(raw))
        throw new Error("Incomplete or malformed diff hunk.");
      // Keep the existing conservative format boundary for this experiment.
      if (raw.startsWith("--- ") || raw.startsWith("+++ ")) {
        throw new Error(
          "This patch contains header-like code lines that the native diff editor cannot parse safely.",
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
      if (lines[cursor]?.startsWith("\\")) {
        if (
          lines[cursor] !== "\\ No newline at end of file" ||
          raw.length === 1 ||
          (raw[0] !== "+" && oldRemaining !== 0) ||
          (raw[0] !== "-" && newRemaining !== 0)
        ) {
          throw new Error("Misplaced or malformed no-newline EOF marker.");
        }
        cursor++;
        row.noNewline = true;
        if (raw[0] !== "+") oldEOF = row.oldLine;
        if (raw[0] !== "-") newEOF = row.newLine;
      }
      hunk.rows.push(row);
    }
    hunks.push(hunk);
  }
  if (!hunks.length) throw new Error("No text hunks selected.");
  return {
    path,
    ...(renameFrom === undefined ? {} : { oldPath: renameFrom }),
    hunks,
  };
}

/** Compress sorted one-based patch-body row numbers for compact preview selection labels. */
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
