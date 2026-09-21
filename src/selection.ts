import type { SelectedLineRange } from "@pierre/diffs";
import type { Hunk, Row } from "./types";
export const changed = (hunk: Hunk) =>
  hunk.rows.filter((row) => row.raw[0] === "+" || row.raw[0] === "-");
const address = (row: Row) =>
  row.raw[0] === "-"
    ? { line: row.oldLine!, side: "deletions" as const }
    : { line: row.newLine!, side: "additions" as const };
export function rangeForRows(
  hunk: Hunk,
  lines: number[],
): SelectedLineRange | null {
  const rows = hunk.rows.filter((row) => lines.includes(row.index));
  if (!rows.length) return null;
  const start = address(rows[0]),
    end = address(rows.at(-1)!);
  return {
    start: start.line,
    side: start.side,
    end: end.line,
    endSide: end.side,
  };
}
/** Align each +/- block into paired display rows, just as split diffs do. */
function splitPositions(rows: Row[]): Map<number, number> {
  const positions = new Map<number, number>();
  let pos = 0;
  for (let i = 0; i < rows.length;) {
    if (rows[i].raw[0] === " ") {
      positions.set(rows[i++].index, pos++);
      continue;
    }
    const removed: Row[] = [],
      added: Row[] = [];
    while (i < rows.length && rows[i].raw[0] !== " ") {
      (rows[i].raw[0] === "-" ? removed : added).push(rows[i++]);
    }
    removed.forEach((row, j) => positions.set(row.index, pos + j));
    added.forEach((row, j) => positions.set(row.index, pos + j));
    pos += Math.max(removed.length, added.length);
  }
  return positions;
}
export function rowsForRange(
  hunk: Hunk,
  range: SelectedLineRange,
  style: "unified" | "split",
): number[] {
  const side = range.side ?? "additions",
    endSide = range.endSide ?? side;
  const first = hunk.rows.find(
    (row) => (side === "deletions" ? row.oldLine : row.newLine) === range.start,
  );
  const last = hunk.rows.find(
    (row) =>
      (endSide === "deletions" ? row.oldLine : row.newLine) === range.end,
  );
  if (!first || !last) return [];
  const positions =
    style === "split"
      ? splitPositions(hunk.rows)
      : new Map(hunk.rows.map((row) => [row.index, row.index]));
  const a = positions.get(first.index)!,
    b = positions.get(last.index)!;
  return changed(hunk)
    .filter(
      (row) =>
        positions.get(row.index)! >= Math.min(a, b) &&
        positions.get(row.index)! <= Math.max(a, b),
    )
    .map((row) => row.index);
}
