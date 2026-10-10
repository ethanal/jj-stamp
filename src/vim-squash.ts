import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import type { RowRef } from "./optimistic";
import type { DiffFile, Row, Selections } from "./types";

type Side = "additions" | "deletions";
type Kind = "+" | "-" | " ";

type PhysicalRow = {
  row: Row;
  hunkId: string;
  hunk: number;
  kind: Kind;
  oldBoundary: number;
  newBoundary: number;
  selected: boolean;
  origin?: PhysicalRow;
  visual?: number;
};

type VisualRow = {
  rows: PhysicalRow[];
  index: number;
  additions: number;
  deletions: number;
};

const refKey = (ref: RowRef): string =>
  JSON.stringify([ref.path, ref.kind, ref.line, ref.text]);

function rowKey(path: string, row: Row): string | null {
  const kind = row.raw[0];
  if (kind !== "+" && kind !== "-") return null;
  const line = kind === "+" ? row.newLine : row.oldLine;
  if (line === undefined) return null;
  return JSON.stringify([path, kind, line, row.raw.slice(1)]);
}

function hunkStart(header: string): {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
} | null {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newCount: Number(match[4] ?? 1),
  };
}

function physicalRows(file: DiffFile, selected: Set<string>): PhysicalRow[] {
  const result: PhysicalRow[] = [];
  for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex++) {
    const hunk = file.hunks[hunkIndex];
    const start = hunkStart(hunk.header);
    let oldCursor = start
      ? start.oldStart + (start.oldCount === 0 ? 1 : 0)
      : (hunk.rows.find((row) => row.oldLine !== undefined)?.oldLine ?? 1);
    let newCursor = start
      ? start.newStart + (start.newCount === 0 ? 1 : 0)
      : (hunk.rows.find((row) => row.newLine !== undefined)?.newLine ?? 1);
    for (const row of hunk.rows) {
      const kind = row.raw[0];
      if (kind !== " " && kind !== "+" && kind !== "-") continue;
      const physical: PhysicalRow = {
        row,
        hunkId: hunk.id,
        hunk: hunkIndex,
        kind,
        oldBoundary: row.oldLine ?? oldCursor,
        newBoundary: row.newLine ?? newCursor,
        selected: selected.has(rowKey(file.path, row) ?? ""),
      };
      result.push(physical);
      if (row.oldLine !== undefined) oldCursor = row.oldLine + 1;
      if (row.newLine !== undefined) newCursor = row.newLine + 1;
    }
  }
  return result;
}

function visualRows(
  file: DiffFile,
  physical: readonly PhysicalRow[],
  style: "unified" | "split",
): VisualRow[] {
  const result: VisualRow[] = [];
  const push = (rows: PhysicalRow[]) => {
    const visual: VisualRow = {
      rows,
      index: result.length,
      additions:
        rows.find((entry) => entry.row.newLine !== undefined)?.newBoundary ??
        rows[0].newBoundary,
      deletions:
        rows.find((entry) => entry.row.oldLine !== undefined)?.oldBoundary ??
        rows[0].oldBoundary,
    };
    for (const row of rows) row.visual = visual.index;
    result.push(visual);
  };

  if (style === "unified") {
    for (const row of physical) push([row]);
    return result;
  }

  // The public patch parser supplies the same similarity-aligned content
  // groups consumed by the renderer, without constructing a renderer.
  try {
    const parsed = parsePatchFiles(file.patch, undefined, true)[0]?.files[0];
    if (parsed?.hunks.length === file.hunks.length) {
      const indexed = new Map<string, PhysicalRow>();
      for (const row of physical) {
        if (row.row.oldLine !== undefined)
          indexed.set(`${row.hunk}:deletions:${row.row.oldLine}`, row);
        if (row.row.newLine !== undefined)
          indexed.set(`${row.hunk}:additions:${row.row.newLine}`, row);
      }
      for (let hunkIndex = 0; hunkIndex < parsed.hunks.length; hunkIndex++) {
        const hunk = parsed.hunks[hunkIndex];
        for (const content of hunk.hunkContent) {
          if (content.type === "context") {
            for (let offset = 0; offset < content.lines; offset++) {
              const line =
                hunk.additionStart +
                content.additionLineIndex -
                hunk.additionLineIndex +
                offset;
              const row = indexed.get(`${hunkIndex}:additions:${line}`);
              if (!row) throw new Error("Patch metadata does not match rows.");
              push([row]);
            }
            continue;
          }
          for (
            let offset = 0;
            offset < Math.max(content.deletions, content.additions);
            offset++
          ) {
            const rows: PhysicalRow[] = [];
            if (offset < content.deletions) {
              const line =
                hunk.deletionStart +
                content.deletionLineIndex -
                hunk.deletionLineIndex +
                offset;
              const row = indexed.get(`${hunkIndex}:deletions:${line}`);
              if (!row) throw new Error("Patch metadata does not match rows.");
              rows.push(row);
            }
            if (offset < content.additions) {
              const line =
                hunk.additionStart +
                content.additionLineIndex -
                hunk.additionLineIndex +
                offset;
              const row = indexed.get(`${hunkIndex}:additions:${line}`);
              if (!row) throw new Error("Patch metadata does not match rows.");
              rows.push(row);
            }
            push(rows);
          }
        }
      }
      if (new Set(result.flatMap((row) => row.rows)).size === physical.length)
        return result;
      result.length = 0;
    }
  } catch {
    // A split selection must agree with renderer metadata exactly. Real
    // DiffFiles have parseable patches; malformed or mismatched inputs fail
    // closed rather than approximating pairings and selecting the wrong row.
  }
  return [];
}

function points(row: VisualRow, style: "unified" | "split") {
  const result: { line: number; side: Side }[] = [];
  const seen = new Set<string>();
  const add = (line: number | undefined, side: Side) => {
    if (line === undefined) return;
    const key = `${side}:${line}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ line, side });
  };
  for (const physical of row.rows) {
    if (physical.kind === "-") add(physical.row.oldLine, "deletions");
    else if (physical.kind === "+") add(physical.row.newLine, "additions");
    else if (style === "split") {
      add(physical.row.oldLine, "deletions");
      add(physical.row.newLine, "additions");
    } else add(physical.row.newLine, "additions");
  }
  return result;
}

/** Return the displayed row containing a renderer coordinate. Expanded context
 * is not present in the patch, so place it by its old/new file coordinate. */
function position(
  rows: readonly VisualRow[],
  line: number,
  side: Side,
  style: "unified" | "split",
): number {
  for (const row of rows)
    if (
      points(row, style).some(
        (point) => point.line === line && point.side === side,
      )
    )
      return row.index;
  let result = -1;
  for (const row of rows)
    if (row[side] <= line) result = Math.max(result, row.index);
  return result;
}

function attachOrigins(
  before: readonly PhysicalRow[],
  after: readonly PhysicalRow[],
): void {
  const byNew = new Map<number, PhysicalRow[]>();
  const byProjectedOld = new Map<number, PhysicalRow[]>();
  let delta = 0;
  for (const row of before) {
    if (row.row.newLine !== undefined) {
      const matches = byNew.get(row.row.newLine) ?? [];
      matches.push(row);
      byNew.set(row.row.newLine, matches);
    }
    if (row.row.oldLine !== undefined && !(row.kind === "-" && row.selected)) {
      const line = row.row.oldLine + delta;
      const matches = byProjectedOld.get(line) ?? [];
      matches.push(row);
      byProjectedOld.set(line, matches);
    }
    if (row.selected) delta += row.kind === "+" ? 1 : -1;
  }

  for (const row of after) {
    const text = row.row.raw.slice(1);
    const candidates =
      row.kind === "-"
        ? byProjectedOld.get(row.row.oldLine!)
        : byNew.get(row.row.newLine!);
    row.origin = candidates?.find((candidate) => {
      if (candidate.row.raw.slice(1) !== text) return false;
      if (row.kind === "+") return candidate.kind === "+";
      if (row.kind === "-") return candidate.kind === "-";
      return (
        candidate.kind === " " || (candidate.kind === "+" && candidate.selected)
      );
    });
  }
}

function rangeFor(
  row: VisualRow,
  style: "unified" | "split",
): SelectedLineRange {
  const rowPoints = points(row, style);
  const deletion = rowPoints.find((point) => point.side === "deletions");
  const addition = rowPoints.find((point) => point.side === "additions");
  const start = style === "split" ? (deletion ?? addition)! : rowPoints[0];
  const end = style === "split" ? (addition ?? deletion)! : start;
  return {
    start: start.line,
    side: start.side,
    end: end.line,
    endSide: end.side,
  };
}

function selectionsFor(row: VisualRow): Selections {
  const selections: Selections = {};
  for (const physical of row.rows) {
    if (physical.kind !== "+" && physical.kind !== "-") continue;
    (selections[physical.hunkId] ??= []).push(physical.row.index);
  }
  return selections;
}

/**
 * Advance a Vim visual selection after its changed rows have been projected
 * into the parent. The target is one displayed visual row below the lower end
 * of the old range. Rows removed by projection, selected additions that became
 * context, and context trimmed by hunk contraction are skipped. At EOF the
 * cursor clamps to the last remaining non-consumed displayed row.
 *
 * New-side coordinates are stable across projection. Old-side coordinates are
 * remapped by the cumulative selected +/- parent shift, including prior hunks.
 * Split rows return a range across both panes when both sides are present;
 * unified +/- rows remain individual rows.
 */
export function advanceVimSelection(
  before: DiffFile,
  after: DiffFile | undefined,
  range: SelectedLineRange,
  style: "unified" | "split",
  refs: readonly RowRef[],
): { range: SelectedLineRange; selections: Selections } | null {
  if (!after || after.path !== before.path) return null;
  const selected = new Set(
    refs.filter((ref) => ref.path === before.path).map(refKey),
  );
  const beforePhysical = physicalRows(before, selected);
  const beforeVisual = visualRows(before, beforePhysical, style);
  const afterPhysical = physicalRows(after, new Set());
  if (!beforeVisual.length || !afterPhysical.length) return null;
  attachOrigins(beforePhysical, afterPhysical);
  const afterVisual = visualRows(after, afterPhysical, style);
  if (!afterVisual.length) return null;

  const startSide = range.side ?? "additions";
  const endSide = range.endSide ?? startSide;
  const bottom = Math.max(
    position(beforeVisual, range.start, startSide, style),
    position(beforeVisual, range.end, endSide, style),
  );
  const eligible = afterVisual.filter(
    (row) => !row.rows.some((physical) => physical.origin?.selected),
  );
  if (!eligible.length) return null;
  const next = eligible.find((row) => {
    const origins = row.rows
      .map((physical) => physical.origin?.visual)
      .filter((index): index is number => index !== undefined);
    if (origins.length) return Math.max(...origins) > bottom;
    const rowPoints = points(row, style);
    return rowPoints.some(
      (point) => position(beforeVisual, point.line, point.side, style) > bottom,
    );
  });
  const target = next ?? eligible.at(-1)!;
  return { range: rangeFor(target, style), selections: selectionsFor(target) };
}

/** Select the first displayed visual row in a file (used when squash removes
 * the previously active file). */
export function firstVimSelection(
  file: DiffFile,
  style: "unified" | "split",
): { range: SelectedLineRange; selections: Selections } | null {
  const first = visualRows(file, physicalRows(file, new Set()), style)[0];
  return first
    ? { range: rangeFor(first, style), selections: selectionsFor(first) }
    : null;
}
