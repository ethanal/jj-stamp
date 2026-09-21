import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createRoot } from "react-dom/client";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import type { RepoState, Selections } from "./types";
import { CodeDiff } from "./CodeDiff";
import { refsFromSelection, specsForRefs, type RowRef } from "./optimistic";
import { SquashQueue } from "./squash-queue";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";

async function api<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/${route}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fold-Request": "1",
          },
          body: JSON.stringify(body),
        },
  );
  const value = await response.json();
  if (!response.ok)
    throw new Error(value.error || `Request failed (${response.status}).`);
  return value;
}
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
function App() {
  const [queue] = useState(
    () =>
      new SquashQueue({
        squash: (input) => api("squash-lines", input),
        readState: () => api<RepoState>("state"),
      }),
  );
  const queued = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  const state = queued.view;
  const [activePath, setActivePath] = useState("");
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [picked, setPicked] = useState<RowRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const [localError, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [log, setLog] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const [showLog, setShowLog] = useState(true);
  const [style, setStyle] = useState<"unified" | "split">(() => {
    try {
      return localStorage.getItem("fold.diff-style") === "split"
        ? "split"
        : "unified";
    } catch {
      return "unified";
    }
  });
  const lock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
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
  const error = localError || queued.error;
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
      setError((error as Error).message);
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
      localStorage.setItem("fold.diff-style", style);
    } catch {
      /* Preference storage is optional. */
    }
  }, [style]);
  useEffect(() => {
    if (!showLog || !queued.confirmed || queued.pending || queued.recovering)
      return;
    let cancelled = false;
    // Don't put graph reads in front of a burst of interactive squash requests.
    const timer = setTimeout(() => {
      setLogLoading(true);
      api<{ version: string; output: string }>("log")
        .then((result) => {
          if (!cancelled) setLog(result.output);
        })
        .catch((error) => {
          if (!cancelled) setError(error.message);
        })
        .finally(() => {
          if (!cancelled) setLogLoading(false);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [queued.confirmed?.version, queued.pending, queued.recovering, showLog]);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
  }, [file?.path]);
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
    },
    [clear, queue],
  );
  const select = useCallback(
    (next: SelectedLineRange, selected: Selections) => {
      const current = queue.getSnapshot();
      if (lock.current || current.recovering || !current.view) return;
      try {
        setPicked(refsFromSelection(current.view, selected));
        setRange(next);
        setNotice("");
      } catch (error) {
        setError((error as Error).message);
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
          "The working copy needs one mutable parent.",
      );
      return;
    }
    setError("");
    setNotice("");
    try {
      queue.enqueue(picked);
      clear();
    } catch (error) {
      setError((error as Error).message);
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
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [queue, dragging, replace]);
  const reset = useCallback(async () => {
    const current = queue.getSnapshot();
    if (
      lock.current ||
      current.pending ||
      current.recovering ||
      !current.confirmed?.repo.demo
    )
      return;
    lock.current = true;
    setBusy("resetting");
    setError("");
    try {
      const result = await api<{ state: RepoState }>("reset", {
        version: current.confirmed.version,
      });
      replace(result.state);
      setNotice("Fresh demo");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [queue, replace]);
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
          'input, textarea, select, [contenteditable="true"]',
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
          scroll.current?.querySelector<HTMLElement>(".code-surface")?.focus();
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
  }, [squash, undo, refresh, queue, clear, dragging]);
  const additions =
    state?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions =
    state?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const idleActionDisabled = working || queued.pending > 0;
  return (
    <div className="app">
      <header className="topbar">
        <span className="app-name">fold</span>
        <span className="divider">/</span>
        <span>{state?.repo.name ?? "…"}</span>
        <span className="source-description">{state?.source.description}</span>
        <span className="commit-totals">
          <span>@</span>
          <Counts
            additions={additions}
            deletions={deletions}
            label="Working copy line counts"
          />
        </span>
        <button
          onClick={() => setShowLog((value) => !value)}
          aria-label="Toggle log panel"
          aria-pressed={showLog}
          title="Toggle log panel (l)"
        >
          Log
        </button>
        <button
          onClick={refresh}
          disabled={idleActionDisabled}
          title="Refresh (r)"
        >
          refresh <kbd>r</kbd>
        </button>
      </header>
      <div className={`workspace ${showLog ? "with-log" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-heading">
            Files <span>{state?.files.length ?? 0}</span>
          </div>
          <div className="sidebar-content">
            <nav aria-label="Changed files" className="file-list">
              {state?.files.map((item, index, files) => {
                const folder = item.path.includes("/")
                  ? item.path.slice(0, item.path.lastIndexOf("/") + 1)
                  : "";
                const previous = files[index - 1]?.path;
                const sameFolder =
                  previous?.slice(0, previous.lastIndexOf("/") + 1) === folder;
                return (
                  <div key={item.path}>
                    {folder && !sameFolder && (
                      <div className="folder">{folder}</div>
                    )}
                    <button
                      className={`file-item ${file?.path === item.path ? "active" : ""}`}
                      aria-current={
                        file?.path === item.path ? "true" : undefined
                      }
                      onClick={() => selectFile(item.path)}
                      title={item.path}
                      disabled={working}
                    >
                      <span className="file-status">
                        {item.unsupported
                          ? "·"
                          : item.patch.includes("new file mode")
                            ? "A"
                            : item.patch.includes("deleted file mode")
                              ? "D"
                              : "M"}
                      </span>
                      <span className="filename">
                        {item.path.split("/").at(-1)}
                      </span>
                      <Counts
                        additions={item.additions}
                        deletions={item.deletions}
                      />
                    </button>
                  </div>
                );
              })}
            </nav>
          </div>
          <div className="sidebar-footer">
            <span>@ → @-</span>
            {state?.repo.demo && (
              <button
                onClick={reset}
                disabled={idleActionDisabled}
                title="Create a fresh demo repository; keep the old one on disk"
              >
                reset demo
              </button>
            )}
          </div>
        </aside>
        <main className="viewer">
          <div className="file-bar">
            <span>{file?.path ?? "Working copy"}</span>
            <div className="file-bar-tools">
              {file && (
                <Counts additions={file.additions} deletions={file.deletions} />
              )}
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
              <span>
                {error}
                {queued.halted && (
                  <button
                    className="retry"
                    onClick={refresh}
                    disabled={idleActionDisabled}
                  >
                    refresh to continue
                  </button>
                )}
              </span>
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
          <div className="viewer-scroll" ref={scroll}>
            {!state ? (
              <div className="empty">
                {busy
                  ? "Opening repository…"
                  : "Unable to open repository. Press r to retry."}
              </div>
            ) : !file ? (
              <div className="empty">
                {queued.pending ? "All changes queued." : "No changes in @."}
                {state.canUndo && !queued.pending && (
                  <button onClick={undo} disabled={working}>
                    undo <kbd>u</kbd>
                  </button>
                )}
              </div>
            ) : file.unsupported ? (
              <div className="unsupported">
                <p>{file.unsupported}</p>
                <pre>{file.patch}</pre>
              </div>
            ) : (
              <CodeDiff
                key={`${queued.epoch}:${file.path}`}
                file={file}
                version={queued.confirmed?.version ?? state.version}
                renderKey={`${queued.epoch}`}
                style={style}
                selections={selections}
                range={range}
                disabled={working || queued.halted}
                contextDisabled={queued.pending > 0 || queued.recovering}
                onSelection={select}
                onDragging={setDragging}
                onError={setError}
                loadFile={loadFile}
              />
            )}
          </div>
        </main>
        {showLog && (
          <aside className="log-panel" aria-label="Revision graph">
            <div className="log-header">
              <span>jj log</span>
              <span className="log-status">
                {queued.pending
                  ? `${queued.pending} queued`
                  : logLoading
                    ? "updating…"
                    : ""}
              </span>
            </div>
            <pre className="jj-log" aria-label="jj log output">
              {log || (logLoading ? "Loading…" : "")}
            </pre>
          </aside>
        )}
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
        <div className="shortcuts">
          <button
            onClick={squash}
            disabled={
              !count || !state?.parent || working || dragging || queued.halted
            }
            title={
              state?.squashUnavailable ?? "Queue selected lines from @ into @-"
            }
          >
            <kbd>s</kbd> squash → @-
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
