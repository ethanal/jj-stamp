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
  const reason = file.unsupported || unavailable;
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
