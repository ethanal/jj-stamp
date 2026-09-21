import type { GetLineIndexUtility, SelectedLineRange } from "@pierre/diffs";
import type { Hunk, Selections } from "./types";

/** Use the renderer's row coordinates, including expanded context and split sides.
 * Split ranges span both columns; stacked ranges retain individual +/- rows.
 * Only original changed patch rows are translated into jj-hunk-tool indices.
 */
export function selectionFromRange(
  hunks: Hunk[],
  range: SelectedLineRange,
  getIndex: GetLineIndexUtility,
  style: "unified" | "split" = "unified",
): Selections {
  const axis = style === "split" ? 1 : 0;
  const side = range.side ?? "additions";
  const endSide = range.endSide ?? side;
  const start = getIndex(range.start, side)?.[axis];
  const end = getIndex(range.end, endSide)?.[axis];
  if (start === undefined || end === undefined) return {};
  const low = Math.min(start, end),
    high = Math.max(start, end);
  const selections: Selections = {};
  for (const hunk of hunks) {
    const lines = hunk.rows
      .filter((row) => {
        const deletion = row.raw[0] === "-";
        if (!deletion && row.raw[0] !== "+") return false;
        const line = deletion ? row.oldLine : row.newLine;
        if (line === undefined) return false;
        const index = getIndex(line, deletion ? "deletions" : "additions")?.[
          axis
        ];
        return index !== undefined && index >= low && index <= high;
      })
      .map((row) => row.index);
    if (lines.length) selections[hunk.id] = lines;
  }
  return selections;
}

export interface LinePoint {
  line: number;
  side: "additions" | "deletions";
}

/** The controlled range is also the anchor: clearing it cannot leave a stale
 * Shift anchor behind. An ordinary click/drag always starts a fresh range. */
export function selectionAnchor(
  point: LinePoint,
  extend: boolean,
  range: SelectedLineRange | null,
): LinePoint {
  return extend && range
    ? { line: range.start, side: range.side ?? "additions" }
    : point;
}

/** Editor coordinates refer to the working tree, never the old diff side.
 * Pair replacement rows by offset; pure deletions use the next surviving row
 * (or the preceding row at EOF). Expanded old-side context uses hunk offsets. */
export function workingTreeLine(hunks: Hunk[], point: LinePoint): number {
  if (point.side === "additions") return point.line;
  let offset = 0;
  for (const hunk of hunks) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
      hunk.header,
    );
    if (!header) continue;
    const oldStart = Number(header[1]);
    const oldCount = Number(header[2] ?? 1);
    const newStart = Number(header[3]);
    const newCount = Number(header[4] ?? 1);
    if (point.line < oldStart || (oldCount === 0 && point.line === oldStart))
      break;
    const index = hunk.rows.findIndex((row) => row.oldLine === point.line);
    if (index !== -1) {
      const row = hunk.rows[index];
      if (row.newLine !== undefined) return row.newLine;
      let first = index,
        last = index;
      while (first > 0 && /^[+-]/.test(hunk.rows[first - 1].raw)) first--;
      while (
        last + 1 < hunk.rows.length &&
        /^[+-]/.test(hunk.rows[last + 1].raw)
      )
        last++;
      const block = hunk.rows.slice(first, last + 1);
      const replacements = block.filter((row) => row.newLine !== undefined);
      if (replacements.length) {
        const deletedOffset = hunk.rows
          .slice(first, index)
          .filter((row) => row.raw.startsWith("-")).length;
        return replacements[Math.min(deletedOffset, replacements.length - 1)]
          .newLine!;
      }
      const after = hunk.rows
        .slice(last + 1)
        .find((row) => row.newLine !== undefined);
      const before = hunk.rows
        .slice(0, first)
        .reverse()
        .find((row) => row.newLine !== undefined);
      return Math.max(1, after?.newLine ?? before?.newLine ?? newStart);
    }
    // A zero-length hunk range names the preceding line, not a first row.
    offset =
      newStart + Math.max(1, newCount) - (oldStart + Math.max(1, oldCount));
  }
  return Math.max(1, point.line + offset);
}
