/** Parse pinned jj diffs into exact, one-based patch-body rows. */
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
/** Initial native-editor scope: regular, newline-terminated UTF-8 text only. */
function assertSupported(patch: string): void {
  if (
    /^(?:rename (?:from|to)|copy (?:from|to)|(?:old|new) mode|similarity index|dissimilarity index) /m.test(
      patch,
    )
  ) {
    throw new Error(
      "Renames, copies, and mode changes are not supported by the native diff editor.",
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
      "Files without a final newline are not supported safely by the native diff editor. Add a newline and refresh first.",
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
      hunk.rows.push(row);
    }
    hunks.push(hunk);
  }
  if (!hunks.length) throw new Error("No text hunks selected.");
  return { path, hunks };
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
