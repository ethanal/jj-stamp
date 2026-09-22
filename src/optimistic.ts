import type { DiffFile, Hunk, RepoState, Row, Selections } from "./types";

/** Coordinates are in the version of the diff in which the selection was made. */
export type RowRef = {
  path: string;
  kind: "+" | "-";
  line: number;
  text: string;
};
export type SquashSpec = { id: string; lines: number[] };

const key = (ref: RowRef): string =>
  JSON.stringify([ref.path, ref.kind, ref.line, ref.text]);

function rowRef(path: string, row: Row): RowRef {
  const kind = row.raw[0];
  if (kind !== "+" && kind !== "-")
    throw new Error(
      "Selection must identify a changed row with valid source coordinates.",
    );
  const line = kind === "+" ? row.newLine : row.oldLine;
  if (line === undefined || !Number.isSafeInteger(line) || line < 1)
    throw new Error(
      "Selection must identify a changed row with valid source coordinates.",
    );
  return { path, kind, line, text: row.raw.slice(1) };
}

function checkedKeys(refs: RowRef[]): Set<string> {
  const keys = new Set<string>();
  for (const ref of refs) {
    if (
      !ref ||
      typeof ref.path !== "string" ||
      typeof ref.text !== "string" ||
      (ref.kind !== "+" && ref.kind !== "-") ||
      !Number.isSafeInteger(ref.line) ||
      ref.line < 1
    )
      throw new Error("Invalid changed-row reference.");
    const value = key(ref);
    if (keys.has(value)) throw new Error("Duplicate changed-row reference.");
    keys.add(value);
  }
  return keys;
}

/** Never silently ignore context, stale IDs, duplicate indices, or unsupported files. */
export function refsFromSelection(
  state: RepoState,
  selections: Selections,
): RowRef[] {
  const hunks = new Map<string, { file: DiffFile; hunk: Hunk }>();
  for (const file of state.files)
    for (const hunk of file.hunks) {
      if (hunks.has(hunk.id)) throw new Error("Ambiguous hunk ID.");
      hunks.set(hunk.id, { file, hunk });
    }
  const refs: RowRef[] = [];
  for (const [id, lines] of Object.entries(selections)) {
    const entry = hunks.get(id);
    if (!entry) throw new Error("Selected hunk no longer exists.");
    if (entry.file.unsupported)
      throw new Error("Selected file is unsupported.");
    const seen = new Set<number>();
    const rowsByIndex = new Map<number, Row>();
    const ambiguous = new Set<number>();
    for (const row of entry.hunk.rows) {
      if (rowsByIndex.has(row.index)) ambiguous.add(row.index);
      rowsByIndex.set(row.index, row);
    }
    for (const index of lines) {
      if (!Number.isSafeInteger(index) || index < 1 || seen.has(index))
        throw new Error("Invalid or duplicate selected row index.");
      seen.add(index);
      const row = rowsByIndex.get(index);
      if (!row || ambiguous.has(index))
        throw new Error("Selected row no longer exists or is ambiguous.");
      refs.push(rowRef(entry.file.path, row));
    }
  }
  // Also verifies uniqueness across hunks and the exact remapping used at dispatch.
  specsForRefs(state, refs);
  return refs;
}

/** Remap only by the full path/side/source-line/body tuple; never by text alone. */
export function specsForRefs(state: RepoState, refs: RowRef[]): SquashSpec[] {
  const wanted = checkedKeys(refs);
  const matches = new Set<string>();
  const specs: SquashSpec[] = [];
  const ids = new Set<string>();
  for (const file of state.files)
    for (const hunk of file.hunks) {
      if (ids.has(hunk.id)) throw new Error("Ambiguous hunk ID.");
      ids.add(hunk.id);
      const lines: number[] = [];
      const indexCounts = new Map<number, number>();
      for (const row of hunk.rows)
        indexCounts.set(row.index, (indexCounts.get(row.index) ?? 0) + 1);
      for (const row of hunk.rows) {
        if (row.raw[0] !== "+" && row.raw[0] !== "-") continue;
        const value = key(rowRef(file.path, row));
        if (!wanted.has(value)) continue;
        if (file.unsupported) throw new Error("Selected file is unsupported.");
        if (matches.has(value))
          throw new Error("Changed-row reference is ambiguous.");
        if (
          !Number.isSafeInteger(row.index) ||
          row.index < 1 ||
          indexCounts.get(row.index) !== 1
        )
          throw new Error(
            "Changed row has an invalid or ambiguous tool index.",
          );
        matches.add(value);
        lines.push(row.index);
      }
      if (lines.length) specs.push({ id: hunk.id, lines });
    }
  if (matches.size !== wanted.size)
    throw new Error(
      "Selected changes no longer match the repository; refresh before squashing.",
    );
  return specs;
}

/** Context, hunk boundaries, IDs, and metadata deliberately do not participate. */
export function changeSignature(state: RepoState): string {
  const keys: string[] = [];
  for (const file of state.files)
    for (const hunk of file.hunks)
      for (const row of hunk.rows)
        if (row.raw[0] === "+" || row.raw[0] === "-")
          keys.push(key(rowRef(file.path, row)));
  return JSON.stringify(keys.sort());
}

/** Combine selections made before and after a projection in the original coordinates. */
export function combineSquashRefs(
  state: RepoState,
  selected: RowRef[],
  next: RowRef[],
): RowRef[] {
  specsForRefs(state, selected);
  const moved = checkedKeys(selected);
  const wanted = checkedKeys(next);
  const combined = [...selected];
  const matched = new Set<string>();
  for (const file of state.files) {
    // Squashing only changes the parent side. Carry its offset across hunks,
    // but never across files; additions retain their source coordinates.
    let delta = 0;
    for (const hunk of file.hunks)
      for (const row of hunk.rows) {
        if (row.raw[0] !== "+" && row.raw[0] !== "-") continue;
        const original = rowRef(file.path, row);
        if (moved.has(key(original))) {
          delta += original.kind === "+" ? 1 : -1;
          continue;
        }
        const projected = key({
          ...original,
          line: original.line + (original.kind === "-" ? delta : 0),
        });
        if (!wanted.has(projected)) continue;
        if (matched.has(projected))
          throw new Error("Changed-row reference is ambiguous.");
        matched.add(projected);
        combined.push(original);
      }
  }
  if (matched.size !== wanted.size)
    throw new Error(
      "Selected changes no longer match the repository; refresh before squashing.",
    );
  specsForRefs(state, combined);
  return combined;
}

const CONTEXT_LINES = 3;

/** Keep only the context surrounding remaining changes, splitting long gaps. */
function contractHunk(
  hunk: Hunk,
  rows: Row[],
  oldFirst: number,
  newFirst: number,
  suffix: string,
  reservedIds: Set<string>,
): Hunk[] {
  const ranges: { start: number; end: number }[] = [];
  const oldOffsets = [0],
    newOffsets = [0];
  for (let index = 0; index < rows.length; index++) {
    const kind = rows[index].raw[0];
    oldOffsets.push(oldOffsets[index] + (kind === "+" ? 0 : 1));
    newOffsets.push(newOffsets[index] + (kind === "-" ? 0 : 1));
    if (kind === " ") continue;
    const start = Math.max(0, index - CONTEXT_LINES);
    const end = Math.min(rows.length, index + CONTEXT_LINES + 1);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = end;
    else ranges.push({ start, end });
  }
  return ranges.map(({ start, end }, part) => {
    const oldLength = oldOffsets[end] - oldOffsets[start];
    const newLength = newOffsets[end] - newOffsets[start];
    // Empty sides anchor immediately BEFORE the first position, as unified
    // diffs require. Count trimmed context on both sides, not just row offsets.
    const oldStart = oldFirst + oldOffsets[start] - (oldLength ? 0 : 1);
    const newStart = newFirst + newOffsets[start] - (newLength ? 0 : 1);
    let id = hunk.id;
    if (part) {
      let serial = part;
      do id = `${hunk.id}:optimistic:${serial++}`;
      while (reservedIds.has(id));
      reservedIds.add(id);
    }
    return {
      ...hunk,
      id,
      header: `@@ -${oldStart},${oldLength} +${newStart},${newLength} @@${suffix}`,
      rows: rows.slice(start, end).map((row, index) => ({
        ...row,
        index: index + 1,
      })),
    };
  });
}

function projectFile(
  file: DiffFile,
  selected: Set<string>,
  reservedIds: Set<string>,
): DiffFile | null {
  let delta = 0;
  let movedAdditions = 0;
  const hunks: Hunk[] = [];
  for (const hunk of file.hunks) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
      hunk.header,
    );
    if (!match) throw new Error("Cannot project a malformed hunk header.");
    const oldCount = Number(match[2] ?? 1),
      newCount = Number(match[4] ?? 1);
    const oldFirst = Number(match[1]) + (oldCount === 0 ? 1 : 0) + delta;
    const newFirst = Number(match[3]) + (newCount === 0 ? 1 : 0);
    let oldLine = oldFirst,
      newLine = newFirst;
    const rows: Row[] = [];
    for (const row of hunk.rows) {
      const kind = row.raw[0];
      if (kind !== " " && kind !== "+" && kind !== "-")
        throw new Error("Cannot project unsupported patch rows.");
      const move = kind !== " " && selected.has(key(rowRef(file.path, row)));
      if (move && kind === "-") {
        delta--;
        continue;
      }
      let raw = row.raw;
      if (move && kind === "+") {
        raw = " " + raw.slice(1);
        delta++;
        movedAdditions++;
      }
      const next: Row = { index: rows.length + 1, raw };
      if (raw[0] !== "+") next.oldLine = oldLine++;
      if (raw[0] !== "-") next.newLine = newLine++;
      rows.push(next);
    }
    hunks.push(
      ...contractHunk(hunk, rows, oldFirst, newFirst, match[5], reservedIds),
    );
  }
  if (!hunks.length) return null;
  const isNew = /^--- \/dev\/null$/m.test(file.patch) && movedAdditions === 0;
  const isDeleted = /^\+\+\+ \/dev\/null$/m.test(file.patch);
  const prefix = [
    `diff --git a/${file.path} b/${file.path}`,
    ...(isNew ? ["new file mode 100644"] : []),
    ...(isDeleted ? ["deleted file mode 100644"] : []),
    `--- ${isNew ? "/dev/null" : `a/${file.path}`}`,
    `+++ ${isDeleted ? "/dev/null" : `b/${file.path}`}`,
  ];
  let additions = 0,
    deletions = 0;
  for (const hunk of hunks)
    for (const row of hunk.rows) {
      if (row.raw[0] === "+") additions++;
      if (row.raw[0] === "-") deletions++;
    }
  return {
    ...file,
    hunks,
    additions,
    deletions,
    patch:
      [
        ...prefix,
        ...hunks.flatMap((hunk) => [
          hunk.header,
          ...hunk.rows.map((row) => row.raw),
        ]),
      ].join("\n") + "\n",
  };
}

/** Move selected changes into the parent without modifying the working/new side. */
export function projectSquash(state: RepoState, refs: RowRef[]): RepoState {
  specsForRefs(state, refs);
  const selected = checkedKeys(refs);
  const affected = new Set(refs.map((ref) => ref.path));
  // Synthetic split IDs must not collide with any real or earlier projected ID,
  // including hunks in unaffected files. Dispatch still maps by exact RowRef.
  const reservedIds = new Set(
    state.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
  );
  const files = state.files.flatMap((file) => {
    if (!affected.has(file.path)) return [file];
    const projected = projectFile(file, selected, reservedIds);
    return projected ? [projected] : [];
  });
  return { ...state, files };
}
