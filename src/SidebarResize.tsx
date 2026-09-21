import { useRef, useState } from "react";
import {
  clampSidebarWidth,
  resizeFromKey,
  sidebarLimits,
  type SidebarSide,
} from "./preferences";

export function SidebarResize({
  side,
  width,
  onResize,
  disabled = false,
}: {
  side: SidebarSide;
  width: number;
  onResize: (width: number) => void;
  disabled?: boolean;
}) {
  const drag = useRef<{ pointerId: number; x: number; width: number } | null>(
    null,
  );
  const [resizing, setResizing] = useState(false);
  const finish = () => {
    drag.current = null;
    setResizing(false);
  };
  return (
    <div
      className={`sidebar-resize ${side}-resize${resizing ? " is-resizing" : ""}`}
      role="separator"
      aria-label={`Resize ${side} sidebar`}
      aria-orientation="vertical"
      aria-controls={`${side}-sidebar-content`}
      aria-valuemin={sidebarLimits[side].min}
      aria-valuemax={sidebarLimits[side].max}
      aria-valuenow={width}
      aria-valuetext={`${width} pixels`}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title="Drag to resize; use arrow keys for 10px steps, Shift for 40px"
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        const element = event.currentTarget;
        // Start from the rendered width, including any narrow-window clamp.
        const actualWidth =
          element.parentElement?.getBoundingClientRect().width ?? width;
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          width: actualWidth,
        };
        element.setPointerCapture(event.pointerId);
        element.focus({ preventScroll: true });
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start || start.pointerId !== event.pointerId) return;
        onResize(
          clampSidebarWidth(
            side,
            start.width +
              (event.clientX - start.x) * (side === "files" ? 1 : -1),
          ),
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId !== event.pointerId) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
        const next = resizeFromKey(side, width, event.key, event.shiftKey);
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(next);
      }}
    />
  );
}
