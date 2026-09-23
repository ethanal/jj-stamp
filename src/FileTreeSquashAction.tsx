import { SquashIcon } from "./SquashIcon";
import { useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { FileTree } from "@pierre/trees";
import type { DiffFile } from "./types";

interface Anchor {
  path: string;
  top: number;
  right: number;
  height: number;
}

/** beta.6 rows are buttons in a shadow root; decorations cannot contain controls.
 * Keep the real action button outside the tree, like its built-in menu trigger.
 * In particular, never focus/select a row on pointer activation of this action.
 */
export function FileTreeSquashAction({
  container,
  model,
  files,
  disabled,
  unavailable,
  onSquash,
}: {
  container: RefObject<HTMLElement | null>;
  model: FileTree;
  files: DiffFile[];
  disabled: boolean;
  unavailable?: string;
  onSquash: (path: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const anchorRow = useRef<HTMLElement | null>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);

  useEffect(() => {
    const attach = () => {
      const nav = container.current;
      const root = model.getFileTreeContainer()?.shadowRoot;
      if (!nav || !root) return;
      // undefined means the pointer is outside the tree; null means blank space
      // or a folder, which must not acquire a file action.
      let hovered: HTMLElement | null | undefined;
      let frame = 0;
      const rowFrom = (event: Event) =>
        event
          .composedPath()
          .find(
            (node): node is HTMLElement =>
              node instanceof HTMLElement &&
              node.dataset.itemType !== undefined,
          ) ?? null;
      const update = () => {
        const focused = root.activeElement;
        const row =
          document.activeElement === button.current
            ? anchorRow.current
            : hovered !== undefined
              ? hovered
              : focused instanceof HTMLElement
                ? focused
                : null;
        if (
          !row?.isConnected ||
          row.dataset.itemType !== "file" ||
          row.dataset.itemParked
        ) {
          setAnchor(null);
          return;
        }
        const path = row.dataset.itemPath;
        if (!path) return;
        const rect = row.getBoundingClientRect();
        const bounds = nav.getBoundingClientRect();
        // Never leave an action floating over another row after virtual scrolling.
        if (
          rect.top < bounds.top ||
          rect.bottom > bounds.bottom ||
          !rect.height
        ) {
          setAnchor(null);
          return;
        }
        const coveringRow = root
          .elementFromPoint(rect.left + 1, rect.top + rect.height / 2)
          ?.closest("[data-item-type]");
        if (coveringRow && coveringRow !== row) {
          setAnchor(null);
          return;
        }
        anchorRow.current = row;
        const next = {
          path,
          top: rect.top - bounds.top,
          right: bounds.right - rect.right + 3,
          height: rect.height,
        };
        setAnchor((previous) =>
          previous?.path === next.path &&
          previous.top === next.top &&
          previous.right === next.right &&
          previous.height === next.height
            ? previous
            : next,
        );
      };
      const schedule = () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(update);
      };
      const pointer = (event: PointerEvent) => {
        if (event.composedPath().includes(button.current as EventTarget))
          return;
        hovered = rowFrom(event);
        update();
      };
      const leave = () => {
        hovered = undefined;
        update();
      };
      const focus = (event: FocusEvent) => {
        if (event.target !== button.current) hovered = undefined;
        update();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === "Tab" && event.target !== button.current) {
          // Pointer hover must not redirect a keyboard user's row action.
          hovered = undefined;
          flushSync(update);
        }
      };
      const scroll = () => {
        hovered = undefined;
        schedule();
      };
      nav.addEventListener("pointerover", pointer);
      nav.addEventListener("pointermove", pointer);
      nav.addEventListener("pointerleave", leave);
      nav.addEventListener("focusin", focus);
      nav.addEventListener("focusout", schedule);
      nav.addEventListener("keydown", key, true);
      root.addEventListener("scroll", scroll, true);
      const resize = new ResizeObserver(schedule);
      resize.observe(nav);
      // Rows may be replaced/recycled by resets, collapsing, or virtualization.
      const mutations = new MutationObserver(schedule);
      mutations.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      schedule();
      return () => {
        cancelAnimationFrame(frame);
        resize.disconnect();
        mutations.disconnect();
        nav.removeEventListener("pointerover", pointer);
        nav.removeEventListener("pointermove", pointer);
        nav.removeEventListener("pointerleave", leave);
        nav.removeEventListener("focusin", focus);
        nav.removeEventListener("focusout", schedule);
        nav.removeEventListener("keydown", key, true);
        root.removeEventListener("scroll", scroll, true);
      };
    };
    // FileTree mounts its shadow root on a layout-driven second render.
    let cleanup: (() => void) | undefined;
    let mountFrame = 0;
    const mount = () => {
      cleanup = attach();
      if (!cleanup) mountFrame = requestAnimationFrame(mount);
    };
    mount();
    return () => {
      cancelAnimationFrame(mountFrame);
      cleanup?.();
    };
  }, [container, model]);

  const file = files.find((file) => file.path === anchor?.path);
  if (!anchor || !file) return null;
  const hasChanges = file.hunks.some((hunk) =>
    hunk.rows.some((row) => row.raw[0] === "+" || row.raw[0] === "-"),
  );
  const reason =
    file.unsupported ||
    unavailable ||
    (!hasChanges ? "This file has no changed lines to squash" : undefined);
  return (
    <button
      ref={button}
      type="button"
      className="file-tree-squash"
      style={{
        top: anchor.top,
        right: anchor.right,
        height: anchor.height - 4,
      }}
      aria-label={`Squash file ${file.path}`}
      title={
        reason || "Squash all changes in this file into the immediate parent"
      }
      disabled={disabled || !!reason}
      onPointerDown={(event) => {
        // Preserve the active tree/diff focus when squashing a different file.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
        if (!disabled && !reason) onSquash(file.path);
      }}
      onKeyDown={(event) => {
        // Enter/Space keep native button activation. Tab reaches this action
        // from the focused row; Escape/Shift+Tab return without selecting it.
        event.stopPropagation();
        if (event.key === "Escape" || (event.key === "Tab" && event.shiftKey)) {
          event.preventDefault();
          anchorRow.current?.focus({ preventScroll: true });
        }
      }}
    >
      <SquashIcon />
    </button>
  );
}
