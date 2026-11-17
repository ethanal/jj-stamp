import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { Revision } from "./types";
import { useDialogBackdropDismiss } from "./useDialogBackdropDismiss";
import {
  colorSchemes,
  fontSizeLimits,
  parseFontSize,
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
export function repositoryPageTitle(repoPath: string | undefined): string {
  const name = repoPath?.split(/[\\/]/).filter(Boolean).at(-1);
  return name ? `jj-stamp: ${name}` : "jj-stamp";
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
  logRevset,
  onLogRevsetChange,
  fontSize,
  onFontSizeChange,
  colorScheme,
  onColorSchemeChange,
  hoverSidebars,
  onHoverSidebarsChange,
  vimMode,
  onVimModeChange,
  shell,
  defaultShell,
  defaultShellError,
  onShellChange,
  persistenceError,
  disabled,
}: {
  logRevset: string;
  onLogRevsetChange: (revset: string) => Promise<void>;
  fontSize: number;
  onFontSizeChange: (size: number) => void;
  colorScheme: ColorScheme;
  onColorSchemeChange: (scheme: ColorScheme) => void;
  vimMode: boolean;
  onVimModeChange: (enabled: boolean) => void;
  shell: string;
  defaultShell?: string;
  defaultShellError?: string;
  onShellChange: (shell: string) => void;
  hoverSidebars: boolean;
  onHoverSidebarsChange: (enabled: boolean) => void;
  persistenceError?: string;
  disabled: boolean;
}) {
  const [revsetDraft, setRevsetDraft] = useState(logRevset);
  const [shellDraft, setShellDraft] = useState(shell);
  const savedShell = useRef(shell);
  useEffect(() => {
    const previous = savedShell.current;
    savedShell.current = shell;
    setShellDraft((draft) => (draft === previous ? shell : draft));
  }, [shell]);
  const savedRevset = useRef(logRevset);
  useEffect(() => {
    const previous = savedRevset.current;
    savedRevset.current = logRevset;
    // Follow other windows/disk edits without discarding an unsaved draft.
    setRevsetDraft((draft) => (draft === previous ? logRevset : draft));
  }, [logRevset]);
  const [revsetError, setRevsetError] = useState("");
  const [savingRevset, setSavingRevset] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropDismiss = useDialogBackdropDismiss();
  const id = useId();
  return (
    <>
      <button
        className="action-button"
        aria-haspopup="dialog"
        aria-controls={id}
        onClick={() => {
          setRevsetDraft(logRevset);
          setRevsetError("");
          setShellDraft(shell);
          dialog.current?.showModal();
        }}
        disabled={disabled}
      >
        Settings
      </button>
      <dialog
        {...backdropDismiss}
        ref={dialog}
        id={id}
        className="settings-dialog preferences-dialog"
        aria-labelledby={`${id}-title`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== "Tab") return;
          const controls = event.currentTarget.querySelectorAll<HTMLElement>(
            "button:not(:disabled), select:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
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
        {persistenceError && (
          <p className="settings-help" role="status">
            {persistenceError}
          </p>
        )}
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
          <label className="font-size-picker">
            <span className="font-size-heading">
              <span>Font size</span>
              <span className="font-size-value" aria-hidden="true">
                {fontSize}px
                {fontSize === fontSizeLimits.initial ? " (default)" : ""}
              </span>
            </span>
            <input
              type="range"
              min={fontSizeLimits.min}
              max={fontSizeLimits.max}
              step={1}
              aria-label="Font size"
              aria-valuetext={`${fontSize} pixels${fontSize === fontSizeLimits.initial ? " (default)" : ""}`}
              value={fontSize}
              disabled={disabled}
              onChange={(event) =>
                onFontSizeChange(parseFontSize(event.target.value))
              }
            />
          </label>
        </section>
        <form
          className="settings-section log-revset-settings"
          onSubmit={async (event) => {
            event.preventDefault();
            if (savingRevset || disabled) return;
            setSavingRevset(true);
            setRevsetError("");
            try {
              await onLogRevsetChange(revsetDraft.trim());
              setRevsetDraft(revsetDraft.trim());
            } catch (error) {
              setRevsetError(
                error instanceof Error ? error.message : String(error),
              );
            } finally {
              setSavingRevset(false);
            }
          }}
        >
          <h3>
            <label htmlFor={`${id}-revset`}>jj log revset</label>
          </h3>
          <textarea
            id={`${id}-revset`}
            value={revsetDraft}
            rows={4}
            maxLength={4096}
            required
            disabled={disabled || savingRevset}
            onChange={(event) => setRevsetDraft(event.target.value)}
          />
          {revsetError && (
            <p className="revset-error" role="alert">
              {revsetError}
            </p>
          )}
          <div className="revset-actions">
            <button
              type="submit"
              disabled={
                disabled ||
                savingRevset ||
                !revsetDraft.trim() ||
                revsetDraft.trim() === logRevset
              }
            >
              {savingRevset ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
        <form
          className="settings-section shell-settings"
          onSubmit={(event) => {
            event.preventDefault();
            if (disabled) return;
            onShellChange(shellDraft.trim());
            setShellDraft(shellDraft.trim());
          }}
        >
          <h3>
            <label htmlFor={`${id}-shell`}>Terminal shell</label>
          </h3>
          <input
            id={`${id}-shell`}
            type="text"
            value={shellDraft}
            placeholder={
              defaultShell
                ? `Default: ${defaultShell}`
                : defaultShellError
                  ? "Default shell unavailable"
                  : "Loading default shell…"
            }
            maxLength={4096}
            disabled={disabled}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setShellDraft(event.target.value)}
          />
          {defaultShellError && (
            <p className="revset-error" role="status">
              {defaultShellError}
            </p>
          )}
          <div className="revset-actions">
            <button
              type="submit"
              disabled={disabled || shellDraft.trim() === shell}
            >
              Save
            </button>
          </div>
        </form>
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
