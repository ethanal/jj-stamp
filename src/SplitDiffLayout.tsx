import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { clampSplitRatio, useSplitDiffPreference } from "./preferences";

/** One divider for the entire viewport, shared by every diff in all-files mode. */
export function SplitDiffLayout({
  active,
  disabled = false,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const [ratio, setRatio] = useSplitDiffPreference();
  const [width, setWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const finish = useCallback(() => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    if (pointerId !== undefined && handle.current?.hasPointerCapture(pointerId))
      handle.current.releasePointerCapture(pointerId);
    setResizing(false);
  }, []);
  useEffect(() => {
    const viewport = root.current?.querySelector<HTMLElement>(".viewer-scroll");
    if (!viewport) return;
    // Exclude the vertical scrollbar so the handle stays on the actual seam.
    const measure = () => setWidth(viewport.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => window.removeEventListener("blur", finish);
  }, [finish]);
  useEffect(() => {
    if (!active || disabled) finish();
  }, [active, disabled, finish]);
  return (
    <div
      ref={root}
      className={`split-diff-layout${resizing ? " is-resizing" : ""}`}
      style={{ "--split-diff-left": `${ratio}%` } as CSSProperties}
    >
      {children}
      {active && (
        <div
          ref={handle}
          className="split-diff-resize"
          style={{ left: (width * ratio) / 100 }}
          role="separator"
          aria-label="Resize split diff"
          aria-orientation="vertical"
          aria-valuemin={20}
          aria-valuemax={80}
          aria-valuenow={ratio}
          aria-valuetext={`${ratio}% left, ${100 - ratio}% right`}
          aria-disabled={disabled}
          tabIndex={disabled ? -1 : 0}
          title="Drag to resize; arrow keys to adjust; double-click to reset"
          onPointerDown={(event) => {
            if (disabled || event.button !== 0 || !root.current) return;
            event.preventDefault();
            drag.current = {
              pointerId: event.pointerId,
              offset:
                event.clientX -
                root.current.getBoundingClientRect().left -
                (width * ratio) / 100,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.currentTarget.focus({ preventScroll: true });
            setResizing(true);
          }}
          onPointerMove={(event) => {
            if (
              !drag.current ||
              drag.current.pointerId !== event.pointerId ||
              !root.current ||
              !width
            )
              return;
            setRatio(
              clampSplitRatio(
                ((event.clientX -
                  root.current.getBoundingClientRect().left -
                  drag.current.offset) /
                  width) *
                  100,
              ),
            );
          }}
          onPointerUp={(event) => {
            if (drag.current?.pointerId === event.pointerId) finish();
          }}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
          onDoubleClick={() => {
            if (!disabled) setRatio(50);
          }}
          onKeyDown={(event) => {
            if (disabled || event.ctrlKey || event.metaKey || event.altKey)
              return;
            let next: number;
            if (event.key === "Home") next = 20;
            else if (event.key === "End") next = 80;
            else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
              next =
                ratio +
                (event.key === "ArrowRight" ? 1 : -1) *
                  (event.shiftKey ? 10 : 2);
            else return;
            event.preventDefault();
            event.stopPropagation();
            setRatio(clampSplitRatio(next));
          }}
        />
      )}
    </div>
  );
}
