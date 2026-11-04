import { parseFile } from "./diff.ts";

/** Exact unchanged coordinates from a verified full pinned diff, never text search. */
export function unchangedCodeLines(
  path: string,
  oldText: string,
  newText: string,
  patch?: string,
): Map<number, number> {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.at(-1) === "") oldLines.pop();
  if (newLines.at(-1) === "") newLines.pop();
  if (oldLines.length > 100000 || newLines.length > 100000)
    throw new Error("Code projection exceeds 100000 lines.");
  const result = new Map<number, number>();
  let old = 1;
  let next = 1;
  const context = () => {
    if (oldLines[old - 1] !== newLines[next - 1])
      throw new Error("Pinned unchanged lines disagree.");
    result.set(old++, next++);
  };
  if (patch) {
    const parsed = parseFile(patch, path);
    for (const hunk of parsed.hunks) {
      const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
        hunk.header,
      )!;
      const startOld = Number(header[1]) + (header[2] === "0" ? 1 : 0);
      const startNew = Number(header[3]) + (header[4] === "0" ? 1 : 0);
      while (old < startOld && next < startNew) context();
      if (old !== startOld || next !== startNew)
        throw new Error("Pinned diff gaps disagree.");
      for (const row of hunk.rows) {
        const value = row.raw.slice(1);
        if (
          row.raw[0] !== "+" &&
          (row.oldLine !== old || oldLines[old - 1] !== value)
        )
          throw new Error("Pinned old code disagrees.");
        if (
          row.raw[0] !== "-" &&
          (row.newLine !== next || newLines[next - 1] !== value)
        )
          throw new Error("Pinned new code disagrees.");
        if (row.raw[0] === " ") context();
        else if (row.raw[0] === "-") old++;
        else if (row.raw[0] === "+") next++;
        else throw new Error("Unsupported pinned diff row.");
      }
    }
  }
  while (old <= oldLines.length && next <= newLines.length) context();
  if (old !== oldLines.length + 1 || next !== newLines.length + 1)
    throw new Error("Pinned diff tails disagree.");
  return result;
}
