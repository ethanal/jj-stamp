import { parseFile } from "./diff.ts";

export interface FileSelection {
  path: string;
  patch: string;
  /** Zero-based hunk indices and one-based patch-body row numbers. */
  selections: Array<{ hunk: number; lines: number[] }>;
}

function textLines(bytes: Buffer | null, side: string): string[] {
  if (bytes === null) return [];
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes))
    throw new Error(`${side} is not lossless UTF-8 text.`);
  if (text.includes("\0"))
    throw new Error(`${side} contains binary NUL bytes.`);
  if (text !== "" && !text.endsWith("\n"))
    throw new Error(
      `${side} has no final newline; this format is unsupported.`,
    );
  // Split on LF only: the CR in a CRLF line is part of its exact content.
  return text === "" ? [] : text.slice(0, -1).split("\n");
}

function encode(lines: string[]): Buffer {
  return Buffer.from(lines.length ? `${lines.join("\n")}\n` : "", "utf8");
}

/**
 * Validate the entire pinned patch, then materialize only the selected edits.
 * All addressing is by exact coordinates; neither preview nor context searching
 * participates in applying edits. Inputs are never modified.
 */
export function materializeSelection(
  input: FileSelection,
  base: Buffer | null,
  source: Buffer | null,
): { result: Buffer | null; preview: string } {
  if (Buffer.from(input.patch, "utf8").toString("utf8") !== input.patch)
    throw new Error("Patch is not lossless UTF-8 text.");
  const file = parseFile(input.patch, input.path);
  const baseLines = textLines(base, "Base file");
  const sourceLines = textLines(source, "Source file");
  const headerLines = input.patch.split("\n").slice(
    0,
    input.patch.split("\n").findIndex((line) => line.startsWith("@@ ")),
  );
  const oldHeaders = headerLines.filter((line) => line.startsWith("--- "));
  const newHeaders = headerLines.filter((line) => line.startsWith("+++ "));
  if (
    oldHeaders.length !== 1 ||
    newHeaders.length !== 1 ||
    (oldHeaders[0] === "--- /dev/null") !== (base === null) ||
    (newHeaders[0] === "+++ /dev/null") !== (source === null) ||
    (base === null && source === null) ||
    (headerLines.some((line) => line.startsWith("new file mode ")) &&
      base !== null) ||
    (headerLines.some((line) => line.startsWith("deleted file mode ")) &&
      source !== null)
  ) {
    throw new Error("Patch headers disagree with pinned file existence.");
  }

  // Check ALL hunks before interpreting selections, including unselected hunks
  // and unchanged gaps/tails. This also validates the new-side coordinates.
  let oldCursor = 0;
  const reconstructed: string[] = [];
  const locations: number[] = [];
  let changeCount = 0;
  for (const hunk of file.hunks) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
      hunk.header,
    )!;
    const oldCount = Number(header[2] ?? 1);
    const newCount = Number(header[4] ?? 1);
    // Zero-count ranges name the preceding line, not a one-based first line.
    const oldStart = Number(header[1]) - Number(oldCount !== 0);
    const newStart = Number(header[3]) - Number(newCount !== 0);
    if (
      oldStart < oldCursor ||
      oldStart + oldCount > baseLines.length ||
      newStart + newCount > sourceLines.length
    ) {
      throw new Error(
        "Patch has overlapping, out-of-order, or out-of-bounds coordinates.",
      );
    }
    for (; oldCursor < oldStart; oldCursor++)
      reconstructed.push(baseLines[oldCursor]);
    if (newStart !== reconstructed.length)
      throw new Error(
        "Patch new-side coordinates disagree with the pinned base.",
      );
    locations.push(oldStart);
    let hunkChanges = 0;
    for (const row of hunk.rows) {
      const kind = row.raw[0];
      const content = row.raw.slice(1);
      if (kind !== "+" && baseLines[oldCursor++] !== content)
        throw new Error(
          "Patch row does not match the pinned base at its exact coordinate.",
        );
      if (kind !== "-") reconstructed.push(content);
      if (kind !== " ") hunkChanges++;
    }
    if (hunkChanges === 0) throw new Error("Patch hunk contains no changes.");
    changeCount += hunkChanges;
  }
  for (; oldCursor < baseLines.length; oldCursor++)
    reconstructed.push(baseLines[oldCursor]);
  if (!encode(reconstructed).equals(source ?? Buffer.alloc(0)))
    throw new Error(
      "Complete patch does not reconstruct the pinned source byte-for-byte.",
    );

  const selected = new Map<number, Set<number>>();
  let selectedCount = 0;
  for (const selection of input.selections) {
    if (
      !Number.isSafeInteger(selection.hunk) ||
      selection.hunk < 0 ||
      selection.hunk >= file.hunks.length ||
      selected.has(selection.hunk)
    ) {
      throw new Error("Invalid or duplicate selected hunk index.");
    }
    const rows = file.hunks[selection.hunk].rows;
    const chosen = new Set<number>();
    for (const line of selection.lines) {
      if (
        !Number.isSafeInteger(line) ||
        line < 1 ||
        line > rows.length ||
        rows[line - 1].raw[0] === " " ||
        chosen.has(line)
      ) {
        throw new Error(
          "Invalid, duplicate, or unchanged selected patch-body row.",
        );
      }
      chosen.add(line);
      selectedCount++;
    }
    selected.set(selection.hunk, chosen);
  }

  const output: string[] = [];
  const previewHunks: string[] = [];
  oldCursor = 0;
  for (const [index, hunk] of file.hunks.entries()) {
    const oldStart = locations[index];
    for (; oldCursor < oldStart; oldCursor++) output.push(baseLines[oldCursor]);
    const newStart = output.length;
    const chosen = selected.get(index);
    const previewRows: string[] = [];
    for (const row of hunk.rows) {
      const kind = row.raw[0];
      const content = row.raw.slice(1);
      const picked = chosen?.has(row.index) ?? false;
      if (kind !== "+") oldCursor++;
      if (kind === "+" && !picked) continue;
      if (kind !== "-" || !picked) output.push(content);
      previewRows.push(kind === "-" && !picked ? ` ${content}` : row.raw);
    }
    if (chosen?.size) {
      const oldCount = oldCursor - oldStart;
      const newCount = output.length - newStart;
      previewHunks.push(
        `@@ -${oldStart + Number(oldCount !== 0)},${oldCount} +${newStart + Number(newCount !== 0)},${newCount} @@\n${previewRows.join("\n")}\n`,
      );
    }
  }
  for (; oldCursor < baseLines.length; oldCursor++)
    output.push(baseLines[oldCursor]);
  // Empty contents do not imply absence: selecting only the minus half of a
  // replacement must leave an empty regular file. Only complete file deletion
  // removes it. Selecting nothing on a new file leaves the absent base alone.
  const result =
    (source === null && selectedCount === changeCount) ||
    (base === null && selectedCount === 0)
      ? null
      : encode(output);
  if (!previewHunks.length) return { result, preview: "" };
  const mode =
    base === null
      ? "new file mode 100644\n"
      : result === null
        ? "deleted file mode 100644\n"
        : "";
  const preview =
    `diff --git a/${input.path} b/${input.path}\n${mode}` +
    `--- ${base === null ? "/dev/null" : `a/${input.path}`}\n` +
    `+++ ${result === null ? "/dev/null" : `b/${input.path}`}\n` +
    previewHunks.join("");
  return { result, preview };
}
