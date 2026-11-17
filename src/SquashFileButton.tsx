import { SquashIcon } from "./SquashIcon";
import type { DiffFile } from "./types";
import { pureRenameSelectionId } from "./file-selection";

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
  const reason = file.unsupported || file.squashUnsupported;
  return (
    <button
      className="squash-file"
      aria-label={`Squash file ${file.path}`}
      title={
        reason ||
        (file.oldPath
          ? file.hunks.length
            ? "Squash the rename and all text edits into the selected destination"
            : "Squash the rename into the selected destination"
          : "Squash all changes in this file into the selected destination")
      }
      disabled={
        disabled ||
        !!reason ||
        (!(file.additions + file.deletions) &&
          pureRenameSelectionId(file) === undefined)
      }
      onClick={() => onSquash(file.path)}
    >
      <SquashIcon />
    </button>
  );
}
