import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from "react";
import { createRoot } from "react-dom/client";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import type { LogRow, RepoState, Selections } from "./types";
import { CodeDiff } from "./CodeDiff";
import { ChangedFilesTree } from "./ChangedFilesTree";
import { refsFromSelection, specsForRefs, type RowRef } from "./optimistic";
import { SquashQueue } from "./squash-queue";
import { api, errorMessage, errorDetails, type ErrorDetail } from "./api";
import { useAppearancePreferences } from "./preferences";
import { SidebarResize } from "./SidebarResize";
import {
  ChangeId,
  SettingsDialog,
  RevisionHeading,
  revisionPageTitle,
} from "./ReviewToolbar";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource/ibm-plex-mono/700.css";
import "./styles.css";

const loadFile = (path: string, version: string) =>
  api<FileDiffLoadedFiles>("file", { path, version });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
function Counts({
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
function readExpanded(side: "files" | "log"): boolean {
  try {
    return localStorage.getItem(`jj-stamp.${side}-expanded`) !== "false";
  } catch {
    return true;
  }
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
  const left = side === "files" ? expanded : !expanded;
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
        <path d={left ? "M10 3 5 8l5 5" : "m6 3 5 5-5 5"} />
      </svg>
    </button>
  );
}
function App() {
  const {
    fileView,
    setFileView,
    colorScheme,
    setColorScheme,
    filesWidth,
    setFilesWidth,
    logWidth,
    setLogWidth,
  } = useAppearancePreferences();
  const [queue] = useState(
    () =>
      new SquashQueue({
        squash: (input) => api("squash-lines", input),
        readState: () => api<RepoState>("state"),
      }),
  );
  const queued = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const state = queued.view;
  const source = queued.confirmed?.source ?? state?.source;
  useEffect(() => {
    document.title = revisionPageTitle(source, state?.repo.path);
  }, [
    source?.changeId,
    source?.changeIdPrefix,
    source?.description,
    state?.repo.path,
  ]);
  const [activePath, setActivePath] = useState("");
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [picked, setPicked] = useState<RowRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const [localError, setLocalError] = useState<{
    message: string;
    details: ErrorDetail[];
  } | null>(null);
  const setError = useCallback((error: unknown) => {
    setLocalError(
      error === ""
        ? null
        : {
            message: errorMessage(error),
            details: errorDetails(error),
          },
    );
  }, []);
  const [notice, setNotice] = useState("");
  const [log, setLog] = useState<LogRow[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const logOperation = useRef<string | undefined>(undefined);
  const logVersion = useRef<string | undefined>(undefined);
  const [graphRefresh, setGraphRefresh] = useState(0);
  const [showFiles, setShowFiles] = useState(() => readExpanded("files"));
  const [showLog, setShowLog] = useState(() => readExpanded("log"));
  const [style, setStyle] = useState<"unified" | "split">(() => {
    try {
      return (localStorage.getItem("jj-stamp.diff-style") ??
        localStorage.getItem("fold.diff-style")) === "split"
        ? "split"
        : "unified";
    } catch {
      return "unified";
    }
  });
  const lock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const fileSections = useRef(new Map<string, HTMLElement>());
  const scrollToFile = useCallback((path: string) => {
    const viewport = scroll.current;
    const section = fileSections.current.get(path);
    if (viewport && section) {
      viewport.scrollTo(
        0,
        viewport.scrollTop +
          section.getBoundingClientRect().top -
          viewport.getBoundingClientRect().top,
      );
    }
  }, []);
  // Only explicit navigation changes scroll, never selection or queue updates.
  useLayoutEffect(() => {
    if (fileView === "all") scrollToFile(activePath);
    else scroll.current?.scrollTo(0, 0);
  }, [fileView, scrollToFile]);
  const file =
    state?.files.find((file) => file.path === activePath) ?? state?.files[0];
  const selections = useMemo<Selections>(() => {
    if (!state || !picked.length) return {};
    try {
      return Object.fromEntries(
        specsForRefs(state, picked).map((spec) => [spec.id, spec.lines]),
      );
    } catch {
      return {};
    }
  }, [state, picked]);
  const count = Object.values(selections).reduce(
    (sum, lines) => sum + lines.length,
    0,
  );
  const working = !!busy || queued.recovering;
  const error = [queued.error, localError?.message]
    .filter(Boolean)
    .join("\n\n");
  const diagnostics = [...queued.errorDetails, ...(localError?.details ?? [])];
  const clear = useCallback(() => {
    setRange(null);
    setPicked([]);
    setNotice("");
  }, []);
  const replace = useCallback(
    (next: RepoState) => {
      queue.replace(next);
      clear();
      setActivePath((current) =>
        next.files.some((file) => file.path === current)
          ? current
          : (next.files[0]?.path ?? ""),
      );
    },
    [queue, clear],
  );
  const refresh = useCallback(async () => {
    const current = queue.getSnapshot();
    if (lock.current || current.pending || current.recovering) return;
    lock.current = true;
    setBusy("refreshing");
    setError("");
    setNotice("");
    try {
      replace(await api<RepoState>("state"));
    } catch (error) {
      setError(error);
      setGraphRefresh((value) => value + 1);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [queue, replace]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    try {
      localStorage.setItem("jj-stamp.diff-style", style);
    } catch {
      /* Preference storage is optional. */
    }
  }, [style]);
  useEffect(() => {
    try {
      localStorage.setItem("jj-stamp.files-expanded", String(showFiles));
      localStorage.setItem("jj-stamp.log-expanded", String(showLog));
    } catch {
      /* Sidebar preferences are optional. */
    }
  }, [showFiles, showLog]);
  useEffect(() => {
    if (
      !showLog ||
      queued.pending ||
      queued.recovering ||
      (!queued.confirmed && !graphRefresh)
    )
      return;
    let cancelled = false;
    logVersion.current = undefined;
    setLogLoading(true);
    // Load immediately on startup/change selection. Only debounce after history
    // changes, so graph reads don't get ahead of a burst of queued squashes.
    const operation = queued.confirmed?.operation;
    const delay =
      logOperation.current && logOperation.current !== operation ? 120 : 0;
    const timer = setTimeout(() => {
      api<{ version: string; rows: LogRow[] }>("graph")
        .then((result) => {
          if (!cancelled) {
            setLog(result.rows);
            logVersion.current = result.version;
            logOperation.current = operation;
          }
        })
        .catch((error) => {
          if (!cancelled) setError(error);
        })
        .finally(() => {
          if (!cancelled) setLogLoading(false);
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    queued.confirmed?.version,
    queued.pending,
    queued.recovering,
    showLog,
    graphRefresh,
  ]);
  useEffect(() => {
    if (queued.halted) clear();
  }, [queued.halted, clear]);
  useEffect(() => {
    if (!queued.pending && !queued.recovering) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [queued.pending, queued.recovering]);
  const selectFile = useCallback(
    (path: string) => {
      if (lock.current || queue.getSnapshot().recovering) return;
      clear();
      setActivePath(path);
      // Only explicit navigation resets scroll; squash may remove the active file.
      if (fileView === "all") scrollToFile(path);
      else scroll.current?.scrollTo(0, 0);
    },
    [clear, queue, fileView, scrollToFile],
  );
  const select = useCallback(
    (path: string, next: SelectedLineRange | null, selected: Selections) => {
      const current = queue.getSnapshot();
      if (lock.current || current.recovering || !current.view) return;
      try {
        if (next) setActivePath(path);
        setPicked(refsFromSelection(current.view, selected));
        setRange(next);
        setNotice("");
      } catch (error) {
        setError(error);
        clear();
      }
    },
    [queue, clear],
  );
  const squash = useCallback(() => {
    const current = queue.getSnapshot();
    if (
      lock.current ||
      dragging ||
      !count ||
      !current.view ||
      current.recovering ||
      current.halted
    )
      return;
    if (!current.view.parent) {
      setError(
        current.view.squashUnavailable ||
          "The reviewed change needs one mutable parent.",
      );
      return;
    }
    setError("");
    setNotice("");
    try {
      queue.enqueue(picked);
      clear();
    } catch (error) {
      setError(error);
    }
  }, [queue, picked, count, dragging, clear]);
  const undo = useCallback(async () => {
    const current = queue.getSnapshot();
    if (
      lock.current ||
      dragging ||
      current.pending ||
      current.recovering ||
      !current.confirmed?.canUndo
    )
      return;
    lock.current = true;
    setBusy("undoing");
    setError("");
    try {
      const result = await api<{ state: RepoState }>("undo", {
        version: current.confirmed.version,
      });
      replace(result.state);
      setNotice("Squash undone");
    } catch (error) {
      setError(error);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [queue, dragging, replace]);
  const selectRevision = useCallback(
    async (changeId: string) => {
      const current = queue.getSnapshot();
      if (
        lock.current ||
        dragging ||
        current.pending ||
        current.recovering ||
        !logVersion.current
      )
        return;
      lock.current = true;
      setBusy("switching change");
      setError("");
      try {
        const result = await api<{ state: RepoState }>("revision", {
          version: logVersion.current,
          changeId,
        });
        replace(result.state);
        setActivePath(result.state.files[0]?.path ?? "");
        scroll.current?.scrollTo(0, 0);
      } catch (error) {
        setError(error);
      } finally {
        lock.current = false;
        setBusy("");
      }
    },
    [queue, dragging, replace],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing
      )
        return;
      if (
        event.target instanceof Element &&
        event.target.closest(
          'input, textarea, select, dialog, [contenteditable="true"]',
        )
      )
        return;
      switch (event.key.toLowerCase()) {
        case "s":
          event.preventDefault();
          squash();
          break;
        case "u":
          event.preventDefault();
          void undo();
          break;
        case "r":
          event.preventDefault();
          void refresh();
          break;
        case "l":
          event.preventDefault();
          setShowLog((value) => !value);
          break;
        case "f":
          event.preventDefault();
          fileSections.current
            .get(file?.path ?? "")
            ?.querySelector<HTMLElement>(".code-surface")
            ?.focus();
          break;
        case "escape":
          if (!lock.current && !dragging) {
            clear();
            setError("");
            queue.clearError();
          }
          break;
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [squash, undo, refresh, queue, clear, dragging, file?.path]);
  const additions =
    state?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions =
    state?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const idleActionDisabled = working || queued.pending > 0;
  return (
    <div className="app">
      <header className="topbar">
        <span
          className="repo-path"
          aria-label="Repository path"
          title={state?.repo.path}
        >
          {state?.repo.path ?? "Opening repository…"}
        </span>
        <RevisionHeading source={source}>
          <span className="commit-totals">
            <span>change</span>
            <Counts
              additions={additions}
              deletions={deletions}
              label="Change line counts"
            />
          </span>
        </RevisionHeading>
        <button
          onClick={refresh}
          disabled={idleActionDisabled}
          title="Refresh (r)"
        >
          refresh <kbd>r</kbd>
        </button>
        <SettingsDialog
          colorScheme={colorScheme}
          onColorSchemeChange={setColorScheme}
          disabled={dragging}
        />
      </header>
      <div
        className={`workspace ${showLog ? "with-log" : "log-collapsed"} ${showFiles ? "" : "files-collapsed"}`}
        style={
          {
            "--files-preferred-width": `${filesWidth}px`,
            "--log-preferred-width": `${logWidth}px`,
          } as CSSProperties
        }
      >
        <aside
          className={`sidebar ${showFiles ? "" : "is-collapsed"}`}
          aria-label="Files sidebar"
        >
          {showFiles && (
            <SidebarResize
              side="files"
              width={filesWidth}
              onResize={setFilesWidth}
              disabled={dragging}
            />
          )}
          <div className="sidebar-heading">
            {showFiles && (
              <>
                Files <span>{state?.files.length ?? 0}</span>
              </>
            )}
            <SidebarToggle
              side="files"
              expanded={showFiles}
              onToggle={() => setShowFiles((value) => !value)}
              disabled={dragging}
            />
          </div>
          {!showFiles && (
            <span className="rail-label" aria-hidden="true">
              Files
            </span>
          )}
          <div
            className="sidebar-body"
            id="files-sidebar-content"
            hidden={!showFiles}
          >
            <div className="sidebar-content">
              {state && (
                <ChangedFilesTree
                  files={state.files}
                  activePath={file?.path}
                  disabled={working}
                  onSelect={selectFile}
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
                title={state?.parent?.changeId}
              >
                {state?.parent?.changeId.slice(0, 8) ?? "—"}
              </code>
            </div>
          </div>
        </aside>
        <main className="viewer">
          <div className="file-bar">
            <span>
              {fileView === "all"
                ? "All changed files"
                : (file?.path ?? "Reviewed change")}
            </span>
            <div className="file-bar-tools">
              {file && fileView === "single" && (
                <Counts additions={file.additions} deletions={file.deletions} />
              )}
              <div
                className="layout-toggle"
                role="group"
                aria-label="File view"
              >
                <button
                  onClick={() => setFileView("single")}
                  disabled={dragging}
                  aria-pressed={fileView === "single"}
                  className={fileView === "single" ? "active" : ""}
                  title="Show one file at a time"
                >
                  One file
                </button>
                <button
                  onClick={() => setFileView("all")}
                  disabled={dragging}
                  aria-pressed={fileView === "all"}
                  className={fileView === "all" ? "active" : ""}
                  title="Show all file diffs on the same page"
                >
                  All files
                </button>
              </div>
              <div className="layout-toggle" aria-label="Diff layout">
                <button
                  onClick={() => setStyle("unified")}
                  disabled={dragging}
                  aria-pressed={style === "unified"}
                  className={style === "unified" ? "active" : ""}
                >
                  Stacked
                </button>
                <button
                  onClick={() => setStyle("split")}
                  disabled={dragging}
                  aria-pressed={style === "split"}
                  className={style === "split" ? "active" : ""}
                >
                  Split
                </button>
              </div>
            </div>
          </div>
          {error && (
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
                {queued.halted && (
                  <button
                    className="retry"
                    onClick={refresh}
                    disabled={idleActionDisabled}
                  >
                    refresh repository
                  </button>
                )}
              </div>
              <button
                onClick={() => {
                  setError("");
                  queue.clearError();
                }}
                aria-label="Dismiss error"
              >
                ×
              </button>
            </div>
          )}
          {state?.squashUnavailable && (
            <div className="error squash-unavailable" role="alert">
              {state.squashUnavailable}
            </div>
          )}
          <div className="viewer-scroll" ref={scroll}>
            {!state ? (
              <div className="empty">
                {busy
                  ? "Opening repository…"
                  : "Unable to open repository. Press r to retry."}
              </div>
            ) : !file ? (
              <div className="empty">
                {queued.pending
                  ? "All changes queued."
                  : "No changes in this revision."}
                {state.canUndo && !queued.pending && (
                  <button onClick={undo} disabled={working}>
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
                      <Counts
                        additions={entry.additions}
                        deletions={entry.deletions}
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
                      version={queued.confirmed?.version ?? state.version}
                      renderKey={`${queued.epoch}`}
                      style={style}
                      colorScheme={colorScheme}
                      selections={entry.path === file.path ? selections : {}}
                      range={entry.path === file.path ? range : null}
                      disabled={working || queued.halted}
                      contextDisabled={queued.pending > 0 || queued.recovering}
                      onSelection={(next, selected) =>
                        select(entry.path, next, selected)
                      }
                      onDragging={setDragging}
                      onError={setError}
                      loadFile={loadFile}
                    />
                  )}
                </section>
              ))
            )}
          </div>
        </main>
        <aside
          className={`log-panel ${showLog ? "" : "is-collapsed"}`}
          aria-label="Revision graph"
        >
          {showLog && (
            <SidebarResize
              side="log"
              width={logWidth}
              onResize={setLogWidth}
              disabled={dragging}
            />
          )}
          <div className="log-header">
            {showLog && (
              <>
                <span>jj log</span>
                <span className="log-status">
                  {queued.pending
                    ? `${queued.pending} queued`
                    : logLoading
                      ? "updating…"
                      : ""}
                </span>
              </>
            )}
            <SidebarToggle
              side="log"
              expanded={showLog}
              onToggle={() => setShowLog((value) => !value)}
              disabled={dragging}
            />
          </div>
          {!showLog && (
            <span className="rail-label" aria-hidden="true">
              Log
            </span>
          )}
          <pre
            className="jj-log"
            id="log-sidebar-content"
            hidden={!showLog}
            aria-label="jj log output"
          >
            {log.length
              ? log.map((row, index) => (
                  <span
                    className={`log-row${row.revision?.changeId === source?.changeId ? " is-current" : ""}`}
                    key={row.revision?.commitId ?? `graph-${index}`}
                  >
                    <span aria-hidden="true">{row.graph}</span>
                    {row.revision && (
                      <>
                        <button
                          className="log-change"
                          aria-label={`Review change ${row.revision.changeId}`}
                          aria-pressed={
                            row.revision.changeId === source?.changeId
                          }
                          title={`${row.revision.changeId}\n${row.revision.description}${row.mutable ? "" : "\nImmutable change"}`}
                          disabled={
                            !row.mutable ||
                            idleActionDisabled ||
                            dragging ||
                            logLoading ||
                            !logVersion.current
                          }
                          onClick={() =>
                            void selectRevision(row.revision!.changeId)
                          }
                        >
                          <ChangeId revision={row.revision} />
                        </button>{" "}
                        <span title={row.revision.description}>
                          {row.revision.description || "(no description)"}
                        </span>
                      </>
                    )}
                  </span>
                ))
              : logLoading
                ? "Loading…"
                : ""}
          </pre>
        </aside>
      </div>
      <footer className="statusbar">
        <span
          className={count || queued.pending ? "selection-status" : ""}
          role="status"
        >
          {queued.pending > 0 && (
            <span className="queue-count">{queued.pending} queued · </span>
          )}
          {busy
            ? `${busy}…`
            : queued.recovering
              ? "Reloading actual repository…"
              : queued.halted
                ? "Queue stopped. Refresh to continue."
                : count
                  ? `${plural(count, "changed line")} selected`
                  : range
                    ? "Context only — no changed lines"
                    : notice ||
                      (queued.pending ? "keep selecting" : queued.notice) ||
                      "Drag code to select lines"}
        </span>
        <span
          className="text-selection-hint"
          title="Cmd/Ctrl+C copies selected right-hand code; Alt+drag selects native text; e opens the hovered line in Neovim"
        >
          Cmd/Ctrl+C to copy · Alt+drag for text
        </span>
        <div className="shortcuts">
          <button
            onClick={squash}
            disabled={
              !count || !state?.parent || working || dragging || queued.halted
            }
            title={
              state?.squashUnavailable ??
              "Queue selected lines into this change’s immediate parent"
            }
          >
            <kbd>s</kbd> squash → parent
          </button>
          <button
            onClick={undo}
            disabled={
              !queued.confirmed?.canUndo || idleActionDisabled || dragging
            }
            title={
              queued.pending
                ? "Wait for queued squashes before undoing"
                : "Undo last squash"
            }
          >
            <kbd>u</kbd> undo
          </button>
          <button onClick={clear} disabled={!range || working || dragging}>
            <kbd>esc</kbd> clear
          </button>
        </div>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
