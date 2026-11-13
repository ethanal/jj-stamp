import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import "./goto-revision.css";

interface GoToRevisionProps {
  disabled: boolean;
  vimMode: boolean;
  onSubmit: (id: string) => Promise<boolean>;
}

function modalOpen() {
  return !!document.querySelector('dialog[open], [aria-modal="true"]');
}

function typing(event: KeyboardEvent) {
  return event
    .composedPath()
    .some(
      (node) =>
        node instanceof HTMLElement &&
        (node.closest("input, textarea, select, dialog") ||
          node.isContentEditable),
    );
}

export function GoToRevision({
  disabled,
  vimMode,
  onSubmit,
}: GoToRevisionProps) {
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const popover = useRef<HTMLFormElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const restoreFocusTarget = useRef<HTMLElement | null>(null);
  const opened = useRef(false);
  const submitting = useRef(false);
  const session = useRef(0);
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const close = useCallback((restoreFocus = true) => {
    session.current++;
    opened.current = false;
    submitting.current = false;
    setOpen(false);
    setBusy(false);
    setValue("");
    setError("");
    const previous = previousFocus.current;
    previousFocus.current = null;
    restoreFocusTarget.current = restoreFocus ? previous : null;
  }, []);

  const show = useCallback(() => {
    if (disabled || opened.current || modalOpen()) return;
    restoreFocusTarget.current = null;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    opened.current = true;
    setOpen(true);
  }, [disabled]);

  useEffect(() => {
    if (open) input.current?.focus({ preventScroll: true });
  }, [open]);

  useLayoutEffect(() => {
    const previous = restoreFocusTarget.current;
    if (open || !previous) return;
    if (!previous.isConnected) {
      restoreFocusTarget.current = null;
      return;
    }
    // Parent pending state may still disable the trigger when submit resolves.
    // Restore after React commits its enabled state, not synchronously in close.
    if (previous.matches(":disabled")) return;
    restoreFocusTarget.current = null;
    previous.focus({ preventScroll: true });
  }, [open, disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const anchor = root.current?.getBoundingClientRect();
      const panel = popover.current;
      if (!anchor || !panel) return;
      const bounds = panel.getBoundingClientRect();
      panel.style.left = `${Math.max(
        12,
        Math.min(
          anchor.right - bounds.width,
          window.innerWidth - bounds.width - 12,
        ),
      )}px`;
      panel.style.top = `${Math.max(
        12,
        Math.min(anchor.bottom + 6, window.innerHeight - bounds.height - 12),
      )}px`;
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, error]);

  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      clearTimeout(pending);
      pending = undefined;
    };
    const key = (event: KeyboardEvent) => {
      const secondG = pending !== undefined;
      cancel();
      if (
        disabled ||
        opened.current ||
        event.defaultPrevented ||
        event.key !== "g" ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing ||
        event.keyCode === 229 ||
        modalOpen() ||
        typing(event)
      )
        return;
      if (!vimMode) {
        event.preventDefault();
        show();
      } else if (!secondG) {
        // Observe before CodeDiff's bubbling listener, but never consume its
        // prefix: both keys of gg must reach the existing Vim motion handler.
        const focus = document.activeElement;
        pending = setTimeout(() => {
          pending = undefined;
          if (document.activeElement === focus && !modalOpen()) show();
        }, 300);
      }
    };
    document.addEventListener("keydown", key, true);
    document.addEventListener("pointerdown", cancel, true);
    document.addEventListener("focusin", cancel);
    window.addEventListener("blur", cancel);
    return () => {
      cancel();
      document.removeEventListener("keydown", key, true);
      document.removeEventListener("pointerdown", cancel, true);
      document.removeEventListener("focusin", cancel);
      window.removeEventListener("blur", cancel);
    };
  }, [disabled, show, vimMode]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!opened.current) return;
      if (!event.composedPath().includes(root.current!)) close(false);
    };
    const focus = (event: FocusEvent) => {
      if (!opened.current) return;
      if (!event.composedPath().includes(root.current!)) close(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", focus);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", focus);
    };
  }, [close, open]);

  useEffect(
    () => () => {
      // Ignore a promise that settles after dismissal or unmount.
      session.current++;
    },
    [],
  );

  async function submit() {
    const revision = value.trim();
    if (disabled || submitting.current || !revision) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    const request = session.current;
    try {
      const accepted = await onSubmit(revision);
      if (request === session.current && accepted) close();
    } catch (cause) {
      if (request === session.current)
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to open revision. Try again.",
        );
    } finally {
      if (request === session.current) {
        submitting.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <span ref={root} className="goto-revision">
      <button
        type="button"
        className="action-button goto-revision-trigger"
        title="Go to an ID or revset (g)"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
      >
        Go to
      </button>
      {open && (
        <form
          ref={popover}
          id={id}
          role="dialog"
          aria-label="Go to revision"
          aria-busy={busy}
          className="goto-revision-popover"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              if (event.key === "Enter") event.preventDefault();
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              close();
            } else if (
              event.key === "Enter" &&
              (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)
            ) {
              event.preventDefault();
            }
          }}
          onKeyUp={(event) => event.stopPropagation()}
        >
          <label htmlFor={`${id}-input`}>ID or revset</label>
          <div className="goto-revision-entry">
            <input
              ref={input}
              id={`${id}-input`}
              value={value}
              placeholder="Enter an ID or revset, e.g. @-"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              readOnly={busy}
              disabled={disabled && !busy}
              aria-describedby={error ? `${id}-error` : undefined}
              onChange={(event) => setValue(event.target.value)}
            />
            <button
              className="action-button"
              type="submit"
              disabled={disabled || busy || !value.trim()}
            >
              {busy ? "Opening…" : "Go"}
            </button>
          </div>
          {error && (
            <p id={`${id}-error`} role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </span>
  );
}
