import type { DiffFile, Hunk, RepoState, Row, Selections } from "./types";
import { metadataSelectionId } from "./file-selection";

/** Coordinates are in the selected diff; metadata changes use line 0. */
export type RowRef = {
  path: string;
  kind: "+" | "-" | "rename" | "copy" | "mode";
  line: number;
  text: string;
  noNewline?: boolean;
  /** File metadata carried along with the first text selection. */
  metadata?: string;
};
export type SquashSpec = { id: string; lines: number[] };

const key = (ref: RowRef): string =>
  JSON.stringify([
    ref.path,
    ref.kind,
    ref.line,
    ref.text,
    !!ref.noNewline,
    ref.metadata ?? null,
  ]);

function modeText(file: DiffFile): string | undefined {
  return file.oldMode !== undefined && file.newMode !== undefined
    ? JSON.stringify([file.oldMode, file.newMode])
    : undefined;
}

function metadataRef(file: DiffFile): RowRef | undefined {
  const mode = modeText(file);
  const kind =
    file.oldPath !== undefined
      ? "rename"
      : file.copyFrom !== undefined
        ? "copy"
        : mode
          ? "mode"
          : undefined;
  if (!kind) return;
  const from = file.oldPath ?? file.copyFrom;
  return {
    path: file.path,
    kind,
    line: 0,
    text:
      kind === "mode"
        ? mode!
        : mode
          ? JSON.stringify([from, file.oldMode, file.newMode])
          : from!,
  };
}

function metadataFingerprint(file: DiffFile): string | undefined {
  return metadataRef(file)
    ? JSON.stringify([
        file.oldPath ?? null,
        file.copyFrom ?? null,
        file.oldMode ?? null,
        file.newMode ?? null,
      ])
    : undefined;
}

function rowRef(file: DiffFile, row: Row): RowRef {
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
  const metadata = metadataFingerprint(file);
  return {
    path: file.path,
    kind,
    line,
    text: row.raw.slice(1),
    ...(row.noNewline ? { noNewline: true } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function checkedKeys(refs: RowRef[]): Set<string> {
  const keys = new Set<string>();
  for (const ref of refs) {
    if (
      !ref ||
      typeof ref.path !== "string" ||
      typeof ref.text !== "string" ||
      (ref.noNewline !== undefined && typeof ref.noNewline !== "boolean") ||
      (ref.metadata !== undefined && typeof ref.metadata !== "string") ||
      (["rename", "copy", "mode"].includes(ref.kind)
        ? ref.line !== 0 ||
          ref.noNewline !== undefined ||
          ref.metadata !== undefined
        : (ref.kind !== "+" && ref.kind !== "-") ||
          !Number.isSafeInteger(ref.line) ||
          ref.line < 1)
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
    if (entry.file.squashUnsupported)
      throw new Error(entry.file.squashUnsupported);
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
      refs.push(rowRef(entry.file, row));
    }
  }
  // Also verifies uniqueness across hunks and the exact remapping used at dispatch.
  specsForRefs(state, refs);
  return refs;
}

/** Select all remaining text changes, or metadata-only changes, in the optimistic view. */
export function refsFromFile(state: RepoState, path: string): RowRef[] {
  const file = state.files.find((entry) => entry.path === path);
  if (!file) throw new Error("Selected file no longer exists.");
  if (file.unsupported) throw new Error("Selected file is unsupported.");
  if (file.squashUnsupported) throw new Error(file.squashUnsupported);
  if (metadataSelectionId(file) !== undefined) {
    const refs = [metadataRef(file)!];
    specsForRefs(state, refs);
    return refs;
  }
  return refsFromSelection(
    state,
    Object.fromEntries(
      file.hunks.map((hunk) => [
        hunk.id,
        hunk.rows
          .filter((row) => row.raw[0] === "+" || row.raw[0] === "-")
          .map((row) => row.index),
      ]),
    ),
  );
}

/** Remap only by the full path/side/source-line/body tuple; never by text alone. */
export function specsForRefs(state: RepoState, refs: RowRef[]): SquashSpec[] {
  const wanted = checkedKeys(refs);
  const matches = new Set<string>();
  const specs: SquashSpec[] = [];
  const ids = new Set<string>();
  const paths = new Set(refs.map((ref) => ref.path));
  for (const file of state.files) {
    if (file.squashUnsupported && paths.has(file.path))
      throw new Error(file.squashUnsupported);
    const metadataId = metadataSelectionId(file);
    if (metadataId !== undefined) {
      const metadataKey = key(metadataRef(file)!);
      if (wanted.has(metadataKey)) {
        if (file.squashUnsupported) throw new Error(file.squashUnsupported);
        if (matches.has(metadataKey))
          throw new Error("Metadata reference is ambiguous.");
        matches.add(metadataKey);
        specs.push({ id: metadataId, lines: [] });
      }
    }
    for (const hunk of file.hunks) {
      if (ids.has(hunk.id)) throw new Error("Ambiguous hunk ID.");
      ids.add(hunk.id);
      const lines: number[] = [];
      const indexCounts = new Map<number, number>();
      for (const row of hunk.rows)
        indexCounts.set(row.index, (indexCounts.get(row.index) ?? 0) + 1);
      for (const row of hunk.rows) {
        if (row.raw[0] !== "+" && row.raw[0] !== "-") continue;
        const value = key(rowRef(file, row));
        if (!wanted.has(value)) continue;
        if (file.unsupported) throw new Error("Selected file is unsupported.");
        if (file.squashUnsupported) throw new Error(file.squashUnsupported);
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
  }
  if (matches.size !== wanted.size)
    throw new Error(
      "Selected changes no longer match the repository; refresh before squashing.",
    );
  return specs;
}

/** Context, hunk boundaries and IDs do not participate; moves are changes too. */
export function changeSignature(state: RepoState): string {
  const keys: string[] = [];
  for (const file of state.files) {
    const metadata = metadataRef(file);
    if (metadata) keys.push(key(metadata));
    for (const hunk of file.hunks)
      for (const row of hunk.rows)
        if (row.raw[0] === "+" || row.raw[0] === "-")
          keys.push(key(rowRef(file, row)));
  }
  return JSON.stringify(keys.sort());
}

/** Combine selections made before and after a projection in the original coordinates. */
export function combineSquashRefs(
  state: RepoState,
  selected: RowRef[],
  next: RowRef[],
  isDescendant = false,
): RowRef[] {
  specsForRefs(state, selected);
  const moved = checkedKeys(selected);
  const wanted = checkedKeys(next);
  const combined = [...selected];
  const matched = new Set<string>();
  const affected = new Set(selected.map((ref) => ref.path));
  for (const file of state.files) {
    if (metadataSelectionId(file) !== undefined) {
      const original = metadataRef(file)!;
      const value = key(original);
      if (!moved.has(value) && wanted.has(value)) {
        if (matched.has(value))
          throw new Error("Metadata reference is ambiguous.");
        matched.add(value);
        combined.push(original);
      }
    }
    // Ancestor squashes change OLD, descendant squashes change NEW. Carry
    // offsets across hunks, never across files or onto the unchanged side.
    let delta = 0;
    for (const hunk of file.hunks)
      for (const row of hunk.rows) {
        if (row.raw[0] !== "+" && row.raw[0] !== "-") continue;
        const original = rowRef(file, row);
        if (moved.has(key(original))) {
          delta += (original.kind === "+" ? 1 : -1) * (isDescendant ? -1 : 1);
          continue;
        }
        const projected = key({
          ...original,
          ...(affected.has(file.path) ? { metadata: undefined } : {}),
          line:
            original.line +
            (original.kind === (isDescendant ? "+" : "-") ? delta : 0),
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
  isDescendant: boolean,
): DiffFile | null {
  let delta = 0;
  let movedAdditions = 0;
  let movedDeletions = 0;
  let changedSideEnded = false;
  const hunks: Hunk[] = [];
  for (const hunk of file.hunks) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(
      hunk.header,
    );
    if (!match) throw new Error("Cannot project a malformed hunk header.");
    const oldCount = Number(match[2] ?? 1),
      newCount = Number(match[4] ?? 1);
    const oldFirst =
      Number(match[1]) + (oldCount === 0 ? 1 : 0) + (isDescendant ? 0 : delta);
    const newFirst =
      Number(match[3]) + (newCount === 0 ? 1 : 0) + (isDescendant ? delta : 0);
    let oldLine = oldFirst,
      newLine = newFirst;
    const rows: Row[] = [];
    for (const row of hunk.rows) {
      const kind = row.raw[0];
      if (kind !== " " && kind !== "+" && kind !== "-")
        throw new Error("Cannot project unsupported patch rows.");
      const move = kind !== " " && selected.has(key(rowRef(file, row)));
      if (move && kind === (isDescendant ? "+" : "-")) {
        delta--;
        continue;
      }
      let raw = row.raw;
      if (move) {
        raw = " " + raw.slice(1);
        delta++;
        if (kind === "+") movedAdditions++;
        else movedDeletions++;
      }
      const next: Row = {
        index: rows.length + 1,
        raw,
        ...(row.noNewline ? { noNewline: true } : {}),
      };
      if (raw[0] !== (isDescendant ? "-" : "+")) {
        if (changedSideEnded)
          throw new Error(
            "This selection would put content after a line without a final newline. Select the related EOF changes together.",
          );
        changedSideEnded = !!row.noNewline;
      }
      if (raw[0] !== "+") next.oldLine = oldLine++;
      if (raw[0] !== "-") next.newLine = newLine++;
      rows.push(next);
    }
    hunks.push(
      ...contractHunk(hunk, rows, oldFirst, newFirst, match[5], reservedIds),
    );
  }
  if (!hunks.length) return null;
  const isNew =
    /^--- \/dev\/null$/m.test(file.patch) &&
    (isDescendant || movedAdditions === 0);
  const isDeleted =
    /^\+\+\+ \/dev\/null$/m.test(file.patch) &&
    (!isDescendant || movedDeletions === 0);
  const indexHeader = /^index (\S+)(?: (100644|100755))?$/m.exec(file.patch);
  const mode =
    (isDescendant ? file.oldMode : file.newMode) ??
    indexHeader?.[2] ??
    /^(?:new|deleted) file mode (100644|100755)$/m.exec(file.patch)?.[1] ??
    "100644";
  const prefix = [
    `diff --git a/${file.path} b/${file.path}`,
    ...(isNew ? [`new file mode ${mode}`] : []),
    ...(isDeleted ? [`deleted file mode ${mode}`] : []),
    // Content changed; original blob hashes are no longer valid. An
    // all-zero index preserves non-default/transition modes for rendering only.
    ...(!isNew && !isDeleted && (mode === "100755" || file.newMode)
      ? [`index 0000000..0000000 ${mode}`]
      : []),
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
  const projected = {
    ...file,
    hunks,
    additions,
    deletions,
    patch:
      [
        ...prefix,
        ...hunks.flatMap((hunk) => [
          hunk.header,
          ...hunk.rows.flatMap((row) =>
            row.noNewline
              ? [row.raw, "\\ No newline at end of file"]
              : [row.raw],
          ),
        ]),
      ].join("\n") + "\n",
  };
  // First selection carries file metadata out of the source delta. Forward
  // copy/rename subtraction needs native path/merge information (see below).
  delete projected.oldPath;
  delete projected.copyFrom;
  delete projected.oldMode;
  delete projected.newMode;
  return projected;
}

/**
 * Native forward subtraction of a rename/copy can restore another path or
 * conflict with residual text. A single-file patch cannot predict that safely.
 * Such jobs must be serialized without speculation, not guessed or rejected.
 */
export function canProjectSquash(
  state: RepoState,
  refs: RowRef[],
  isDescendant = false,
): boolean {
  const paths = new Set(refs.map((ref) => ref.path));
  return (
    !isDescendant ||
    !state.files.some(
      (file) =>
        paths.has(file.path) &&
        (file.oldPath !== undefined || file.copyFrom !== undefined),
    )
  );
}

/** Remove selected source changes: alter OLD for ancestors, NEW for descendants. */
export function projectSquash(
  state: RepoState,
  refs: RowRef[],
  isDescendant = false,
): RepoState {
  specsForRefs(state, refs);
  if (!canProjectSquash(state, refs, isDescendant))
    throw new Error(
      "Forward rename/copy changes require an authoritative result.",
    );
  const selected = checkedKeys(refs);
  const affected = new Set(refs.map((ref) => ref.path));
  // Synthetic split IDs must not collide with any real or earlier projected ID,
  // including hunks in unaffected files. Dispatch still maps by exact RowRef.
  const reservedIds = new Set(
    state.files.flatMap((file) => file.hunks.map((hunk) => hunk.id)),
  );
  const files = state.files.flatMap((file) => {
    if (!affected.has(file.path)) return [file];
    const projected = projectFile(file, selected, reservedIds, isDescendant);
    return projected ? [projected] : [];
  });
  return { ...state, files };
}
