import type { LinePoint } from "./selection";
import type { DiffFile, Hunk, Row } from "./types";

type Side = LinePoint["side"];
type Style = "unified" | "split";
type Boundary = { old: number; new: number };

interface LocatedRow extends Boundary {
  hunk: number;
  offset: number;
  position: number;
  global: number;
  row: Row;
}

interface FileRows {
  rows: LocatedRow[];
  hunks: LocatedRow[][];
}

const LOCAL_WINDOW = 6;
const NEARBY_DISTANCE = 12;

function hunkStart(hunk: Hunk): Boundary {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk.header);
  return {
    old:
      match === null
        ? (hunk.rows.find((row) => row.oldLine !== undefined)?.oldLine ?? 1)
        : Number(match[1]),
    new:
      match === null
        ? (hunk.rows.find((row) => row.newLine !== undefined)?.newLine ?? 1)
        : Number(match[2]),
  };
}

function fileRows(file: DiffFile): FileRows {
  const rows: LocatedRow[] = [];
  const hunks: LocatedRow[][] = [];
  for (let hunk = 0; hunk < file.hunks.length; hunk++) {
    const located: LocatedRow[] = [];
    let { old, new: newLine } = hunkStart(file.hunks[hunk]);
    for (let offset = 0; offset < file.hunks[hunk].rows.length; offset++) {
      const row = file.hunks[hunk].rows[offset];
      if (row.raw[0] !== " " && row.raw[0] !== "+" && row.raw[0] !== "-")
        continue;
      const entry: LocatedRow = {
        hunk,
        offset,
        position: located.length,
        global: rows.length,
        row,
        old: row.oldLine ?? old,
        new: row.newLine ?? newLine,
      };
      located.push(entry);
      rows.push(entry);
      if (row.oldLine !== undefined) old = row.oldLine + 1;
      if (row.newLine !== undefined) newLine = row.newLine + 1;
    }
    hunks.push(located);
  }
  return { rows, hunks };
}

function points(row: Row, style: Style): LinePoint[] {
  if (row.raw[0] === "-")
    return row.oldLine === undefined
      ? []
      : [{ line: row.oldLine, side: "deletions" }];
  if (row.raw[0] === "+")
    return row.newLine === undefined
      ? []
      : [{ line: row.newLine, side: "additions" }];
  if (row.raw[0] !== " ") return [];
  const result: LinePoint[] = [];
  if (style === "split" && row.oldLine !== undefined)
    result.push({ line: row.oldLine, side: "deletions" });
  if (row.newLine !== undefined)
    result.push({ line: row.newLine, side: "additions" });
  return result;
}

function pointFor(row: Row, side: Side, style: Style): LinePoint | null {
  const available = points(row, style);
  return available.find((point) => point.side === side) ?? available[0] ?? null;
}

function findCursor(
  rows: readonly LocatedRow[],
  cursor: LinePoint,
  style: Style,
): LocatedRow | undefined {
  return rows.find((entry) =>
    points(entry.row, style).some(
      (point) => point.line === cursor.line && point.side === cursor.side,
    ),
  );
}

function signature(hunk: Hunk): string {
  return JSON.stringify(hunk.rows.map((row) => row.raw));
}

function signatureGroups(signatures: readonly string[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  for (let index = 0; index < signatures.length; index++) {
    const matches = groups.get(signatures[index]) ?? [];
    matches.push(index);
    groups.set(signatures[index], matches);
  }
  return groups;
}

/** Return true when the first lexicographic score is better. */
function better(score: readonly number[], best?: readonly number[]): boolean {
  if (!best) return true;
  for (let index = 0; index < score.length; index++) {
    if (score[index] !== best[index]) return score[index] > best[index];
  }
  return false;
}

function nearestExactHunk(
  before: DiffFile,
  after: DiffFile,
  beforeIndex: number,
  candidates: readonly number[],
): number {
  const source = hunkStart(before.hunks[beforeIndex]);
  let best = candidates[0];
  let bestScore: number[] | undefined;
  for (const candidate of candidates) {
    const target = hunkStart(after.hunks[candidate]);
    const score = [
      -Math.abs(target.old - source.old),
      -Math.abs(target.new - source.new),
      -Math.abs(candidate - beforeIndex),
      -candidate,
    ];
    if (better(score, bestScore)) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function uniqueAnchors(
  before: DiffFile,
  after: DiffFile,
  beforeGroups: ReadonlyMap<string, number[]>,
  afterGroups: ReadonlyMap<string, number[]>,
): { before: Boundary; after: Boundary }[] {
  const anchors: { before: Boundary; after: Boundary }[] = [];
  for (const [key, beforeMatches] of beforeGroups) {
    const afterMatches = afterGroups.get(key);
    if (beforeMatches.length !== 1 || afterMatches?.length !== 1) continue;
    anchors.push({
      before: hunkStart(before.hunks[beforeMatches[0]]),
      after: hunkStart(after.hunks[afterMatches[0]]),
    });
  }
  return anchors;
}

function projectBoundary(
  boundary: Boundary,
  anchors: readonly { before: Boundary; after: Boundary }[],
): Boundary {
  const result = { ...boundary };
  let oldDistance = Infinity;
  let newDistance = Infinity;
  for (const anchor of anchors) {
    const old = Math.abs(anchor.before.old - boundary.old);
    if (old < oldDistance) {
      oldDistance = old;
      result.old = boundary.old + anchor.after.old - anchor.before.old;
    }
    const newLine = Math.abs(anchor.before.new - boundary.new);
    if (newLine < newDistance) {
      newDistance = newLine;
      result.new = boundary.new + anchor.after.new - anchor.before.new;
    }
  }
  return result;
}

function distance(row: Boundary, target: Boundary): number {
  return Math.max(
    Math.abs(row.old - target.old),
    Math.abs(row.new - target.new),
  );
}

function fallback(
  rows: readonly LocatedRow[],
  target: Boundary,
  side: Side,
  style: Style,
): LinePoint | null {
  let best: { point: LinePoint; score: number[] } | undefined;
  for (const row of rows) {
    const point = pointFor(row.row, side, style);
    if (!point) continue;
    const score = [
      -distance(row, target),
      point.side === side ? 1 : 0,
      -row.global,
    ];
    if (better(score, best?.score)) best = { point, score };
  }
  return best?.point ?? null;
}

function localRemap(
  beforeRows: FileRows,
  afterRows: FileRows,
  source: LocatedRow,
  target: Boundary,
  side: Side,
  style: Style,
): LinePoint | null {
  const occurrences = new Map<string, LocatedRow[]>();
  for (const row of afterRows.rows) {
    const matches = occurrences.get(row.row.raw) ?? [];
    matches.push(row);
    occurrences.set(row.row.raw, matches);
  }

  const sourceHunk = beforeRows.hunks[source.hunk];
  const candidates = new Map<number, LocatedRow>();
  for (let delta = -LOCAL_WINDOW; delta <= LOCAL_WINDOW; delta++) {
    const neighbor = sourceHunk[source.position + delta];
    if (!neighbor) continue;
    for (const occurrence of occurrences.get(neighbor.row.raw) ?? []) {
      const candidate =
        afterRows.hunks[occurrence.hunk][occurrence.position - delta];
      if (candidate) candidates.set(candidate.global, candidate);
    }
  }

  let best: { point: LinePoint; score: number[] } | undefined;
  for (const row of candidates.values()) {
    const point = pointFor(row.row, side, style);
    if (!point) continue;
    const afterHunk = afterRows.hunks[row.hunk];
    let neighbors = 0;
    let context = 0;
    for (let delta = -LOCAL_WINDOW; delta <= LOCAL_WINDOW; delta++) {
      const beforeNeighbor = sourceHunk[source.position + delta];
      const afterNeighbor = afterHunk[row.position + delta];
      if (!beforeNeighbor || !afterNeighbor) continue;
      if (beforeNeighbor.row.raw !== afterNeighbor.row.raw) continue;
      context += LOCAL_WINDOW + 1 - Math.abs(delta);
      if (delta !== 0) neighbors++;
    }
    const exact = row.row.raw === source.row.raw;
    const rowDistance = distance(row, target);
    const acceptable = exact
      ? neighbors >= 2 || rowDistance <= NEARBY_DISTANCE
      : neighbors >= 2 || (neighbors >= 1 && rowDistance <= NEARBY_DISTANCE);
    if (!acceptable) continue;
    const projected = rowDistance <= 1 && (exact || neighbors >= 2);
    const score = [
      projected ? 1 : 0,
      neighbors,
      context,
      exact ? 1 : 0,
      -rowDistance,
      -row.global,
    ];
    if (better(score, best?.score)) best = { point, score };
  }
  return best?.point ?? null;
}

/** Infer both coordinates for expanded context, including outside patch bounds. */
function expandedBoundary(
  rows: readonly LocatedRow[],
  cursor: LinePoint,
  style: Style,
): Boundary | null {
  if (cursor.line < 1) return null;
  const sameSide = rows.filter((row) =>
    points(row.row, style).some((point) => point.side === cursor.side),
  );
  const candidates = sameSide.length ? sameSide : rows;
  let nearest: LocatedRow | undefined;
  let bestDistance = Infinity;
  for (const row of candidates) {
    const line = cursor.side === "additions" ? row.new : row.old;
    const rowDistance = Math.abs(line - cursor.line);
    if (rowDistance < bestDistance) {
      nearest = row;
      bestDistance = rowDistance;
    }
  }
  if (!nearest) return null;
  const delta =
    cursor.side === "additions"
      ? nearest.old - nearest.new
      : nearest.new - nearest.old;
  return cursor.side === "additions"
    ? { old: cursor.line + delta, new: cursor.line }
    : { old: cursor.line, new: cursor.line + delta };
}

/**
 * Preserve a Vim cursor while a file patch is replaced by a repository refresh.
 * Exact bodies retain their row offset; edited bodies use bounded local context,
 * then the nearest displayed row. No whole-file sequence alignment is used.
 */
export function remapVimCursor(
  before: DiffFile,
  after: DiffFile,
  cursor: LinePoint,
  style: Style,
): LinePoint | null {
  if (
    before.path !== after.path ||
    !Number.isSafeInteger(cursor.line) ||
    cursor.line < 1
  )
    return null;
  const beforeRows = fileRows(before);
  const afterRows = fileRows(after);
  if (!beforeRows.rows.length || !afterRows.rows.length) return null;

  const source = findCursor(beforeRows.rows, cursor, style);
  const beforeSignatures = before.hunks.map(signature);
  const afterSignatures = after.hunks.map(signature);
  const beforeGroups = signatureGroups(beforeSignatures);
  const afterGroups = signatureGroups(afterSignatures);

  if (source) {
    const matches = afterGroups.get(beforeSignatures[source.hunk]);
    if (matches?.length) {
      const hunk = nearestExactHunk(before, after, source.hunk, matches);
      const row = after.hunks[hunk].rows[source.offset];
      const point = row && pointFor(row, cursor.side, style);
      if (point) return point;
    }
  }

  const boundary = source
    ? { old: source.old, new: source.new }
    : expandedBoundary(beforeRows.rows, cursor, style);
  if (!boundary) return null;
  const target = projectBoundary(
    boundary,
    uniqueAnchors(before, after, beforeGroups, afterGroups),
  );
  if (source) {
    const local = localRemap(
      beforeRows,
      afterRows,
      source,
      target,
      cursor.side,
      style,
    );
    if (local) return local;
  }
  return fallback(afterRows.rows, target, cursor.side, style);
}
