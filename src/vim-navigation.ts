import type { GetLineIndexUtility } from "@pierre/diffs";
import type { LinePoint } from "./selection";
import type { Hunk } from "./types";

export interface VimLine extends LinePoint {
  index: number;
}

export function vimLines(
  hunks: Hunk[],
  getIndex: GetLineIndexUtility,
  style: "unified" | "split",
  rendered: readonly LinePoint[] = [],
): VimLine[] {
  const axis = style === "split" ? 1 : 0;
  const lines: VimLine[] = [];
  const seen = new Set<string>();

  const add = (line: number | undefined, side: LinePoint["side"]) => {
    if (line === undefined) return;
    const key = `${side}:${line}`;
    if (seen.has(key)) return;
    const index = getIndex(line, side)?.[axis];
    if (index === undefined || !Number.isFinite(index)) return;
    seen.add(key);
    lines.push({ line, side, index });
  };

  for (const hunk of hunks) {
    for (const row of hunk.rows) {
      if (row.raw[0] === "-") add(row.oldLine, "deletions");
      else if (row.raw[0] === "+") add(row.newLine, "additions");
      else if (row.raw[0] === " ") {
        if (style === "split") add(row.oldLine, "deletions");
        add(row.newLine, "additions");
      }
    }
  }
  for (const point of rendered) add(point.line, point.side);

  return lines.sort(
    (left, right) =>
      left.index - right.index ||
      (left.side === right.side ? 0 : left.side === "deletions" ? -1 : 1),
  );
}

export function moveVimLine(
  lines: readonly VimLine[],
  cursor: LinePoint | null,
  key: "h" | "j" | "k" | "l",
  style: "unified" | "split",
): VimLine | null {
  if (!lines.length) return null;

  const current = cursor
    ? lines.find(
        (line) => line.line === cursor.line && line.side === cursor.side,
      )
    : undefined;
  if (!current) {
    const firstIndex = lines[0].index;
    return (
      lines.find(
        (line) => line.index === firstIndex && line.side === "additions",
      ) ?? lines[0]
    );
  }

  if (key === "h" || key === "l") {
    if (style === "unified") return current;
    const side = key === "h" ? "deletions" : "additions";
    return (
      lines.find(
        (line) => line.index === current.index && line.side === side,
      ) ?? current
    );
  }

  const indexes = [...new Set(lines.map((line) => line.index))];
  const position = indexes.indexOf(current.index);
  const targetPosition = Math.max(
    0,
    Math.min(indexes.length - 1, position + (key === "j" ? 1 : -1)),
  );
  if (targetPosition === position) return current;

  const targetIndex = indexes[targetPosition];
  return (
    lines.find(
      (line) => line.index === targetIndex && line.side === current.side,
    ) ?? lines.find((line) => line.index === targetIndex)!
  );
}
