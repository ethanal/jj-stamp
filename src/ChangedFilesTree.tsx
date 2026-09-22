import { useLayoutEffect, useRef } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { FileTreeSquashAction } from "./FileTreeSquashAction";
import "./file-tree-squash.css";
import type { DiffFile } from "./types";

interface Props {
  files: DiffFile[];
  activePath?: string;
  disabled: boolean;
  squashDisabled: boolean;
  squashUnavailable?: string;
  onSquash: (path: string) => void;
  onSelect: (path: string) => void;
}

function directoryPaths(files: DiffFile[]): string[] {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      directories.add(parts.slice(0, i).join("/") + "/");
    }
  }
  return [...directories];
}

export function ChangedFilesTree(props: Props) {
  const container = useRef<HTMLElement>(null);
  // Trees owns its model for the lifetime of the component; callbacks must read
  // the latest optimistic state rather than the props from its construction.
  const current = useRef(props);
  const filesByPath = useRef(
    new Map(props.files.map((file) => [file.path, file])),
  );
  const syncing = useRef(false);
  const { model } = useFileTree({
    paths: props.files.map((file) => file.path),
    initialExpansion: "closed",
    initialExpandedPaths: directoryPaths(props.files),
    initialSelectedPaths: props.activePath ? [props.activePath] : [],
    // Compact directory-only chains into one row, e.g. src/components/ui.
    flattenEmptyDirectories: true,
    icons: "minimal",
    itemHeight: 28,
    density: "compact",
    search: false,
    renaming: false,
    dragAndDrop: false,
    // Counts are essential review metadata, not an optional trailing label.
    // Reserve their width and truncate the filename first in narrow sidebars.
    unsafeCSS: `
      [data-item-section="content"] { flex: 1 1 0; }
      [data-item-section="decoration"] { flex: 0 0 auto; font-size: 10px; }
      [data-item-section="decoration"] > span { display: inline-flex; gap: 4px; }
      /* Keep a permanent action lane so hover never hides counts or shifts text. */
      [data-item-type="file"] { padding-right: calc(var(--trees-item-padding-x) + 28px); }
    `,
    onSelectionChange(paths) {
      if (syncing.current) return;
      const { activePath, disabled, onSelect } = current.current;
      // Trees emits selection before moving focus on pointer activation.
      const path = paths.at(-1);
      const next =
        !disabled && path && filesByPath.current.has(path) ? path : activePath;
      // The review has one active file, even after a modifier-click. Folder
      // selection only expands/collapses the tree; it must not clear code picks.
      syncSelection(next);
      if (next && next !== activePath) onSelect(next);
    },
    renderRowDecoration({ item }) {
      const file = filesByPath.current.get(item.path);
      if (!file) return null;
      return {
        text: `+${file.additions}−${file.deletions}`,
        title: file.unsupported
          ? `${file.path} — read-only: ${file.unsupported}`
          : `${file.path} — ${file.additions} additions, ${file.deletions} deletions`,
        parts: [
          { text: `+${file.additions}`, color: "var(--added)" },
          { text: `−${file.deletions}`, color: "var(--removed)" },
          ...(file.unsupported ? [{ text: " ·", color: "var(--muted)" }] : []),
        ],
      };
    },
  });

  function syncSelection(path: string | undefined) {
    const wasSyncing = syncing.current;
    syncing.current = true;
    try {
      for (const selected of model.getSelectedPaths()) {
        if (selected !== path) model.getItem(selected)?.deselect();
      }
      if (path) model.getItem(path)?.select();
    } finally {
      syncing.current = wasSyncing;
    }
  }

  useLayoutEffect(() => {
    current.current = props;
    filesByPath.current = new Map(props.files.map((file) => [file.path, file]));
  });

  useLayoutEffect(() => {
    syncing.current = true;
    try {
      // resetPaths refreshes decorations too. Preserve existing folder choices
      // across count updates, refresh, squash and undo; open new folders.
      const expanded = directoryPaths(props.files).filter((path) => {
        const item = model.getItem(path);
        return !item || ("isExpanded" in item && item.isExpanded());
      });
      model.resetPaths(
        props.files.map((file) => file.path),
        {
          initialExpandedPaths: expanded,
        },
      );
      model.setGitStatus(
        props.files.flatMap((file): GitStatusEntry[] => {
          if (file.unsupported) return [];
          return [
            {
              path: file.path,
              status: file.patch.includes("new file mode")
                ? "added"
                : file.patch.includes("deleted file mode")
                  ? "deleted"
                  : "modified",
            },
          ];
        }),
      );
      syncSelection(current.current.activePath);
    } finally {
      syncing.current = false;
    }
  }, [model, props.files]);

  useLayoutEffect(() => {
    syncSelection(props.activePath);
    const activeFile = filesByPath.current.get(props.activePath ?? "");
    if (activeFile) {
      // A squash can remove the active file and move the diff to a file in a
      // collapsed branch. Reveal that new active file without stealing focus.
      for (const path of directoryPaths([activeFile])) {
        const item = model.getItem(path);
        if (item && "expand" in item) item.expand();
      }
      model.scrollToPath(activeFile.path, { focus: false });
    }
  }, [model, props.activePath]);

  return (
    <nav
      ref={container}
      className="changed-files"
      aria-label="Changed files"
      inert={props.disabled}
      aria-disabled={props.disabled}
    >
      <FileTree model={model} className="file-tree" />
      <FileTreeSquashAction
        container={container}
        model={model}
        files={props.files}
        disabled={props.disabled || props.squashDisabled}
        unavailable={props.squashUnavailable}
        onSquash={props.onSquash}
      />
    </nav>
  );
}
