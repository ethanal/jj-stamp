import { useId, useRef, type ReactNode } from "react";
import type { Revision } from "./types";
import {
  colorSchemes,
  parseColorScheme,
  type ColorScheme,
} from "./preferences";

function shortChangeId({ changeId, changeIdPrefix }: Revision): string {
  const length =
    changeIdPrefix && changeId.startsWith(changeIdPrefix)
      ? Math.max(8, changeIdPrefix.length)
      : 8;
  return changeId.slice(0, length);
}
export function revisionPageTitle(
  source: Revision | undefined,
  repoPath: string | undefined,
): string {
  return source && repoPath
    ? `${source.description || "(no description)"} (${shortChangeId(source)} ${repoPath})`
    : "jj-stamp";
}
export function ChangeId({ revision }: { revision?: Revision }) {
  return <>{revision ? shortChangeId(revision) : "—"}</>;
}
export function RevisionHeading({
  source,
  children,
}: {
  source?: Revision;
  children?: ReactNode;
}) {
  return (
    <div className="revision-info" aria-label="Reviewed revision">
      <code
        className="change-id"
        aria-label="Current change ID"
        title={source?.changeId}
      >
        <ChangeId revision={source} />
      </code>
      <span className="source-description" title={source?.description}>
        {source?.description ||
          (source ? "(no description)" : "Opening repository…")}
      </span>
      <code
        className="commit-id"
        aria-label="Current commit ID"
        title={source?.commitId}
      >
        {source?.commitId.slice(0, 12) ?? "—"}
      </code>
      {children}
    </div>
  );
}
export function ColorSchemePicker({
  value,
  onChange,
  disabled,
}: {
  value: ColorScheme;
  onChange: (scheme: ColorScheme) => void;
  disabled: boolean;
}) {
  return (
    <label className="color-scheme-picker">
      <span>Color scheme</span>
      <select
        aria-label="Color scheme"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(parseColorScheme(event.target.value))}
      >
        {Object.entries(colorSchemes).map(([scheme, { label }]) => (
          <option key={scheme} value={scheme}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function SettingsDialog({
  colorScheme,
  onColorSchemeChange,
  hoverSidebars,
  onHoverSidebarsChange,
  vimMode,
  onVimModeChange,
  disabled,
}: {
  colorScheme: ColorScheme;
  onColorSchemeChange: (scheme: ColorScheme) => void;
  vimMode: boolean;
  onVimModeChange: (enabled: boolean) => void;
  hoverSidebars: boolean;
  onHoverSidebarsChange: (enabled: boolean) => void;
  disabled: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  return (
    <>
      <button
        className="action-button"
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => dialog.current?.showModal()}
        disabled={disabled}
      >
        Settings
      </button>
      <dialog
        ref={dialog}
        id={id}
        className="settings-dialog preferences-dialog"
        aria-labelledby={`${id}-title`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Tab") return;
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select:not(:disabled), input:not(:disabled)",
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
        }}
      >
        <div className="settings-heading">
          <h2 id={`${id}-title`}>Settings</h2>
          <button
            autoFocus
            aria-label="Close settings"
            onClick={() => dialog.current?.close()}
          >
            ×
          </button>
        </div>
        <section
          className="settings-section"
          aria-labelledby={`${id}-appearance`}
        >
          <h3 id={`${id}-appearance`}>Appearance</h3>
          <ColorSchemePicker
            value={colorScheme}
            onChange={onColorSchemeChange}
            disabled={disabled}
          />
        </section>
        <section
          className="settings-section"
          aria-labelledby={`${id}-behavior`}
        >
          <h3 id={`${id}-behavior`}>Behavior</h3>
          <div className="settings-rows">
            <label className="settings-checkbox">
              <span className="settings-copy">
                <span id={`${id}-hover-label`}>Reveal sidebars on hover</span>
                <span className="settings-help" id={`${id}-hover-help`}>
                  Peek at Files or Log while collapsed.
                </span>
              </span>
              <input
                type="checkbox"
                aria-labelledby={`${id}-hover-label`}
                aria-describedby={`${id}-hover-help`}
                checked={hoverSidebars}
                disabled={disabled}
                onChange={(event) =>
                  onHoverSidebarsChange(event.target.checked)
                }
              />
            </label>
            <label className="settings-checkbox">
              <span className="settings-copy">
                <span id={`${id}-vim-label`}>Vim mode</span>
                <span className="settings-help" id={`${id}-vim-help`}>
                  Navigate and select lines with Vim keys.
                </span>
              </span>
              <input
                type="checkbox"
                aria-labelledby={`${id}-vim-label`}
                aria-describedby={`${id}-vim-help`}
                checked={vimMode}
                disabled={disabled}
                onChange={(event) => onVimModeChange(event.target.checked)}
              />
            </label>
          </div>
        </section>
      </dialog>
    </>
  );
}
