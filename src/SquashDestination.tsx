import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { SquashIcon } from "./SquashIcon";
import type { Revision } from "./types";
import "./squash-destination.css";

export interface SquashDestinationProps {
  parent?: Revision | null;
  target?: Revision | null;
  mode: "parent" | "custom";

  canPick?: boolean;
  picking: boolean;
  disabled: boolean;
  parentReason?: string;

  error?: string;
  triggerRef: RefObject<HTMLButtonElement | null>;
  onParent: () => void;

  onPick: () => void;
}

/** Destination selection only: committing a menu choice never squashes lines. */
export function SquashDestination({
  parent,
  target,
  mode,

  canPick = true,
  picking,
  disabled,
  parentReason,

  error,
  triggerRef,
  onParent,

  onPick,
}: SquashDestinationProps) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const initialFocus = useRef<"first" | "last" | "checked">("checked");
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    left: 8,
    top: 8,
    maxHeight: 400,
  });
  const close = useCallback(
    (restoreFocus = false) => {
      setOpen(false);
      if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
    },
    [triggerRef],
  );
  const parentUnavailable =
    parentReason || (!parent ? "This revision has no squashable parent." : "");

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const trigger = triggerRef.current;
      const popup = menu.current;
      if (!trigger || !popup) return;
      const rect = trigger.getBoundingClientRect();
      let top = 0;
      let bottom = window.innerHeight;
      let left = 0;
      let right = window.innerWidth;
      // A trigger scrolled behind a clipping ancestor is not visible either.
      for (let node = trigger.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const bounds = node.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) {
          top = Math.max(top, bounds.top);
          bottom = Math.min(bottom, bounds.bottom);
        }
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) {
          left = Math.max(left, bounds.left);
          right = Math.min(right, bounds.right);
        }
      }
      if (
        rect.bottom <= top ||
        rect.top >= bottom ||
        rect.right <= left ||
        rect.left >= right
      ) {
        close();
        return;
      }
      const below = window.innerHeight - rect.bottom - 14;
      const above = rect.top - 14;
      const height = popup.scrollHeight;
      const flip = below < Math.min(height, 260) && above > below;
      const maxHeight = Math.max(48, flip ? above : below);
      setPosition({
        left: Math.max(
          8,
          Math.min(
            rect.right - popup.offsetWidth,
            window.innerWidth - popup.offsetWidth - 8,
          ),
        ),
        top: flip
          ? Math.max(8, rect.top - Math.min(height, maxHeight) - 6)
          : Math.max(8, rect.bottom + 6),
        maxHeight,
      });
    };
    place();
    window.addEventListener("resize", place);
    document.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      document.removeEventListener("scroll", place, true);
    };
  }, [open, close, triggerRef, parentReason, canPick, error]);

  useLayoutEffect(() => {
    if (!open) return;
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role^="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    const selected =
      initialFocus.current === "last"
        ? items.at(-1)
        : initialFocus.current === "checked"
          ? (items.find(
              (item) => item.getAttribute("aria-checked") === "true",
            ) ?? items[0])
          : items[0];
    selected?.focus({ preventScroll: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (
        event.target instanceof Node &&
        !menu.current?.contains(event.target) &&
        !triggerRef.current?.contains(event.target)
      )
        close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The first Escape belongs to the menu, never the underlying picker.
      event.preventDefault();
      event.stopImmediatePropagation();
      close(true);
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open, close, triggerRef]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);

  const choose = (action: () => void, unavailable = false) => {
    if (disabled || unavailable) return;
    close(true);
    action();
  };
  const targetId = target?.changeId.slice(0, 8) ?? "—";
  const needsDestination = !parent && canPick && !target && !picking;
  const stateLabel = picking
    ? "Choosing…"
    : mode === "parent"
      ? "Parent"
      : "Custom";
  const title = disabled
    ? "Destination selection is unavailable while work is queued, recovering, or navigating."
    : error ||
      (mode === "parent" ? parentUnavailable : "") ||
      `${stateLabel}: ${target?.changeId ?? "unavailable"}${target?.description ? `\n${target.description}` : ""}`;

  return (
    <div className="squash-destination">
      <button
        ref={triggerRef}
        type="button"
        className={`squash-destination-trigger${picking ? " is-picking" : ""}${error ? " has-error" : ""}`}
        aria-label={
          needsDestination ? "Squash into: choose revision" : undefined
        }
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        disabled={disabled}
        title={title}
        onClick={() => {
          initialFocus.current = "checked";
          setOpen(!open);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          event.stopPropagation();
          initialFocus.current = event.key === "ArrowUp" ? "last" : "first";
          setOpen(true);
        }}
      >
        <span className="squash-destination-trigger-label">
          {needsDestination ? (
            "Choose revision…"
          ) : (
            <>
              Squash into{" "}
              {mode === "parent" && !picking ? (
                "parent"
              ) : (
                <code>{targetId}</code>
              )}
            </>
          )}
        </span>
        <svg
          className="squash-destination-caret"
          aria-hidden="true"
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      {open &&
        !disabled &&
        createPortal(
          <div
            ref={menu}
            id={`${id}-menu`}
            className="squash-destination-menu"
            role="menu"
            aria-label="Squash destination"
            style={position}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Tab") {
                // Continue tabbing from the toolbar, not the body's portal.
                triggerRef.current?.focus({ preventScroll: true });
                close();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              event.preventDefault();
              event.stopPropagation();
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                  '[role^="menuitem"]:not(:disabled)',
                ),
              ];
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }}
          >
            <button
              type="button"
              role="menuitemradio"
              tabIndex={-1}
              aria-checked={mode === "parent"}
              disabled={!!parentUnavailable}
              title={parentUnavailable || parent?.description}
              onClick={() => choose(onParent, !!parentUnavailable)}
            >
              <span className="squash-destination-icon" aria-hidden="true">
                <SquashIcon />
              </span>
              <span className="squash-destination-option-label">
                <strong>Parent · {parent?.changeId.slice(0, 8) ?? "—"}</strong>
              </span>
              <span className="squash-destination-check" aria-hidden="true">
                {mode === "parent" && (
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m3.5 8 3 3 6-6" />
                  </svg>
                )}
              </span>
            </button>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={!canPick}
              title={
                !canPick
                  ? "No eligible destination revisions are available."
                  : undefined
              }
              onClick={() => choose(onPick, !canPick)}
            >
              <span className="squash-destination-icon" aria-hidden="true">
                <svg
                  aria-hidden="true"
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="m4 12 8-8M4 4h8v8" />
                </svg>
              </span>
              <span className="squash-destination-option-label">
                <strong>Choose revision in log…</strong>
              </span>
            </button>
            {error && (
              <p className="squash-destination-error" role="status">
                {error}
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
