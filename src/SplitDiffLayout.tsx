import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ContextType,
  type ReactNode,
} from "react";
import { clampSplitRatio, useSplitDiffPreference } from "./preferences";

const SplitDiffContext = createContext<{
  ratio: number;
  setRatio: (ratio: number) => void;
  disabled: boolean;
} | null>(null);

/** Share proportions across files, but render a divider only on two-sided diffs. */
export function SplitDiffLayout({
  active,
  disabled = false,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const [ratio, setRatio] = useSplitDiffPreference();
  const value = useMemo(
    () => (active ? { ratio, setRatio, disabled } : null),
    [active, ratio, setRatio, disabled],
  );
  return (
    <SplitDiffContext.Provider value={value}>
      <div
        className="split-diff-layout"
        style={{ "--split-diff-left": `${ratio}%` } as CSSProperties}
      >
        {children}
      </div>
    </SplitDiffContext.Provider>
  );
}

export function SplitDiffResize() {
  const context = useContext(SplitDiffContext);
  return context ? <Divider {...context} /> : null;
}

function Divider({
  ratio,
  setRatio,
  disabled,
}: NonNullable<ContextType<typeof SplitDiffContext>>) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointerId: number; offset: number } | null>(null);
  const [resizing, setResizing] = useState(false);
  const finish = useCallback(() => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    if (pointerId !== undefined && handle.current?.hasPointerCapture(pointerId))
      handle.current.releasePointerCapture(pointerId);
    setResizing(false);
  }, []);
  useEffect(() => {
    window.addEventListener("blur", finish);
    return () => window.removeEventListener("blur", finish);
  }, [finish]);
  useEffect(() => {
    if (disabled) finish();
  }, [disabled, finish]);
  return (
    <div
      ref={handle}
      className={`split-diff-resize${resizing ? " is-resizing" : ""}`}
      style={{ left: `${ratio}%` }}
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
        const bounds =
          event.currentTarget.parentElement?.getBoundingClientRect();
        if (disabled || event.button !== 0 || !bounds) return;
        event.preventDefault();
        drag.current = {
          pointerId: event.pointerId,
          offset: event.clientX - bounds.left - (bounds.width * ratio) / 100,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.focus({ preventScroll: true });
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const bounds =
          event.currentTarget.parentElement?.getBoundingClientRect();
        if (
          !drag.current ||
          drag.current.pointerId !== event.pointerId ||
          !bounds?.width
        )
          return;
        setRatio(
          clampSplitRatio(
            ((event.clientX - bounds.left - drag.current.offset) /
              bounds.width) *
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
        if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
        let next: number;
        if (event.key === "Home") next = 20;
        else if (event.key === "End") next = 80;
        else if (event.key === "ArrowLeft" || event.key === "ArrowRight")
          next =
            ratio +
            (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 10 : 2);
        else return;
        event.preventDefault();
        event.stopPropagation();
        setRatio(clampSplitRatio(next));
      }}
    />
  );
}
