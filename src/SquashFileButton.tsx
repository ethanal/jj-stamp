import { SquashIcon } from "./SquashIcon";
import type { DiffFile } from "./types";

export function SquashFileButton({
  file,
  disabled,
  unavailable,
  onSquash,
}: {
  file: DiffFile;
  disabled: boolean;
  unavailable?: string;
  onSquash: (path: string) => void;
}) {
  // Read-only revisions are quiet while browsing; the keyboard action explains
  // why squashing is unavailable if the user explicitly attempts it.
  if (unavailable) return null;
  const reason = file.unsupported;
  return (
    <button
      className="squash-file"
      aria-label={`Squash file ${file.path}`}
      title={
        reason || "Squash all changes in this file into the immediate parent"
      }
      disabled={disabled || !!reason || !(file.additions + file.deletions)}
      onClick={() => onSquash(file.path)}
    >
      <SquashIcon />
    </button>
  );
}
