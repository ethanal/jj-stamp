import type { DiffFile } from "./types";

export interface DiffSearchMatch {
  path: string;
  hunkId: string;
  rowIndex: number;
  line: number;
  side: "additions" | "deletions";
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
  let pattern: RegExp | null = null;
  if (regex) {
    try {
      pattern = new RegExp(query, "iu");
    } catch {
      return { matches: [], error: "Invalid regex" };
    }
  }
  const needle = regex ? "" : query.toLocaleLowerCase();
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
        if (
          pattern
            ? !pattern.test(text)
            : !text.toLocaleLowerCase().includes(needle)
        )
          continue;
        matches.push({
          path: file.path,
          hunkId: hunk.id,
          rowIndex: row.index,
          line,
          side,
        });
      }
    }
  }
  return { matches, error: "" };
}
