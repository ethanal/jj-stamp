import type { DiffFile } from "./types";

/** Display hints only: never infer mutation eligibility from a label or extension. */
export function unsupportedFileLabel(file: DiffFile): string | undefined {
  if (!file.unsupported) return undefined;
  // Inspect metadata, not code rows or extensions (a .png can contain text).
  const metadata = file.patch.split(/^@@/m, 1)[0];
  return /^(?:Binary files .+ differ|GIT binary patch)$/m.test(metadata)
    ? "Binary"
    : "Read-only";
}
