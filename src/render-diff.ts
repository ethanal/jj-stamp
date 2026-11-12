import { parsePatchFiles } from "@pierre/diffs";
import type { DiffFile } from "./types";

/** Adapt patch transport details to Pierre's source-backed rendering metadata. */
export function parseRenderDiff(file: DiffFile, cacheKey?: string) {
  // The patch's last LF is transport, not the source file's EOF. Pierre keeps
  // raw line terminators, so restore a stripped transport LF before parsing.
  // Explicit EOF markers, not the transport terminator, remove source LFs.
  const patch = file.patch.endsWith("\n") ? file.patch : `${file.patch}\n`;
  const parsed = parsePatchFiles(patch, cacheKey, true)[0]?.files[0];
  if (!parsed) return;
  // jj emits rename from/to without Git's optional similarity index, which
  // Pierre otherwise uses to classify renames.
  if (file.oldPath) {
    parsed.prevName = file.oldPath;
    parsed.name = file.path;
    parsed.type = file.hunks.length ? "rename-changed" : "rename-pure";
  }
  // Pierre's EOF cleanup removes CRLF together. A marked source line ending
  // in a literal CR has only the synthetic LF removed; Row.raw is authoritative.
  for (const [index, hunk] of parsed.hunks.entries()) {
    for (const row of file.hunks[index]?.rows ?? []) {
      if (!row.noNewline) continue;
      if (row.newLine !== undefined)
        parsed.additionLines[
          hunk.additionLineIndex + row.newLine - hunk.additionStart
        ] = row.raw.slice(1);
      if (row.oldLine !== undefined)
        parsed.deletionLines[
          hunk.deletionLineIndex + row.oldLine - hunk.deletionStart
        ] = row.raw.slice(1);
    }
  }
  return parsed;
}
