import type { GetLineIndexUtility, SelectedLineRange } from "@pierre/diffs";
import type { Hunk, Selections } from "./types";

/** Use the renderer's unified row coordinates, including expanded context.
 * Only original changed patch rows are translated into jj-hunk-tool indices.
 */
export function selectionFromRange(
  hunks: Hunk[],
  range: SelectedLineRange,
  getIndex: GetLineIndexUtility,
): Selections {
  const start = getIndex(range.start, range.side ?? "additions")?.[0];
  const end = getIndex(
    range.end,
    range.endSide ?? range.side ?? "additions",
  )?.[0];
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
        const index = getIndex(line, deletion ? "deletions" : "additions")?.[0];
        return index !== undefined && index >= low && index <= high;
      })
      .map((row) => row.index);
    if (lines.length) selections[hunk.id] = lines;
  }
  return selections;
}
