import type { DiffFile } from "./types";

export interface DiffSearchMatch {
  path: string;
  hunkId: string;
  rowIndex: number;
  line: number;
  side: "additions" | "deletions";
  /** UTF-16 offsets within the row text, excluding the patch marker. */
  start: number;
  end: number;
}

export interface DiffSearchResult {
  matches: DiffSearchMatch[];
  error: string;
}

/** Search every patch row, including rows outside the virtualized DOM window. */
export function searchDiffRows(
  files: readonly DiffFile[],
  query: string,
  regex: boolean,
): DiffSearchResult {
  if (!query) return { matches: [], error: "" };
  let pattern: RegExp;
  try {
    pattern = new RegExp(
      regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "giu",
    );
  } catch {
    return { matches: [], error: "Invalid regex" };
  }
  const matches: DiffSearchMatch[] = [];
  for (const file of files) {
    if (file.unsupported) continue;
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        const marker = row.raw[0];
        const side = marker === "-" ? "deletions" : "additions";
        const line = side === "deletions" ? row.oldLine : row.newLine;
        if (line == null) continue;
        const text = row.raw.slice(1);
        for (const match of text.matchAll(pattern)) {
          // Empty matches have no text to highlight. matchAll advances safely,
          // including over surrogate pairs, even for zero-width expressions.
          if (!match[0].length) continue;
          matches.push({
            path: file.path,
            hunkId: hunk.id,
            rowIndex: row.index,
            line,
            side,
            start: match.index,
            end: match.index + match[0].length,
          });
        }
      }
    }
  }
  return { matches, error: "" };
}
