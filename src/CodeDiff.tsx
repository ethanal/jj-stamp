import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { FileDiff } from "@pierre/diffs/react";
import {
  parsePatchFiles,
  type FileDiff as DiffInstance,
  type FileDiffLoadedFiles,
  type SelectedLineRange,
} from "@pierre/diffs";
import type { DiffFile, Selections } from "./types";
import { selectionFromRange } from "./selection";

interface Point {
  line: number;
  side: "additions" | "deletions";
}
function pointFromElement(element: Element | null): Point | null {
  const row = element?.closest<HTMLElement>(
    "[data-line], [data-column-number]",
  );
  if (!row) return null;
  const line = Number(row.dataset.line ?? row.dataset.columnNumber);
  if (!Number.isSafeInteger(line) || line < 1) return null;
  return {
    line,
    side:
      row.dataset.lineType === "change-deletion" ? "deletions" : "additions",
  };
}
function deepElementAt(x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y);
  while (element?.shadowRoot) {
    const nested = element.shadowRoot.elementFromPoint(x, y);
    if (!nested || nested === element) break;
    element = nested;
  }
  return element;
}
const separatorCSS = `
[data-code] { padding-top: 0; padding-bottom: 0; }
[data-line], [data-column-number] { cursor: default; user-select: none; touch-action: none; }
[data-line][data-selected-line], [data-column-number][data-selected-line] { background: #29415a; }
[data-separator="line-info-basic"] { height: 25px; background: #20262e; }
[data-separator-wrapper] { font-size: 11px; }
[data-gutter] [data-separator-wrapper] { display: flex !important; flex-direction: row; width: max-content; align-items: center; background: #20262e; }
[data-gutter] [data-separator-content] { display: block; height: auto; padding: 0 8px; white-space: nowrap; }
[data-separator-wrapper][data-separator-multi-button] { grid-template-rows: 100%; grid-template-columns: 48px 48px auto; }
[data-expand-button] { border: none !important; min-width: 48px; width: 48px; flex-shrink: 0; font-size: 11px; }
[data-expand-button] svg { display: none; }
[data-expand-down]::before { content: '↑ 10'; }
[data-expand-up]::before { content: '↓ 10'; }
[data-expand-both]::before { content: '↕ 10'; }
[data-expand-all-button] { display: none !important; }
[data-separator-content] { font-size: 11px; color: #7e8895; }
`;

export function CodeDiff({
  file,
  version,
  range,
  disabled,
  onSelection,
  onDragging,
  onError,
  loadFile,
}: {
  file: DiffFile;
  version: string;
  range: SelectedLineRange | null;
  disabled: boolean;
  onSelection: (range: SelectedLineRange, selections: Selections) => void;
  onDragging: (dragging: boolean) => void;
  onError: (message: string) => void;
  loadFile: (path: string, version: string) => Promise<FileDiffLoadedFiles>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const instance = useRef<DiffInstance | null>(null);
  const stop = useRef<(() => void) | null>(null);
  const current = useRef({ file, range, disabled, onSelection, onDragging });
  current.current = { file, range, disabled, onSelection, onDragging };
  const fileDiff = useMemo(
    () =>
      parsePatchFiles(file.patch, `${version}:${file.path}`, true)[0]?.files[0],
    [file.patch, file.path, version],
  );
  useEffect(() => () => stop.current?.(), []);

  const select = useCallback((anchor: Point, end: Point) => {
    if (!instance.current) return;
    const next: SelectedLineRange = {
      start: anchor.line,
      side: anchor.side,
      end: end.line,
      endSide: end.side,
    };
    current.current.onSelection(
      next,
      selectionFromRange(
        current.current.file.hunks,
        next,
        instance.current.getLineIndex,
      ),
    );
  }, []);
  const pointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || current.current.disabled) return;
      const path = event.nativeEvent.composedPath();
      const element = path.find((item) => item instanceof Element) as
        Element | undefined;
      const point = pointFromElement(element ?? null);
      if (!point) return; // Expansion controls retain their own native events.
      event.preventDefault();
      root.current?.focus({ preventScroll: true });
      stop.current?.();
      const previous = current.current.range;
      const anchor: Point =
        event.shiftKey && previous
          ? { line: previous.start, side: previous.side ?? "additions" }
          : point;
      select(anchor, point);
      current.current.onDragging(true);
      const pointerId = event.pointerId;
      let lastX = event.clientX,
        lastY = event.clientY,
        frame = 0;
      const updateAt = (x: number, y: number) => {
        const element = deepElementAt(x, y);
        const host = element?.getRootNode();
        if (!(host instanceof ShadowRoot) || !root.current?.contains(host.host))
          return;
        const point = pointFromElement(element);
        if (point) select(anchor, point);
      };
      const move = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        event.preventDefault();
        lastX = event.clientX;
        lastY = event.clientY;
        updateAt(lastX, lastY);
      };
      const finish = (event: PointerEvent) => {
        if (event.pointerId !== pointerId) return;
        if (event.type === "pointerup") updateAt(event.clientX, event.clientY);
        cleanup();
      };
      const cleanup = () => {
        cancelAnimationFrame(frame);
        document.removeEventListener("pointermove", move);
        document.removeEventListener("pointerup", finish);
        document.removeEventListener("pointercancel", finish);
        window.removeEventListener("blur", cleanup);
        stop.current = null;
        current.current.onDragging(false);
      };
      const scroll = () => {
        const viewport = root.current?.closest<HTMLElement>(".viewer-scroll");
        if (viewport) {
          const box = viewport.getBoundingClientRect();
          const dy =
            lastY < box.top + 35 ? -12 : lastY > box.bottom - 35 ? 12 : 0;
          if (dy) {
            viewport.scrollTop += dy;
            updateAt(
              lastX,
              Math.max(box.top + 2, Math.min(box.bottom - 2, lastY)),
            );
          }
        }
        frame = requestAnimationFrame(scroll);
      };
      stop.current = cleanup;
      document.addEventListener("pointermove", move, { passive: false });
      document.addEventListener("pointerup", finish);
      document.addEventListener("pointercancel", finish);
      window.addEventListener("blur", cleanup);
      frame = requestAnimationFrame(scroll);
    },
    [select],
  );
  const options = useMemo(
    () => ({
      theme: "github-dark",
      themeType: "dark" as const,
      diffStyle: "unified" as const,
      diffIndicators: "classic" as const,
      disableFileHeader: true,
      enableLineSelection: false,
      hunkSeparators: "line-info-basic" as const,
      expansionLineCount: 10,
      collapsedContextThreshold: 0,
      lineHoverHighlight: "line" as const,
      unsafeCSS: separatorCSS,
      loadDiffFiles: async () => {
        try {
          return await loadFile(file.path, version);
        } catch (error) {
          onError((error as Error).message);
          throw error;
        }
      },
      onPostRender(
        node: HTMLElement,
        rendered: DiffInstance,
        phase: "mount" | "update" | "unmount",
      ) {
        if (phase === "unmount") {
          instance.current = null;
          return;
        }
        instance.current = rendered;
        node.shadowRoot
          ?.querySelectorAll<HTMLElement>("[data-expand-button]")
          .forEach((button) => {
            if (button.hasAttribute("data-fold-control")) return;
            button.setAttribute("data-fold-control", "");
            const direction = button.hasAttribute("data-expand-down")
              ? "above"
              : button.hasAttribute("data-expand-up")
                ? "below"
                : "above and below";
            button.setAttribute("aria-label", `Show 10 lines ${direction}`);
            button.setAttribute("title", `Show 10 lines ${direction}`);
            button.tabIndex = 0;
            button.addEventListener("keydown", (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                button.click();
              }
            });
          });
      },
    }),
    [file.path, version, loadFile, onError],
  );
  return (
    <div
      className="code-surface"
      ref={root}
      tabIndex={0}
      aria-label={`Diff for ${file.path}. Drag code to select lines; press s to squash.`}
      onPointerDown={pointerDown}
    >
      {fileDiff && (
        <FileDiff fileDiff={fileDiff} options={options} selectedLines={range} />
      )}
    </div>
  );
}
