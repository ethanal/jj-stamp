import { useCallback, useEffect, useId, useRef } from "react";
import "./shortcuts-dialog.css";

const groups = [
  {
    title: "Review & navigation",
    shortcuts: [
      ["s", "Squash selected changed lines into the parent"],
      ["u", "Undo the last squash"],
      ["r", "Refresh repository state"],
      ["f", "Focus the active file’s diff"],
      ["l", "Toggle the log sidebar (outside Vim mode)"],
      ["@", "Review the working-copy change"],
      ["↑ / ↓", "Review adjacent changes in the log (Vim: k / j)"],
      ["?", "Open this shortcut reference"],
      ["Escape", "Clear selection and errors; close an open search or dialog"],
    ],
  },
  {
    title: "Find in diff",
    shortcuts: [
      ["Ctrl / Cmd + f", "Open diff search"],
      ["F3 / Shift + F3", "Next / previous result while search is open"],
      ["Enter / Shift + Enter", "Next / previous result in the search field"],
      ["Escape", "Close search and return focus"],
    ],
  },
  {
    title: "Selection & code",
    shortcuts: [
      ["Click / drag", "Select a line / range of lines"],
      ["Shift + click / drag", "Extend the selection from its anchor"],
      ["Alt + drag", "Select native text instead of whole lines"],
      [
        "j / k · h / l",
        "Vim: move cursor / resize selection; switch panes / scroll stacked",
      ],
      [
        "Shift + V / Escape",
        "Vim: toggle visual-line selection / clear it and exit",
      ],
      ["Ctrl / Cmd + c", "Copy selected right-hand code, without diff markers"],
      ["e", "Open the hovered code line in Neovim"],
    ],
  },
  {
    title: "Resize panels",
    note: "Focus a resize handle first. Drag handles with the pointer to resize.",
    shortcuts: [
      ["← / →", "Resize a sidebar by 10px; split diff by 2%"],
      ["Shift + ← / →", "Resize a sidebar by 40px; split diff by 10%"],
      ["Home / End", "Jump to the handle’s minimum / maximum size"],
      ["Double-click", "Reset the split-diff divider to 50%"],
    ],
  },
];

export function ShortcutsDialog({ disabled }: { disabled: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const open = useCallback(() => {
    if (disabled || !dialog.current || dialog.current.open) return;
    previousFocus.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    dialog.current.showModal();
    closeButton.current?.focus({ preventScroll: true });
  }, [disabled]);
  const restoreFocus = () => {
    const previous = previousFocus.current;
    previousFocus.current = null;
    if (previous?.isConnected) previous.focus({ preventScroll: true });
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.key !== "?" ||
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        disabled ||
        document.querySelector("dialog[open]")
      )
        return;
      // Include shadow-DOM editors and inherited/empty contenteditable values.
      if (
        event
          .composedPath()
          .some(
            (node) =>
              node instanceof HTMLElement &&
              (node.closest("input, textarea, select, dialog") ||
                node.isContentEditable),
          )
      )
        return;
      event.preventDefault();
      open();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [disabled, open]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-controls={id}
        title="Keyboard shortcuts (?)"
        disabled={disabled}
        onClick={open}
      >
        shortcuts
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="settings-dialog shortcuts-dialog"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
        onClose={restoreFocus}
        onCancel={(event) => {
          event.preventDefault();
          dialog.current?.close();
        }}
        onKeyDown={(event) => {
          // Stop before document listeners, including CodeDiff’s Escape/editor
          // handlers and diff search. Keyup is isolated for its Alt cursor too.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            dialog.current?.close();
          } else if (event.key === "Tab") {
            const controls = event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not(:disabled), [tabindex="0"]',
            );
            const first = controls[0];
            const last = controls[controls.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
        onKeyUp={(event) => event.stopPropagation()}
      >
        <div className="settings-heading">
          <h2 id={`${id}-title`}>Keyboard shortcuts</h2>
          <button
            ref={closeButton}
            autoFocus
            aria-label="Close keyboard shortcuts"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <div
          className="shortcuts-content"
          role="region"
          aria-label="Shortcut reference"
          tabIndex={0}
        >
          <p id={`${id}-description`} className="shortcuts-description">
            Single-key shortcuts work outside text fields and dialogs. Review
            actions depend on the selection and repository state.
          </p>
          <div className="shortcuts-groups">
            {groups.map(({ title, shortcuts, note }) => (
              <section className="shortcuts-group" key={title}>
                <h3>{title}</h3>
                {note && <p className="shortcuts-note">{note}</p>}
                <dl>
                  {shortcuts.map(([keys, description]) => (
                    <div className="shortcut-entry" key={keys}>
                      <dt>
                        <kbd>{keys}</kbd>
                      </dt>
                      <dd>{description}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))}
          </div>
        </div>
      </dialog>
    </>
  );
}
