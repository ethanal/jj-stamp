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
