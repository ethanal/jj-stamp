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

/** Parse non-compact listing output, preserving suffixes assigned to duplicate IDs. */
export function parseListing(output: string, path: string): ToolHunk[] {
  const hunks: ToolHunk[] = [];
  let expected: { additions: number; deletions: number } | null = null;
  const checkCounts = () => {
    const hunk = hunks.at(-1);
    if (
      expected &&
      hunk &&
      (hunk.rows.filter((row) => row[0] === "+").length !==
        expected.additions ||
        hunk.rows.filter((row) => row[0] === "-").length !== expected.deletions)
    ) {
      throw new Error("jj-hunk-tool listing line counts disagree.");
    }
  };
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const head = /^([0-9a-f]{7}(?:-\d+)?) (.*) \(\+(\d+) -(\d+)\)$/.exec(line);
    if (head) {
      checkCounts();
      expected = { additions: Number(head[3]), deletions: Number(head[4]) };
      if (head[2] !== path && !head[2].startsWith(path + " "))
        throw new Error("Unexpected file in jj-hunk-tool output.");
      if (hunks.some((hunk) => hunk.id === head[1]))
        throw new Error("Duplicate hunk ID in tool output.");
      hunks.push({ id: head[1], rows: [] });
      continue;
    }
    const body = /^\s*(\d+):([ +\-].*)$/.exec(line);
    const hunk = hunks.at(-1);
    if (!body || !hunk || Number(body[1]) !== hunk.rows.length + 1) {
      throw new Error(
        "Unrecognized jj-hunk-tool output; refusing to guess hunk IDs.",
      );
    }
    hunk.rows.push(body[2]);
  }
  checkCounts();
  return hunks;
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

/** Exact reconciliation of file identity, hunk location, and every patch-body row. */
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
    return [
      patch.match(/^--- .*$/m)?.[0],
      patch.match(/^\+\+\+ .*$/m)?.[0],
      Number(header[1]),
      Number(header[2]),
      rows,
    ];
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
    return [
      old,
      next,
      Number(header[1]),
      Number(header[2]),
      hunk.rows.map((row) => row.raw),
    ];
  });
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      "Tool preview differs from the exact selected rows or their locations; nothing was squashed.",
    );
  }
}
