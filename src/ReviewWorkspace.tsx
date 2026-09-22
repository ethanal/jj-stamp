import type { RefObject } from "react";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import type { ErrorDetail } from "./api";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { CodeDiff } from "./CodeDiff";
import { ChangeId } from "./ReviewToolbar";
import { SidebarResize } from "./SidebarResize";
import { SquashFileButton } from "./SquashFileButton";
import type { ColorScheme, FileView } from "./preferences";
import type {
  DiffFile,
  LogRow,
  RepoState,
  Revision,
  Selections,
} from "./types";

export type DiffStyle = "unified" | "split";

export function LineCounts({
  additions,
  deletions,
  label,
}: {
  additions: number;
  deletions: number;
  label?: string;
}) {
  return (
    <span className="line-counts" aria-label={label}>
      <span className="added">+{additions}</span>
      <span className="removed">−{deletions}</span>
    </span>
  );
}

function SidebarToggle({
  side,
  expanded,
  onToggle,
  disabled,
}: {
  side: "files" | "log";
  expanded: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const label = `${expanded ? "Collapse" : "Expand"} ${side} sidebar`;
  const pointsLeft = side === "files" ? expanded : !expanded;
  return (
    <button
      className="sidebar-toggle"
      onClick={onToggle}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-expanded={expanded}
      aria-controls={`${side}-sidebar-content`}
    >
      <svg
        viewBox="0 0 16 16"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        aria-hidden="true"
      >
        <path d={pointsLeft ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"} />
      </svg>
    </button>
  );
}

export function FilesSidebar({
  files,
  activePath,
  source,
  parent,
  expanded,
  width,
  resizeDisabled,
  navigationDisabled,
  squashDisabled,
  squashUnavailable,
  onSquashFile,
  onResize,
  onToggle,
  onSelect,
}: {
  files?: DiffFile[];
  activePath?: string;
  source?: Revision;
  parent?: Revision | null;
  expanded: boolean;
  width: number;
  resizeDisabled: boolean;
  navigationDisabled: boolean;
  squashDisabled: boolean;
  squashUnavailable?: string;
  onSquashFile: (path: string) => void;
  onResize: (width: number) => void;
  onToggle: () => void;
  onSelect: (path: string) => void;
}) {
  return (
    <aside
      className={`sidebar ${expanded ? "" : "is-collapsed"}`}
      aria-label="Files sidebar"
    >
      {expanded && (
        <SidebarResize
          side="files"
          width={width}
          onResize={onResize}
          disabled={resizeDisabled}
        />
      )}
      <div className="sidebar-heading">
        {expanded && (
          <>
            Files <span>{files?.length ?? 0}</span>
          </>
        )}
        <SidebarToggle
          side="files"
          expanded={expanded}
          onToggle={onToggle}
          disabled={resizeDisabled}
        />
      </div>
      {!expanded && (
        <span className="rail-label" aria-hidden="true">
          Files
        </span>
      )}
      <div
        className="sidebar-body"
        id="files-sidebar-content"
        hidden={!expanded}
      >
        <div className="sidebar-content">
          {files && (
            <ChangedFilesTree
              files={files}
              activePath={activePath}
              disabled={navigationDisabled}
              onSelect={onSelect}
              squashDisabled={squashDisabled}
              squashUnavailable={squashUnavailable}
              onSquash={onSquashFile}
            />
          )}
        </div>
        <div className="sidebar-footer">
          <span title={source?.changeId}>
            {source?.changeId.slice(0, 8) ?? "…"}
          </span>
          <span aria-hidden="true">→</span>
          <code
            aria-label="Squash destination change ID"
            title={parent?.changeId}
          >
            {parent?.changeId.slice(0, 8) ?? "—"}
          </code>
        </div>
      </div>
    </aside>
  );
}

function ToggleGroup<T extends string>({
  label,
  grouped = false,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  grouped?: boolean;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <div
      className="layout-toggle"
      role={grouped ? "group" : undefined}
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          disabled={disabled}
          aria-pressed={value === option.value}
          className={value === option.value ? "active" : ""}
          title={option.title}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ErrorBanner({
  error,
  diagnostics,
  halted,
  refreshDisabled,
  onRefresh,
  onDismiss,
}: {
  error: string;
  diagnostics: ErrorDetail[];
  halted: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  onDismiss: () => void;
}) {
  if (!error) return null;
  return (
    <div className="error" role="alert">
      <div className="error-content">
        <div className="error-summary">{error}</div>
        {diagnostics.map((detail, index) => (
          <section
            className="error-diagnostic"
            key={index}
            aria-label={`${detail.label} error details`}
          >
            <div className="error-diagnostic-heading">
              <strong>{detail.label} error</strong>
              {detail.code && <code>{detail.code}</code>}
            </div>
            {detail.output && (
              <pre
                className="error-output"
                tabIndex={0}
                aria-label={`${detail.label} output`}
              >
                {detail.output}
              </pre>
            )}
          </section>
        ))}
        {halted && (
          <button
            className="retry"
            onClick={onRefresh}
            disabled={refreshDisabled}
          >
            refresh repository
          </button>
        )}
      </div>
      <button onClick={onDismiss} aria-label="Dismiss error">
        ×
      </button>
    </div>
  );
}

export function ReviewViewer({
  state,
  source,
  file,
  renderVersion,
  fileView,
  style,
  colorScheme,
  selections,
  range,
  busy,
  working,
  dragging,
  pending,
  recovering,
  halted,
  error,
  diagnostics,
  idleActionDisabled,
  squashDisabled,
  onSquashFile,
  scrollRef,
  fileSections,
  onFileViewChange,
  onStyleChange,
  onSelection,
  onDragging,
  onError,
  onRefresh,
  onDismissError,
  onUndo,
  loadFile,
}: {
  state: RepoState | null;
  source?: Revision;
  file?: DiffFile;
  renderVersion: string;
  fileView: FileView;
  style: DiffStyle;
  colorScheme: ColorScheme;
  selections: Selections;
  range: SelectedLineRange | null;
  busy: string;
  working: boolean;
  dragging: boolean;
  pending: number;
  recovering: boolean;
  halted: boolean;
  error: string;
  diagnostics: ErrorDetail[];
  idleActionDisabled: boolean;
  squashDisabled: boolean;
  onSquashFile: (path: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  fileSections: RefObject<Map<string, HTMLElement>>;
  onFileViewChange: (view: FileView) => void;
  onStyleChange: (style: DiffStyle) => void;
  onSelection: (
    path: string,
    range: SelectedLineRange | null,
    selections: Selections,
  ) => void;
  onDragging: (dragging: boolean) => void;
  onError: (error: unknown) => void;
  onRefresh: () => void;
  onDismissError: () => void;
  onUndo: () => void;
  loadFile: (path: string, version: string) => Promise<FileDiffLoadedFiles>;
}) {
  return (
    <main className="viewer">
      <div className="file-bar">
        <span>
          {fileView === "all"
            ? "All changed files"
            : (file?.path ?? "Reviewed change")}
        </span>
        <div className="file-bar-tools">
          {file && fileView === "single" && (
            <>
              <LineCounts
                additions={file.additions}
                deletions={file.deletions}
              />
              <SquashFileButton
                file={file}
                disabled={squashDisabled}
                unavailable={state?.squashUnavailable}
                onSquash={onSquashFile}
              />
            </>
          )}
          <ToggleGroup
            label="File view"
            grouped
            value={fileView}
            disabled={dragging}
            onChange={onFileViewChange}
            options={[
              {
                value: "single",
                label: "One file",
                title: "Show one file at a time",
              },
              {
                value: "all",
                label: "All files",
                title: "Show all file diffs on the same page",
              },
            ]}
          />
          <ToggleGroup
            label="Diff layout"
            value={style}
            disabled={dragging}
            onChange={onStyleChange}
            options={[
              { value: "unified", label: "Stacked" },
              { value: "split", label: "Split" },
            ]}
          />
        </div>
      </div>
      <ErrorBanner
        error={error}
        diagnostics={diagnostics}
        halted={halted}
        refreshDisabled={idleActionDisabled}
        onRefresh={onRefresh}
        onDismiss={onDismissError}
      />
      {state?.squashUnavailable && (
        <div className="error squash-unavailable" role="alert">
          {state.squashUnavailable}
        </div>
      )}
      <div className="viewer-scroll" ref={scrollRef}>
        {!state ? (
          <div className="empty">
            {busy
              ? "Opening repository…"
              : "Unable to open repository. Press r to retry."}
          </div>
        ) : !file ? (
          <div className="empty">
            {pending ? "All changes queued." : "No changes in this revision."}
            {state.canUndo && !pending && (
              <button onClick={onUndo} disabled={working}>
                undo <kbd>u</kbd>
              </button>
            )}
          </div>
        ) : (
          (fileView === "all" ? state.files : [file]).map((entry) => (
            <section
              key={`${source?.changeId}:${entry.path}`}
              className={`file-diff-section ${fileView === "all" ? "all-files-section" : ""}`}
              aria-label={`Diff for ${entry.path}`}
              data-file-path={entry.path}
              ref={(element) => {
                if (element) fileSections.current.set(entry.path, element);
                else fileSections.current.delete(entry.path);
              }}
            >
              {fileView === "all" && (
                <div className="file-diff-heading">
                  <h2>{entry.path}</h2>
                  <LineCounts
                    additions={entry.additions}
                    deletions={entry.deletions}
                  />
                  <SquashFileButton
                    file={entry}
                    disabled={squashDisabled}
                    unavailable={state.squashUnavailable}
                    onSquash={onSquashFile}
                  />
                </div>
              )}
              {entry.unsupported ? (
                <div className="unsupported">
                  <p>{entry.unsupported}</p>
                  <pre>{entry.patch}</pre>
                </div>
              ) : (
                <CodeDiff
                  file={entry}
                  version={renderVersion}
                  style={style}
                  colorScheme={colorScheme}
                  selections={entry.path === file.path ? selections : {}}
                  range={entry.path === file.path ? range : null}
                  disabled={working || halted}
                  contextDisabled={pending > 0 || recovering}
                  onSelection={(next, selected) =>
                    onSelection(entry.path, next, selected)
                  }
                  onDragging={onDragging}
                  onError={onError}
                  loadFile={loadFile}
                />
              )}
            </section>
          ))
        )}
      </div>
    </main>
  );
}

export function RevisionGraph({
  rows,
  source,
  expanded,
  width,
  pending,
  loading,
  dragging,
  idleActionDisabled,
  hasVersion,
  onResize,
  onToggle,
  onSelectRevision,
}: {
  rows: LogRow[];
  source?: Revision;
  expanded: boolean;
  width: number;
  pending: number;
  loading: boolean;
  dragging: boolean;
  idleActionDisabled: boolean;
  hasVersion: boolean;
  onResize: (width: number) => void;
  onToggle: () => void;
  onSelectRevision: (changeId: string) => void;
}) {
  return (
    <aside
      className={`log-panel ${expanded ? "" : "is-collapsed"}`}
      aria-label="Revision graph"
    >
      {expanded && (
        <SidebarResize
          side="log"
          width={width}
          onResize={onResize}
          disabled={dragging}
        />
      )}
      <div className="log-header">
        {expanded && (
          <>
            <span>jj log</span>
            <span className="log-status">
              {pending ? `${pending} queued` : loading ? "updating…" : ""}
            </span>
          </>
        )}
        <SidebarToggle
          side="log"
          expanded={expanded}
          onToggle={onToggle}
          disabled={dragging}
        />
      </div>
      {!expanded && (
        <span className="rail-label" aria-hidden="true">
          Log
        </span>
      )}
      <pre
        className="jj-log"
        id="log-sidebar-content"
        hidden={!expanded}
        aria-label="jj log output"
      >
        {rows.length
          ? rows.map((row, index) => {
              const current = row.revision?.changeId === source?.changeId;
              return (
                <span
                  className={`log-row${current ? " is-current" : ""}`}
                  key={row.revision?.commitId ?? `graph-${index}`}
                >
                  <span aria-hidden="true">{row.graph}</span>
                  {row.revision && (
                    <>
                      <button
                        className="log-change"
                        aria-label={`Review change ${row.revision.changeId}`}
                        aria-pressed={current}
                        title={`${row.revision.changeId}\n${row.revision.description}${row.mutable ? "" : "\nImmutable change"}`}
                        disabled={
                          !row.mutable ||
                          idleActionDisabled ||
                          dragging ||
                          loading ||
                          !hasVersion
                        }
                        onClick={() => onSelectRevision(row.revision!.changeId)}
                      >
                        <ChangeId revision={row.revision} />
                      </button>{" "}
                      <span title={row.revision.description}>
                        {row.revision.description || "(no description)"}
                      </span>
                    </>
                  )}
                </span>
              );
            })
          : loading
            ? "Loading…"
            : ""}
      </pre>
    </aside>
  );
}

export function ReviewStatusBar({
  count,
  range,
  pending,
  busy,
  recovering,
  halted,
  notice,
  queueNotice,
  canSquash,
  canUndo,
  working,
  dragging,
  squashTitle,
  onSquash,
  onUndo,
  onClear,
}: {
  count: number;
  range: SelectedLineRange | null;
  pending: number;
  busy: string;
  recovering: boolean;
  halted: boolean;
  notice: string;
  queueNotice: string;
  canSquash: boolean;
  canUndo: boolean;
  working: boolean;
  dragging: boolean;
  squashTitle: string;
  onSquash: () => void;
  onUndo: () => void;
  onClear: () => void;
}) {
  const status = busy
    ? `${busy}…`
    : recovering
      ? "Reloading actual repository…"
      : halted
        ? "Queue stopped. Refresh to continue."
        : count
          ? `${count} changed line${count === 1 ? "" : "s"} selected`
          : range
            ? "Context only — no changed lines"
            : notice ||
              (pending ? "keep selecting" : queueNotice) ||
              "Drag code to select lines";
  return (
    <footer className="statusbar">
      <span
        className={count || pending ? "selection-status" : ""}
        role="status"
      >
        {pending > 0 && (
          <span className="queue-count">{pending} queued · </span>
        )}
        {status}
      </span>
      <span
        className="text-selection-hint"
        title="Cmd/Ctrl+C copies selected right-hand code; Alt+drag selects native text; e opens the hovered line in Neovim"
      >
        Cmd/Ctrl+C to copy · Alt+drag for text
      </span>
      <div className="shortcuts">
        <button onClick={onSquash} disabled={!canSquash} title={squashTitle}>
          <kbd>s</kbd> squash → parent
        </button>
        <button
          onClick={onUndo}
          disabled={!canUndo}
          title={
            pending
              ? "Wait for queued squashes before undoing"
              : "Undo last squash"
          }
        >
          <kbd>u</kbd> undo
        </button>
        <button onClick={onClear} disabled={!range || working || dragging}>
          <kbd>esc</kbd> clear
        </button>
      </div>
    </footer>
  );
}
