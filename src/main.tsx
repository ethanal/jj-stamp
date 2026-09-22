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
import { refsFromSelection, specsForRefs, type RowRef } from "./optimistic";
import { SquashQueue } from "./squash-queue";
import { api, errorMessage, errorDetails, type ErrorDetail } from "./api";
import { useAppearancePreferences } from "./preferences";
import {
  FilesSidebar,
  LineCounts,
  ReviewStatusBar,
  ReviewViewer,
  RevisionGraph,
  type DiffStyle,
} from "./ReviewWorkspace";
import {
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
function readExpanded(side: "files" | "log"): boolean {
  try {
    return localStorage.getItem(`jj-stamp.${side}-expanded`) !== "false";
  } catch {
    return true;
  }
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
  const [style, setStyle] = useState<DiffStyle>(() => {
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
  const [focusRefreshPending, setFocusRefreshPending] = useState(false);
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
  const refresh = useCallback(
    async (automatic = false) => {
      const current = queue.getSnapshot();
      if (
        lock.current ||
        current.pending ||
        current.recovering ||
        (automatic && current.halted)
      )
        return;
      lock.current = true;
      setBusy("refreshing");
      if (!automatic) {
        setError("");
        setNotice("");
      }
      try {
        const next = await api<RepoState>("state");
        // A focus check must not reset the view/selection or dismiss diagnostics
        // when nothing changed. Halted queues require explicit user recovery.
        if (!automatic || next.version !== current.confirmed?.version)
          replace(next);
      } catch (error) {
        setError(error);
        setGraphRefresh((value) => value + 1);
      } finally {
        lock.current = false;
        setBusy("");
      }
    },
    [queue, replace],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onFocus = () => {
      if (document.visibilityState !== "visible") {
        setFocusRefreshPending(false);
      } else {
        setFocusRefreshPending(true);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  useEffect(() => {
    if (!focusRefreshPending) return;
    if (queued.halted) {
      setFocusRefreshPending(false);
      return;
    }
    // Coalesce focus/visibility events and wait for the user's selection and
    // optimistic work to finish. Never replace a diff underneath a drag.
    if (
      busy ||
      dragging ||
      range ||
      queued.pending ||
      queued.recovering ||
      document.visibilityState !== "visible"
    )
      return;
    const timer = setTimeout(() => {
      setFocusRefreshPending(false);
      void refresh(true);
    }, 100);
    return () => clearTimeout(timer);
  }, [
    focusRefreshPending,
    busy,
    dragging,
    range,
    queued.pending,
    queued.recovering,
    queued.halted,
    refresh,
  ]);
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
            <LineCounts
              additions={additions}
              deletions={deletions}
              label="Change line counts"
            />
          </span>
        </RevisionHeading>
        <button
          onClick={() => void refresh()}
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
        className={`workspace ${showLog ? "" : "log-collapsed"} ${showFiles ? "" : "files-collapsed"}`}
        style={
          {
            "--files-preferred-width": `${filesWidth}px`,
            "--log-preferred-width": `${logWidth}px`,
          } as CSSProperties
        }
      >
        <FilesSidebar
          files={state?.files}
          activePath={file?.path}
          source={source}
          parent={state?.parent}
          expanded={showFiles}
          width={filesWidth}
          resizeDisabled={dragging}
          navigationDisabled={working}
          onResize={setFilesWidth}
          onToggle={() => setShowFiles((value) => !value)}
          onSelect={selectFile}
        />
        <ReviewViewer
          state={state}
          source={source}
          file={file}
          renderVersion={queued.confirmed?.version ?? state?.version ?? ""}
          fileView={fileView}
          style={style}
          colorScheme={colorScheme}
          selections={selections}
          range={range}
          busy={busy}
          working={working}
          dragging={dragging}
          pending={queued.pending}
          recovering={queued.recovering}
          halted={queued.halted}
          error={error}
          diagnostics={diagnostics}
          idleActionDisabled={idleActionDisabled}
          scrollRef={scroll}
          fileSections={fileSections}
          onFileViewChange={setFileView}
          onStyleChange={setStyle}
          onSelection={select}
          onDragging={setDragging}
          onError={setError}
          onRefresh={() => void refresh()}
          onDismissError={() => {
            setError("");
            queue.clearError();
          }}
          onUndo={() => void undo()}
          loadFile={loadFile}
        />
        <RevisionGraph
          rows={log}
          source={source}
          expanded={showLog}
          width={logWidth}
          pending={queued.pending}
          loading={logLoading}
          dragging={dragging}
          idleActionDisabled={idleActionDisabled}
          hasVersion={!!logVersion.current}
          onResize={setLogWidth}
          onToggle={() => setShowLog((value) => !value)}
          onSelectRevision={(changeId) => void selectRevision(changeId)}
        />
      </div>
      <ReviewStatusBar
        count={count}
        range={range}
        pending={queued.pending}
        busy={busy}
        recovering={queued.recovering}
        halted={queued.halted}
        notice={notice}
        queueNotice={queued.notice}
        canSquash={
          !!count && !!state?.parent && !working && !dragging && !queued.halted
        }
        canUndo={
          !!queued.confirmed?.canUndo && !idleActionDisabled && !dragging
        }
        working={working}
        dragging={dragging}
        squashTitle={
          state?.squashUnavailable ??
          "Queue selected lines into this change’s immediate parent"
        }
        onSquash={squash}
        onUndo={() => void undo()}
        onClear={clear}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
