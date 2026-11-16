/** A metadata-only move has no text rows; select it explicitly, never as a fake hunk. */
export function pureRenameSelectionId(file: {
  path: string;
  oldPath?: string;
  hunks: readonly unknown[];
  unsupported?: string;
}): string | undefined {
  return file.oldPath !== undefined &&
    !file.unsupported &&
    file.hunks.length === 0
    ? `rename:${JSON.stringify([file.oldPath, file.path])}`
    : undefined;
}
