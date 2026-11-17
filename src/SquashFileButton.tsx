import { SquashIcon } from "./SquashIcon";
import type { DiffFile } from "./types";
import { metadataSelectionId, modeChangeLabel } from "./file-selection";

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
  const changes = [
    ...(file.copyFrom !== undefined
      ? ["the copy (leaving its source unchanged)"]
      : []),
    ...(file.oldPath !== undefined ? ["the rename"] : []),
    ...(modeChangeLabel(file)
      ? [
          `the change to ${file.newMode === "100755" ? "executable" : "non-executable"} mode`,
        ]
      : []),
    ...(file.hunks.length ? ["all text edits"] : []),
  ];
  return (
    <button
      className="squash-file"
      aria-label={`Squash file ${file.path}`}
      title={
        reason ||
        (changes.length
          ? `Squash ${changes.join(" and ")} into the selected destination`
          : "Squash all changes in this file into the selected destination")
      }
      disabled={
        disabled ||
        !!reason ||
        (!(file.additions + file.deletions) &&
          metadataSelectionId(file) === undefined)
      }
      onClick={() => onSquash(file.path)}
    >
      <SquashIcon />
    </button>
  );
}
