import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
} from "react";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import type { ErrorDetail } from "./api";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { CodeDiff } from "./CodeDiff";
import { DiffRuntime, DiffViewport } from "./DiffRuntime";
import { searchDiffRows } from "./diff-search";
import { ChangeId } from "./ReviewToolbar";
import { SidebarResize } from "./SidebarResize";
import { SplitDiffLayout } from "./SplitDiffLayout";
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
  peeking = false,
  onToggle,
  disabled,
}: {
  side: "files" | "log";
  expanded: boolean;
  peeking?: boolean;
  onToggle: () => void;
  disabled: boolean;
}) {
  const label = `${expanded ? "Collapse" : peeking ? "Pin" : "Expand"} ${side} sidebar`;
  const pointsLeft = side === "files" ? expanded : !expanded;
  return (
    <button
      className="sidebar-toggle"
      onClick={onToggle}
      disabled={disabled}
      aria-label={label}
      title={label}
      aria-expanded={expanded || peeking}
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
  peeking = false,
  hoverHandlers,
  width,
  resizeDisabled,
  navigationDisabled,
  onResize,
  onToggle,
  onSelect,
}: {
  files?: DiffFile[];
  activePath?: string;
  source?: Revision;
  parent?: Revision | null;
  expanded: boolean;
  peeking?: boolean;
  hoverHandlers?: HTMLAttributes<HTMLElement>;
  width: number;
  resizeDisabled: boolean;
  navigationDisabled: boolean;
  onResize: (width: number) => void;
  onToggle: () => void;
  onSelect: (path: string) => void;
}) {
  const visible = expanded || peeking;
  return (
    <aside
      {...hoverHandlers}
      className={`sidebar ${visible ? "" : "is-collapsed"} ${peeking ? "is-peeking" : ""}`}
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
        {visible && (
          <>
            Files <span>{files?.length ?? 0}</span>
          </>
        )}
        <SidebarToggle
          side="files"
          expanded={expanded}
          peeking={peeking}
          onToggle={onToggle}
          disabled={resizeDisabled}
        />
      </div>
      {!visible && (
        <span className="rail-label" aria-hidden="true">
          Files
        </span>
      )}
      <div
        className="sidebar-body"
        id="files-sidebar-content"
        hidden={!visible}
      >
        <div className="sidebar-content">
          {files && (
            <ChangedFilesTree
              files={files}
              activePath={activePath}
              disabled={navigationDisabled}
              onSelect={onSelect}
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

function DiffSearchControls({
  open,
  query,
  regex,
  error,
  current,
  total,
  inputRef,
  triggerRef,
  disabled,
  onOpen,
  onQuery,
  onRegex,
  onPrevious,
  onNext,
  onClose,
}: {
  open: boolean;
  query: string;
  regex: boolean;
  error: string;
  current: number;
  total: number;
  inputRef: RefObject<HTMLInputElement | null>;
  triggerRef: RefObject<HTMLButtonElement | null>;
  disabled: boolean;
  onOpen: () => void;
  onQuery: (query: string) => void;
  onRegex: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onClose: () => void;
}) {
  if (!open)
    return (
      <button
        ref={triggerRef}
        className="diff-search-open"
        aria-label="Find in diff"
        title="Find in diff (Ctrl/Cmd+F)"
        disabled={disabled}
        onClick={onOpen}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="4.25" />
          <path d="m10.2 10.2 3.1 3.1" />
        </svg>
      </button>
    );
  return (
    <div className="diff-search" role="search">
      <input
        ref={inputRef}
        type="text"
        role="searchbox"
        aria-label="Search diff"
        aria-invalid={error ? true : undefined}
        placeholder="Find in diff"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            if (event.shiftKey) onPrevious();
            else onNext();
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          }
        }}
      />
      <output className="diff-search-count" aria-live="polite">
        {error ||
          (query ? (total ? `${current + 1} / ${total}` : "No results") : "")}
      </output>
      <button
        className={`diff-search-regex${regex ? " active" : ""}`}
        aria-label="Use regular expression"
        aria-pressed={regex}
        title="Use regular expression (case-insensitive)"
        onClick={onRegex}
      >
        .*
      </button>
      <button
        aria-label="Previous search result"
        title="Previous result (Shift+Enter)"
        disabled={!total}
        onClick={onPrevious}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="m4 10 4-4 4 4" />
        </svg>
      </button>
      <button
        aria-label="Next search result"
        title="Next result (Enter)"
        disabled={!total}
        onClick={onNext}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
      <button
        aria-label="Close search"
        title="Close (Escape)"
        onClick={onClose}
      >
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          aria-hidden="true"
        >
          <path d="m4.5 4.5 7 7m0-7-7 7" />
        </svg>
      </button>
    </div>
  );
}

export function ReviewViewer({
  state,
  source,
  file,
  renderVersion,
  contentIdentity,
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
  contentIdentity: string;
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
  const searchScope = `${contentIdentity}\u0000${renderVersion}\u0000${fileView}\u0000${fileView === "single" ? (file?.path ?? "") : ""}`;
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchRegex, setSearchRegex] = useState(false);
  const [searchCursor, setSearchCursor] = useState({
    scope: searchScope,
    index: 0,
  });
  const [searchRequest, setSearchRequest] = useState(0);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchReturnFocus = useRef<HTMLElement | null>(null);
  const previousContentIdentity = useRef(contentIdentity);
  const searchFiles = useMemo(
    () => (fileView === "all" ? (state?.files ?? []) : file ? [file] : []),
    [fileView, state?.files, file],
  );
  const searchResult = useMemo(
    () => searchDiffRows(searchFiles, searchQuery, searchRegex),
    [searchFiles, searchQuery, searchRegex],
  );
  const { matches: searchMatches, error: searchError } = searchResult;
  const searchIndex =
    searchCursor.scope === searchScope ? searchCursor.index : 0;
  const currentSearchIndex = searchMatches.length
    ? Math.min(searchIndex, searchMatches.length - 1)
    : 0;
  const currentSearchMatch = searchMatches[currentSearchIndex] ?? null;
  const openSearch = useCallback(() => {
    if (!searchOpen && document.activeElement instanceof HTMLElement)
      searchReturnFocus.current = document.activeElement;
    setSearchOpen(true);
    setSearchRequest((request) => request + 1);
    requestAnimationFrame(() => {
      searchInput.current?.focus();
      searchInput.current?.select();
    });
  }, [searchOpen]);
  const closeSearch = useCallback(() => {
    const returnFocus = searchReturnFocus.current;
    setSearchOpen(false);
    requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else searchTrigger.current?.focus();
    });
  }, []);
  const moveSearch = useCallback(
    (direction: number) => {
      if (!searchMatches.length) return;
      setSearchCursor((cursor) => ({
        scope: searchScope,
        index:
          (Math.min(
            cursor.scope === searchScope ? cursor.index : 0,
            searchMatches.length - 1,
          ) +
            direction +
            searchMatches.length) %
          searchMatches.length,
      }));
      setSearchRequest((request) => request + 1);
    },
    [searchMatches.length, searchScope],
  );
  useEffect(() => {
    setSearchCursor({ scope: searchScope, index: 0 });
    setSearchRequest((request) => request + 1);
  }, [searchScope]);
  useEffect(() => {
    if (previousContentIdentity.current === contentIdentity) return;
    previousContentIdentity.current = contentIdentity;
    setSearchQuery("");
    setSearchCursor({ scope: searchScope, index: 0 });
    setSearchRequest((request) => request + 1);
    if (searchOpen) closeSearch();
    else setSearchOpen(false);
  }, [closeSearch, contentIdentity, searchOpen, searchScope]);
  useEffect(() => {
    if (searchIndex >= searchMatches.length)
      setSearchCursor({ scope: searchScope, index: 0 });
  }, [searchIndex, searchMatches.length, searchScope]);
  useLayoutEffect(() => {
    if (!searchOpen || !currentSearchMatch) return;
    const viewport = scrollRef.current;
    const section = fileSections.current.get(currentSearchMatch.path);
    if (!viewport || !section) return;
    const viewportBox = viewport.getBoundingClientRect();
    const sectionBox = section.getBoundingClientRect();
    if (
      sectionBox.bottom > viewportBox.top &&
      sectionBox.top < viewportBox.bottom
    )
      return;
    viewport.scrollTop += sectionBox.top - viewportBox.top;
  }, [currentSearchMatch, fileSections, scrollRef, searchOpen, searchRequest]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        !event.defaultPrevented &&
        !event.altKey &&
        (event.ctrlKey || event.metaKey) &&
        event.key.toLocaleLowerCase() === "f"
      ) {
        if (!file) return;
        event.preventDefault();
        openSearch();
        return;
      }
      if (!searchOpen || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSearch();
      } else if (event.key === "F3") {
        event.preventDefault();
        moveSearch(event.shiftKey ? -1 : 1);
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [closeSearch, file, moveSearch, openSearch, searchOpen]);
  return (
    <main className="viewer">
      <div className="file-bar">
        <span>
          {fileView === "all"
            ? "All changed files"
            : (file?.path ?? "Reviewed change")}
        </span>
        <div className="file-bar-tools">
          <DiffSearchControls
            open={searchOpen}
            query={searchQuery}
            regex={searchRegex}
            error={searchError}
            current={currentSearchIndex}
            total={searchMatches.length}
            inputRef={searchInput}
            triggerRef={searchTrigger}
            disabled={!file}
            onOpen={openSearch}
            onQuery={(query) => {
              setSearchQuery(query);
              setSearchCursor({ scope: searchScope, index: 0 });
              setSearchRequest((request) => request + 1);
            }}
            onRegex={() => {
              setSearchRegex((regex) => !regex);
              setSearchCursor({ scope: searchScope, index: 0 });
              setSearchRequest((request) => request + 1);
              requestAnimationFrame(() => searchInput.current?.focus());
            }}
            onPrevious={() => moveSearch(-1)}
            onNext={() => moveSearch(1)}
            onClose={closeSearch}
          />
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
      <SplitDiffLayout active={style === "split"} disabled={dragging}>
        <DiffViewport className="viewer-scroll" ref={scrollRef}>
          <DiffRuntime colorScheme={colorScheme}>
            {!state ? (
              <div className="empty">
                {busy
                  ? "Opening repository…"
                  : "Unable to open repository. Press r to retry."}
              </div>
            ) : !file ? (
              <div className="empty">
                {pending
                  ? "All changes queued."
                  : "No changes in this revision."}
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
                      contentIdentity={contentIdentity}
                      style={style}
                      colorScheme={colorScheme}
                      selections={entry.path === file.path ? selections : {}}
                      range={entry.path === file.path ? range : null}
                      search={
                        searchOpen
                          ? {
                              matches: searchMatches,
                              current: currentSearchMatch,
                              request: searchRequest,
                            }
                          : undefined
                      }
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
          </DiffRuntime>
        </DiffViewport>
      </SplitDiffLayout>
    </main>
  );
}

export function RevisionGraph({
  rows,
  source,
  expanded,
  peeking = false,
  hoverHandlers,
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
  peeking?: boolean;
  hoverHandlers?: HTMLAttributes<HTMLElement>;
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
  const visible = expanded || peeking;
  return (
    <aside
      {...hoverHandlers}
      className={`log-panel ${visible ? "" : "is-collapsed"} ${peeking ? "is-peeking" : ""}`}
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
        {visible && (
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
          peeking={peeking}
          onToggle={onToggle}
          disabled={dragging}
        />
      </div>
      {!visible && (
        <span className="rail-label" aria-hidden="true">
          Log
        </span>
      )}
      <pre
        className="jj-log"
        id="log-sidebar-content"
        hidden={!visible}
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
                        disabled={idleActionDisabled || dragging || !hasVersion}
                        onClick={() => onSelectRevision(row.revision!.changeId)}
                      >
                        <ChangeId revision={row.revision} />
                      </button>
                      {row.bookmarks?.length ? (
                        <>
                          {" "}
                          <span className="log-bookmarks">
                            {row.bookmarks.join(" ")}
                          </span>
                          {" | "}
                        </>
                      ) : (
                        " "
                      )}
                      {row.isEmpty && <span>(empty) </span>}
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
  showSquash,
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
  showSquash: boolean;
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
    ? `${busy === "refreshing" ? "Refreshing" : busy}…`
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
        {showSquash && (
          <button onClick={onSquash} disabled={!canSquash} title={squashTitle}>
            <kbd>s</kbd> squash
          </button>
        )}
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
