type MetadataFile = {
  path: string;
  oldPath?: string;
  copyFrom?: string;
  oldMode?: "100644" | "100755";
  newMode?: "100644" | "100755";
  hunks: readonly unknown[];
  unsupported?: string;
};

/** Metadata is selected explicitly, never as a fake text hunk. */
export function metadataSelectionId(file: MetadataFile): string | undefined {
  if (file.unsupported || file.hunks.length) return;
  if (file.oldPath !== undefined)
    return `rename:${JSON.stringify([file.oldPath, file.path])}`;
  if (file.copyFrom !== undefined)
    return `copy:${JSON.stringify([file.copyFrom, file.path])}`;
  if (file.oldMode !== undefined && file.newMode !== undefined)
    return `mode:${JSON.stringify([file.path, file.oldMode, file.newMode])}`;
}

/** Backwards-compatible helper for metadata-only renames, including mode changes. */
export function pureRenameSelectionId(file: MetadataFile): string | undefined {
  return file.oldPath !== undefined ? metadataSelectionId(file) : undefined;
}

export function modeChangeLabel(file: MetadataFile): string | undefined {
  if (file.oldMode === undefined || file.newMode === undefined) return;
  return file.newMode === "100755"
    ? "Make executable (100644 → 100755)"
    : "Make non-executable (100755 → 100644)";
}

export function filePathLabel(file: MetadataFile): string {
  const path =
    file.copyFrom !== undefined
      ? `${file.copyFrom} → ${file.path} (copy)`
      : file.oldPath !== undefined
        ? `${file.oldPath} → ${file.path}`
        : file.path;
  const mode = modeChangeLabel(file);
  return mode ? `${path} — ${mode}` : path;
}
