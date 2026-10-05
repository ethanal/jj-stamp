import type { DiffFile } from "./types";

export interface DiffSearchMatch {
  path: string;
  hunkId: string;
  rowIndex: number;
  line: number;
  side: "additions" | "deletions";
}

/** Search every patch row, including rows outside the virtualized DOM window. */
export function findDiffMatches(
  files: readonly DiffFile[],
  query: string,
): DiffSearchMatch[] {
  if (!query) return [];
  const needle = query.toLocaleLowerCase();
  const matches: DiffSearchMatch[] = [];
  for (const file of files) {
    if (file.unsupported) continue;
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        const marker = row.raw[0];
        const side = marker === "-" ? "deletions" : "additions";
        const line = side === "deletions" ? row.oldLine : row.newLine;
        if (line == null) continue;
        if (!row.raw.slice(1).toLocaleLowerCase().includes(needle)) continue;
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
  return matches;
}
