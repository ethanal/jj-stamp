import { useEffect, useRef, useState } from "react";
import {
  clampTerminalHeight,
  terminalHeightFromKey,
  terminalPanelLimits,
} from "./terminal-panel-state";

export function TerminalResize({
  height,
  maximum,
  onResize,
  disabled,
  controls,
}: {
  height: number;
  maximum: number;
  onResize: (height: number) => void;
  disabled: boolean;
  controls: string;
}) {
  const drag = useRef<{
    pointerId: number;
    y: number;
    height: number;
    element: HTMLDivElement;
  } | null>(null);
  const [resizing, setResizing] = useState(false);
  const finish = () => {
    const previous = drag.current;
    drag.current = null;
    if (previous?.element.hasPointerCapture(previous.pointerId))
      previous.element.releasePointerCapture(previous.pointerId);
    setResizing(false);
  };
  useEffect(() => {
    if (disabled) finish();
    return finish;
  }, [disabled]);
  return (
    <div
      className={`terminal-resize${resizing ? " is-resizing" : ""}`}
      role="separator"
      aria-label="Resize terminal"
      aria-orientation="horizontal"
      aria-controls={controls}
      aria-valuemin={terminalPanelLimits.min}
      aria-valuemax={maximum}
      aria-valuenow={height}
      aria-valuetext={`${height} pixels`}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      title="Drag to resize; use Up/Down for 10px steps, Shift for 40px"
      onPointerDown={(event) => {
        if (disabled || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const element = event.currentTarget;
        drag.current = {
          pointerId: event.pointerId,
          y: event.clientY,
          height: element.parentElement!.getBoundingClientRect().height,
          element,
        };
        element.setPointerCapture(event.pointerId);
        element.focus({ preventScroll: true });
        setResizing(true);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (disabled || !start || start.pointerId !== event.pointerId) return;
        onResize(
          clampTerminalHeight(start.height + start.y - event.clientY, maximum),
        );
      }}
      onPointerUp={(event) => {
        if (drag.current?.pointerId === event.pointerId) finish();
      }}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
      onKeyDown={(event) => {
        if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;
        const next = terminalHeightFromKey(
          height,
          maximum,
          event.key,
          event.shiftKey,
        );
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        onResize(next);
      }}
    />
  );
}
