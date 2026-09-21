import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
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
import type { ColorScheme } from "./preferences";

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
      row.dataset.lineType === "change-deletion" ||
      row.closest("[data-deletions]")
        ? "deletions"
        : "additions",
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
[data-line], [data-column-number] { cursor: default; touch-action: none; }
[data-line] { user-select: text; -webkit-user-select: text; }
[data-column-number] { user-select: none; }
:host([data-fold-text-selection]) [data-line] { cursor: text; }
[data-expand-button] { cursor: pointer; }
[data-line][data-fold-selected], [data-column-number][data-fold-selected] { background: var(--diff-selection-bg, #16466b); }
[data-line][data-fold-context-selected], [data-column-number][data-fold-context-selected] { background: var(--diff-context-selection-bg, #172f46); }
[data-fold-in-range] {
  --selection-top: transparent;
  --selection-bottom: transparent;
  box-shadow: inset 0 1px var(--selection-top), inset 0 -1px var(--selection-bottom);
}
[data-fold-selection-start] { --selection-top: var(--diff-selection-border, #72b8e6); }
[data-fold-selection-end] { --selection-bottom: var(--diff-selection-border, #72b8e6); }
[data-column-number][data-fold-in-range] {
  color: var(--diff-selection-number-fg, #b7defb);
  box-shadow: inset 3px 0 var(--diff-selection-border, #79c9ff), inset 0 1px var(--selection-top), inset 0 -1px var(--selection-bottom);
}
[data-column-number][data-fold-selected] { color: var(--diff-selection-fg, #e3f3ff); font-weight: 500; }
[data-line][data-fold-in-range] { box-shadow: inset 0 1px var(--selection-top), inset 0 -1px var(--selection-bottom), inset -1px 0 var(--diff-selection-border, #386990); }
[data-separator="line-info-basic"] { height: 25px; background: var(--diff-separator-bg, #20262e); }
[data-separator-wrapper] { font-size: 11px; }
[data-gutter] [data-separator-wrapper] { display: flex !important; flex-direction: row; width: max-content; align-items: center; background: var(--diff-separator-bg, #20262e); }
[data-gutter] [data-separator-content] { display: block; height: auto; padding: 0 8px; white-space: nowrap; }
[data-separator-wrapper][data-separator-multi-button] { grid-template-rows: 100%; grid-template-columns: 48px 48px auto; }
[data-expand-button] { border: none !important; min-width: 48px; width: 48px; flex-shrink: 0; font-size: 11px; }
[data-expand-button] svg { display: none; }
[data-expand-down]::before { content: '↑ 10'; }
[data-expand-up]::before { content: '↓ 10'; }
[data-expand-both]::before { content: '↕ 10'; }
[data-expand-all-button] { display: none !important; }
[data-separator-content] { font-size: 11px; color: var(--diff-separator-fg, #7e8895); }
`;

// The renderer mutates its shadow DOM in a child layout effect. An effect
// cleanup runs too late; React's snapshot lifecycle precedes those mutations.
interface ScrollSnapshot {
  viewport: HTMLElement;
  top: number;
  left: number;
  codeLeft: number;
  anchors: { line: string; text: string; offset: number }[];
}
class StableDiffViewport extends Component<{
  patch: string;
  children: ReactNode;
}> {
  element: HTMLDivElement | null = null;
  getSnapshotBeforeUpdate(
    previous: Readonly<{ patch: string }>,
  ): ScrollSnapshot | null {
    if (previous.patch === this.props.patch) return null;
    const viewport = this.element?.closest<HTMLElement>(".viewer-scroll");
    const shadow = this.element?.querySelector("diffs-container")?.shadowRoot;
    if (!viewport || !shadow) return null;
    const top = viewport.getBoundingClientRect().top;
    // Squash changes the old side; surviving new-side coordinates stay stable.
    // Retain fallback anchors in case the first visible hunk disappears.
    const anchors = [...shadow.querySelectorAll<HTMLElement>("[data-line]")]
      .filter(
        (row) =>
          row.dataset.lineType !== "change-deletion" &&
          !row.closest("[data-deletions]") &&
          row.getBoundingClientRect().bottom > top,
      )
      .map((row) => ({
        line: row.dataset.line!,
        text: row.textContent ?? "",
        offset: row.getBoundingClientRect().top - top,
      }));
    return {
      viewport,
      top: viewport.scrollTop,
      left: viewport.scrollLeft,
      codeLeft: Math.max(
        0,
        ...[...shadow.querySelectorAll<HTMLElement>("[data-code]")].map(
          (code) => code.scrollLeft,
        ),
      ),
      anchors,
    };
  }
  componentDidUpdate(
    _previous: unknown,
    _state: unknown,
    snapshot: ScrollSnapshot | null,
  ) {
    if (!snapshot) return;
    const { viewport, anchors } = snapshot;
    const shadow = this.element?.querySelector("diffs-container")?.shadowRoot;
    const rows = new Map(
      [...(shadow?.querySelectorAll<HTMLElement>("[data-line]") ?? [])]
        .filter(
          (row) =>
            row.dataset.lineType !== "change-deletion" &&
            !row.closest("[data-deletions]"),
        )
        .map((row) => [row.dataset.line, row]),
    );
    let top = snapshot.top;
    for (const anchor of anchors) {
      const row = rows.get(anchor.line);
      if (!row || row.textContent !== anchor.text) continue;
      top =
        viewport.scrollTop +
        row.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        anchor.offset;
      break;
    }
    viewport.scrollTop = top;
    viewport.scrollLeft = snapshot.left;
    shadow?.querySelectorAll<HTMLElement>("[data-code]").forEach((code) => {
      code.scrollLeft = snapshot.codeLeft;
    });
  }
  render() {
    return (
      <div
        ref={(element) => {
          this.element = element;
        }}
        style={{ overflowAnchor: "none" }}
      >
        {this.props.children}
      </div>
    );
  }
}

export function CodeDiff({
  file,
  version,
  renderKey: _renderKey,
  style,
  colorScheme = "dark",
  selections,
  contextDisabled,
  range,
  disabled,
  onSelection,
  onDragging,
  onError,
  loadFile,
}: {
  file: DiffFile;
  version: string;
  renderKey: string;
  style: "unified" | "split";
  colorScheme?: ColorScheme;
  selections: Selections;
  contextDisabled: boolean;
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
  const container = useRef<HTMLElement | null>(null);
  const current = useRef({
    file,
    range,
    disabled,
    onSelection,
    onDragging,
    selections,
    style,
    contextDisabled,
  });
  current.current = {
    file,
    range,
    disabled,
    onSelection,
    onDragging,
    selections,
    style,
    contextDisabled,
  };
  const paint = useCallback(() => {
    const shadow = container.current?.shadowRoot;
    if (!shadow) return;
    const { file, selections, range, style } = current.current;
    const keys = new Set<string>();
    for (const hunk of file.hunks) {
      const selected = new Set(selections[hunk.id] ?? []);
      for (const row of hunk.rows)
        if (selected.has(row.index))
          keys.add(
            `${row.raw[0]}:${row.raw[0] === "-" ? row.oldLine : row.newLine}`,
          );
    }
    const axis = style === "split" ? 1 : 0;
    const start =
      range &&
      instance.current?.getLineIndex(range.start, range.side ?? "additions")?.[
        axis
      ];
    const end =
      range &&
      instance.current?.getLineIndex(
        range.end,
        range.endSide ?? range.side ?? "additions",
      )?.[axis];
    const low = start == null || end == null ? Infinity : Math.min(start, end);
    const high =
      start == null || end == null ? -Infinity : Math.max(start, end);
    const indexOf = (row: HTMLElement) => {
      const indices = row.dataset.lineIndex?.split(",").map(Number);
      return indices?.[axis] ?? indices?.[0] ?? NaN;
    };
    shadow
      .querySelectorAll<HTMLElement>("[data-line], [data-column-number]")
      .forEach((row) => {
        const kind =
          row.dataset.lineType === "change-deletion"
            ? "-"
            : row.dataset.lineType === "change-addition"
              ? "+"
              : "";
        const selected =
          !!kind &&
          keys.has(`${kind}:${row.dataset.line ?? row.dataset.columnNumber}`);
        const index = indexOf(row);
        // Context supplies continuous drag feedback but is never part of a squash.
        const context =
          !kind &&
          row.dataset.lineType?.startsWith("context") === true &&
          index >= low &&
          index <= high;
        row.toggleAttribute("data-fold-selected", selected);
        row.toggleAttribute("data-fold-context-selected", context);
        row.toggleAttribute("data-fold-in-range", selected || context);
        row.removeAttribute("data-fold-selection-start");
        row.removeAttribute("data-fold-selection-end");
      });
    for (const column of shadow.querySelectorAll<HTMLElement>("[data-code]")) {
      const gutters = new Map(
        [...column.querySelectorAll<HTMLElement>("[data-column-number]")].map(
          (row) => [row.dataset.lineIndex, row],
        ),
      );
      const mark = (row: HTMLElement, edge: "start" | "end") => {
        row.setAttribute(`data-fold-selection-${edge}`, "");
        gutters
          .get(row.dataset.lineIndex)
          ?.setAttribute(`data-fold-selection-${edge}`, "");
      };
      let previous: HTMLElement | null = null;
      let previousIndex = -Infinity;
      for (const row of column.querySelectorAll<HTMLElement>("[data-line]")) {
        const active = row.hasAttribute("data-fold-in-range"),
          index = indexOf(row);
        if (!active || index !== previousIndex + 1) {
          if (previous) mark(previous, "end");
          previous = null;
        }
        if (active) {
          if (!previous) mark(row, "start");
          previous = row;
          previousIndex = index;
        }
      }
      if (previous) mark(previous, "end");
    }
  }, []);
  useLayoutEffect(paint, [paint, selections, file, style, range]);
  const fileDiff = useMemo(
    () =>
      parsePatchFiles(file.patch, `${file.path}:${file.patch}`, true)[0]
        ?.files[0],
    [file.patch, file.path],
  );
  useEffect(() => () => stop.current?.(), []);
  useEffect(() => {
    const setTextCursor = (event: KeyboardEvent) => {
      container.current?.toggleAttribute(
        "data-fold-text-selection",
        event.shiftKey,
      );
    };
    const reset = () =>
      container.current?.removeAttribute("data-fold-text-selection");
    document.addEventListener("keydown", setTextCursor);
    document.addEventListener("keyup", setTextCursor);
    window.addEventListener("blur", reset);
    return () => {
      document.removeEventListener("keydown", setTextCursor);
      document.removeEventListener("keyup", setTextCursor);
      window.removeEventListener("blur", reset);
    };
  }, []);

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
        current.current.style,
      ),
    );
  }, []);
  const pointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Shift-drag must not preventDefault, focus, or emit squash selections.
      if (event.shiftKey || event.button !== 0 || current.current.disabled)
        return;
      const path = event.nativeEvent.composedPath();
      const element = path.find((item) => item instanceof Element) as
        Element | undefined;
      const point = pointFromElement(element ?? null);
      if (!point) return; // Expansion controls retain their own native events.
      event.preventDefault();
      root.current?.focus({ preventScroll: true });
      stop.current?.();
      const anchor = point;
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
      theme:
        colorScheme === "light"
          ? "github-light"
          : colorScheme === "dim"
            ? "github-dark-dimmed"
            : "github-dark",
      themeType:
        colorScheme === "light" ? ("light" as const) : ("dark" as const),
      diffStyle: style,
      diffIndicators: "classic" as const,
      disableFileHeader: true,
      enableLineSelection: false,
      hunkSeparators: "line-info-basic" as const,
      expansionLineCount: 10,
      collapsedContextThreshold: 0,
      lineHoverHighlight: "line" as const,
      unsafeCSS:
        separatorCSS +
        (contextDisabled
          ? "[data-expand-button], [data-unmodified-lines] { opacity: .35; cursor: wait; }"
          : ""),
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
        container.current = node;
        paint();
        node.shadowRoot
          ?.querySelectorAll<HTMLElement>("[data-expand-button]")
          .forEach((button) => {
            button.setAttribute(
              "aria-disabled",
              String(current.current.contextDisabled),
            );
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
                if (!current.current.contextDisabled) button.click();
              }
            });
          });
      },
    }),
    [
      file.path,
      version,
      loadFile,
      onError,
      style,
      colorScheme,
      contextDisabled,
      paint,
    ],
  );
  return (
    <div
      className="code-surface"
      ref={root}
      tabIndex={0}
      aria-label={`Diff for ${file.path}. Drag code to select lines; Shift-drag to select text; press s to squash.`}
      onPointerDown={pointerDown}
      onClickCapture={(event) => {
        if (
          current.current.contextDisabled &&
          event.nativeEvent
            .composedPath()
            .some(
              (item) =>
                item instanceof Element &&
                (item.hasAttribute("data-expand-button") ||
                  item.hasAttribute("data-unmodified-lines")),
            )
        ) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
    >
      <StableDiffViewport patch={file.patch}>
        {/* A changed patch starts with contracted context. Mere theme, layout,
            version, and queue updates keep the expanded renderer intact. */}
        {fileDiff && (
          <FileDiff
            key={file.patch}
            fileDiff={fileDiff}
            options={options}
            selectedLines={null}
          />
        )}
      </StableDiffViewport>
    </div>
  );
}
