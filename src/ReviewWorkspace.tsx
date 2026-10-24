import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type RefObject,
  type ReactNode,
} from "react";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import type { ErrorDetail } from "./api";
import { ChangedFilesTree } from "./ChangedFilesTree";
import type { VimSelectionRequest } from "./vim-navigation";
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
  focusRequest = 0,
  vimMode,
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
  focusRequest?: number;
  vimMode: boolean;
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
  const sidebar = useRef<HTMLElement>(null);
  const lastFocusRequest = useRef(0);
  useLayoutEffect(() => {
    if (!visible || focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = focusRequest;
    // Focus a real control for empty/loading revisions, not the whole panel.
    // The tree takes focus once its active row is mounted.
    if (
      !sidebar.current
        ?.querySelector(".changed-files")
        ?.contains(document.activeElement)
    )
      sidebar.current
        ?.querySelector<HTMLButtonElement>(".sidebar-toggle")
        ?.focus({ preventScroll: true });
  }, [focusRequest, visible]);
  return (
    <aside
      ref={sidebar}
      {...hoverHandlers}
      onKeyDown={(event) => {
        if (
          expanded &&
          event.key.toLowerCase() === "f" &&
          !event.defaultPrevented &&
          !event.repeat &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey &&
          !event.nativeEvent.isComposing
        )
          event.currentTarget
            .querySelector<HTMLButtonElement>(".sidebar-toggle")
            ?.focus({ preventScroll: true });
      }}
      className={`sidebar ${visible ? "" : "is-collapsed"} ${peeking ? "is-peeking" : ""}`}
      aria-label="Files sidebar"
    >
      {visible && (
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
              focusRequest={visible ? focusRequest : 0}
              vimMode={vimMode}
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
        className="action-button diff-search-open"
        aria-label="Find in diff"
        title="Find in diff"
        disabled={disabled}
        onClick={onOpen}
      >
        <svg
          viewBox="0 0 16 16"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="6.5" cy="6.5" r="4" />
          <path d="m9.5 9.5 4 4" />
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

function FileDiffSection({
  file,
  allFiles,
  disabled,
  collapsed,
  onCollapsedChange,
  revealRequest,
  sectionRef,
  onCollapse,
  actions,
  children,
}: {
  file: DiffFile;
  allFiles: boolean;
  disabled: boolean;
  collapsed: boolean;
  onCollapsedChange: (path: string, collapsed: boolean) => void;
  revealRequest: string | null;
  sectionRef: (element: HTMLElement | null) => void;
  onCollapse: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const contentId = useId();
  const expanded = !allFiles || !collapsed;
  const label = `${expanded ? "Collapse" : "Expand"} file ${file.path}`;
  // Search and keyboard selection must be able to reveal hidden lines.
  useLayoutEffect(() => {
    if (revealRequest !== null) onCollapsedChange(file.path, false);
  }, [file.path, onCollapsedChange, revealRequest]);
  return (
    <section
      className={`file-diff-section ${allFiles ? "all-files-section" : ""}${expanded ? "" : " is-collapsed"}`}
      aria-label={`Diff for ${file.path}`}
      data-file-path={file.path}
      ref={sectionRef}
    >
      {allFiles && (
        <div className="file-diff-heading">
          <button
            className="file-collapse"
            aria-label={label}
            title={label}
            aria-expanded={expanded}
            aria-controls={contentId}
            disabled={disabled}
            onClick={() => {
              onCollapsedChange(file.path, !collapsed);
              if (!collapsed) onCollapse();
            }}
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
              <path d={expanded ? "m4 6 4 4 4-4" : "m6 4 4 4-4 4"} />
            </svg>
          </button>
          <h2>{file.path}</h2>
          {actions}
        </div>
      )}
      <div id={contentId} hidden={!expanded}>
        {expanded && children}
      </div>
    </section>
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
  vimMode,
  vimSelection,
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
  readOnlyPreview = false,
  navigationNotice = "",
  onReturnToSource,
  onSquashFile,
  scrollRef,
  fileSections,
  onFileViewChange,
  onNavigateFile,
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
  vimMode: boolean;
  vimSelection: VimSelectionRequest | null;
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
  readOnlyPreview?: boolean;
  navigationNotice?: string;
  onReturnToSource?: () => void;
  onSquashFile: (path: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  fileSections: RefObject<Map<string, HTMLElement>>;
  onFileViewChange: (view: FileView) => void;
  onNavigateFile: (path: string) => void;
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
  const [vimEntry, setVimEntry] = useState<{
    request: number;
    scope: string;
    path: string;
    edge: "first" | "last";
    side: "additions" | "deletions";
  } | null>(null);
  useEffect(() => {
    if (vimEntry && vimEntry.path !== file?.path) setVimEntry(null);
  }, [file?.path, vimEntry]);
  const vimEntryRequest = useRef(0);
  const vimScope = `${contentIdentity}\u0000${renderVersion}`;
  const collapseScope = JSON.stringify([state?.repo.path, source?.changeId]);
  const [collapsedScope, setCollapsedScope] = useState(collapseScope);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  if (collapsedScope !== collapseScope) {
    setCollapsedScope(collapseScope);
    setCollapsedFiles(new Set());
  }
  const onFileCollapsedChange = useCallback(
    (path: string, collapsed: boolean) => {
      setCollapsedFiles((previous) => {
        if (previous.has(path) === collapsed) return previous;
        const next = new Set(previous);
        if (collapsed) next.add(path);
        else next.delete(path);
        return next;
      });
    },
    [],
  );
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
        <div className="file-bar-title">
          <span className="file-bar-filename">
            {fileView === "all"
              ? "All changed files"
              : (file?.path ?? "Reviewed change")}
          </span>
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
        </div>
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
      {navigationNotice && (
        <div className="navigation-notice" role="status">
          <span>{navigationNotice}</span>
          {onReturnToSource && (
            <button className="action-button" onClick={onReturnToSource}>
              Return to squashing change
            </button>
          )}
        </div>
      )}
      <ErrorBanner
        error={error}
        diagnostics={diagnostics}
        halted={halted}
        refreshDisabled={idleActionDisabled}
        onRefresh={onRefresh}
        onDismiss={onDismissError}
      />
      <SplitDiffLayout active={style === "split"} disabled={dragging}>
        <DiffViewport className="viewer-scroll" ref={scrollRef} tabIndex={-1}>
          <DiffRuntime colorScheme={colorScheme}>
            {!state ? (
              <div className="empty">
                {busy
                  ? "Opening repository…"
                  : "Unable to open repository. Press r to retry."}
              </div>
            ) : !file ? (
              <div className="empty">
                {pending && !readOnlyPreview
                  ? "All changes queued."
                  : "No changes in this revision."}
                {state.canUndo && !pending && (
                  <button
                    className="action-button"
                    onClick={onUndo}
                    disabled={working}
                  >
                    Undo
                  </button>
                )}
              </div>
            ) : (
              (fileView === "all" ? state.files : [file]).map((entry) => (
                <FileDiffSection
                  key={`${state.repo.path}:${source?.changeId}:${entry.path}`}
                  file={entry}
                  allFiles={fileView === "all"}
                  collapsed={collapsedFiles.has(entry.path)}
                  onCollapsedChange={onFileCollapsedChange}
                  disabled={(!readOnlyPreview && working) || halted || dragging}
                  revealRequest={
                    searchOpen && currentSearchMatch?.path === entry.path
                      ? `search:${searchRequest}:${currentSearchIndex}`
                      : vimEntry?.scope === vimScope &&
                          vimEntry.path === entry.path
                        ? `entry:${vimEntry.request}`
                        : vimSelection?.path === entry.path
                          ? `vim:${vimSelection.request}`
                          : null
                  }
                  sectionRef={(element) => {
                    if (element) fileSections.current.set(entry.path, element);
                    else fileSections.current.delete(entry.path);
                  }}
                  onCollapse={() => {
                    if (entry.path === file.path)
                      onSelection(entry.path, null, {});
                  }}
                  actions={
                    <>
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
                    </>
                  }
                >
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
                      vimMode={vimMode}
                      resetVimCursor={halted}
                      vimEntry={
                        vimEntry?.scope === vimScope &&
                        vimEntry.path === entry.path
                          ? vimEntry
                          : null
                      }
                      onVimEntryApplied={(request) =>
                        setVimEntry((entry) =>
                          entry?.request === request ? null : entry,
                        )
                      }
                      onVimBoundary={(key, side) => {
                        const files = state.files;
                        const direction = key === "j" ? 1 : -1;
                        for (
                          let index =
                            files.findIndex(
                              (candidate) => candidate.path === entry.path,
                            ) + direction;
                          index >= 0 && index < files.length;
                          index += direction
                        ) {
                          const target = files[index];
                          if (
                            target.unsupported ||
                            !target.hunks.some((hunk) =>
                              hunk.rows.some(
                                (row) =>
                                  " +-".includes(row.raw[0]) &&
                                  (row.oldLine !== undefined ||
                                    row.newLine !== undefined),
                              ),
                            )
                          )
                            continue;
                          onNavigateFile(target.path);
                          setVimEntry({
                            request: ++vimEntryRequest.current,
                            scope: vimScope,
                            path: target.path,
                            edge: key === "j" ? "first" : "last",
                            side,
                          });
                          return true;
                        }
                        return false;
                      }}
                      vimSelection={
                        vimSelection?.path === entry.path ? vimSelection : null
                      }
                      active={entry.path === file.path}
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
                      disabled={(!readOnlyPreview && working) || halted}
                      readOnly={readOnlyPreview}
                      contextDisabled={
                        !readOnlyPreview && (pending > 0 || recovering)
                      }
                      onSelection={(next, selected) =>
                        onSelection(entry.path, next, selected)
                      }
                      onDragging={onDragging}
                      onError={onError}
                      loadFile={loadFile}
                    />
                  )}
                </FileDiffSection>
              ))
            )}
          </DiffRuntime>
        </DiffViewport>
      </SplitDiffLayout>
    </main>
  );
}

export function RevisionGraph({
  focusRequest = 0,
  vimMode,
  rows,
  source,
  expanded,
  peeking = false,
  hoverHandlers,
  width,
  pending,
  loading,
  switching = false,
  dragging,
  idleActionDisabled,
  hasVersion,
  onResize,
  onToggle,
  onSelectRevision,
  onOpenRevision,
}: {
  focusRequest?: number;
  vimMode: boolean;
  rows: LogRow[];
  source?: Revision;
  expanded: boolean;
  peeking?: boolean;
  hoverHandlers?: HTMLAttributes<HTMLElement>;
  width: number;
  pending: number;
  loading: boolean;
  switching?: boolean;
  dragging: boolean;
  idleActionDisabled: boolean;
  hasVersion: boolean;
  onResize: (width: number) => void;
  onToggle: () => void;
  onSelectRevision: (changeId: string) => void;
  onOpenRevision: (changeId: string) => void;
}) {
  const visible = expanded || peeking;
  const graph = useRef<HTMLPreElement>(null);
  const [hovered, setHovered] = useState(false);
  const focusGraph = useCallback(() => {
    const element = graph.current;
    if (!element) return;
    const current = element.querySelector<HTMLButtonElement>(
      '.log-change[aria-pressed="true"]:not(:disabled)',
    );
    (current ?? element).focus({ preventScroll: true });
    current?.scrollIntoView({ block: "nearest" });
  }, []);
  const lastFocusRequest = useRef(0);
  useLayoutEffect(() => {
    if (!visible || focusRequest === lastFocusRequest.current) return;
    lastFocusRequest.current = focusRequest;
    focusGraph();
  }, [focusRequest, visible, focusGraph]);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (
      !hovered ||
      !visible ||
      !vimMode ||
      dragging ||
      document.querySelector("dialog[open]") ||
      graph.current?.contains(active) ||
      (active instanceof HTMLElement &&
        (active.matches("input, textarea, select") || active.isContentEditable))
    )
      return;
    // Wait for a hover preview to render before focusing its selected row.
    // Reuse normal log key handling rather than letting the diff consume j/k.
    focusGraph();
  }, [hovered, visible, vimMode, dragging, focusGraph]);
  return (
    <aside
      {...hoverHandlers}
      onPointerEnter={(event) => {
        hoverHandlers?.onPointerEnter?.(event);
        if (event.pointerType !== "touch" && !event.buttons) setHovered(true);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        hoverHandlers?.onPointerLeave?.(event);
      }}
      onPointerCancel={(event) => {
        setHovered(false);
        hoverHandlers?.onPointerCancel?.(event);
      }}
      className={`log-panel ${visible ? "" : "is-collapsed"} ${peeking ? "is-peeking" : ""}`}
      aria-label="Revision graph"
    >
      {visible && (
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
            <span className="log-status" aria-live="polite" aria-atomic="true">
              {pending ? (
                `${pending} queued`
              ) : switching ? (
                <span className="log-loading">
                  <span className="log-loading-spinner" aria-hidden="true" />
                  loading…
                </span>
              ) : loading ? (
                "updating…"
              ) : (
                ""
              )}
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
        ref={graph}
        tabIndex={0}
        onKeyDown={(event) => {
          if (
            !event.defaultPrevented &&
            !event.repeat &&
            !event.ctrlKey &&
            !event.metaKey &&
            !event.altKey &&
            !event.nativeEvent.isComposing
          ) {
            // @ changes the source; the next arrow should start there, not at
            // the old focused row. l must move focus before hiding the graph.
            if (event.key === "@")
              event.currentTarget.focus({ preventScroll: true });
            else if (event.key.toLowerCase() === "l" && expanded)
              event.currentTarget.parentElement
                ?.querySelector<HTMLButtonElement>(".sidebar-toggle")
                ?.focus({ preventScroll: true });
          }
          const up = event.key === "ArrowUp" || (vimMode && event.key === "k");
          const down =
            event.key === "ArrowDown" || (vimMode && event.key === "j");
          const open = event.key === "Enter";
          if (
            !visible ||
            (!up && !down && !open) ||
            event.nativeEvent
              .composedPath()
              .some(
                (node) =>
                  node instanceof HTMLElement &&
                  (node.matches("input, textarea, select") ||
                    node.isContentEditable),
              )
          )
            return;
          const ignored =
            event.defaultPrevented ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.shiftKey ||
            event.nativeEvent.isComposing ||
            (open && event.repeat);
          if (open) {
            // Suppress the button's native click, including repeated/modified
            // Enter, so confirming never dispatches a second selection.
            event.preventDefault();
            event.stopPropagation();
          }
          if (ignored) return;
          event.preventDefault();
          event.stopPropagation();
          const buttons = [
            ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
              ".log-change:not(:disabled)",
            ),
          ];
          if (!buttons.length) return;
          let index = buttons.findIndex(
            (button) => button === document.activeElement,
          );
          if (index < 0)
            index = buttons.findIndex(
              (button) => button.getAttribute("aria-pressed") === "true",
            );
          if (open) {
            const changeId = buttons[index]?.dataset.changeId;
            if (changeId) onOpenRevision(changeId);
            return;
          }
          const next =
            index < 0
              ? down
                ? 0
                : buttons.length - 1
              : Math.max(
                  0,
                  Math.min(buttons.length - 1, index + (down ? 1 : -1)),
                );
          const button = buttons[next];
          button.focus({ preventScroll: true });
          button.scrollIntoView({ block: "nearest" });
          if (next !== index) button.click();
        }}
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
                  <span aria-hidden="true">
                    {row.graph.split(/(×)/).map((part, index) =>
                      part === "×" ? (
                        <span className="log-conflict" key={index}>
                          {part}
                        </span>
                      ) : (
                        part
                      ),
                    )}
                  </span>
                  {row.revision && (
                    <>
                      <button
                        className="log-change"
                        data-change-id={row.revision.changeId}
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
      <div className="statusbar-actions">
        {showSquash && (
          <button
            className="action-button"
            onClick={onSquash}
            disabled={!canSquash}
            title={squashTitle}
          >
            Squash
          </button>
        )}
        <button
          className="action-button"
          onClick={onUndo}
          disabled={!canUndo}
          title={
            pending
              ? "Wait for queued squashes before undoing"
              : "Undo last squash"
          }
        >
          Undo
        </button>
        <button
          className="action-button"
          onClick={onClear}
          disabled={!range || working || dragging}
          title="Clear selection"
        >
          Clear
        </button>
      </div>
    </footer>
  );
}
