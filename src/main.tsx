import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { FileDiffLoadedFiles, SelectedLineRange } from "@pierre/diffs";
import type { RepoState, Selections } from "./types";
import { CodeDiff } from "./CodeDiff";
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
const short = (id?: string) => id?.slice(0, 8) ?? "—";
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function App() {
  const [state, setState] = useState<RepoState | null>(null);
  const [view, setView] = useState<"files" | "log">("files");
  const [activePath, setActivePath] = useState("");
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [log, setLog] = useState("");
  const [logLoading, setLogLoading] = useState(false);
  const lock = useRef(false);
  const scroll = useRef<HTMLDivElement>(null);
  const file =
    state?.files.find((file) => file.path === activePath) ?? state?.files[0];
  const count = Object.values(selections).reduce(
    (sum, lines) => sum + lines.length,
    0,
  );
  const clear = useCallback(() => {
    setRange(null);
    setSelections({});
    setNotice("");
  }, []);
  const accept = useCallback((next: RepoState) => {
    setState(next);
    setRange(null);
    setSelections({});
    setActivePath((current) =>
      next.files.some((file) => file.path === current)
        ? current
        : (next.files[0]?.path ?? ""),
    );
  }, []);
  const refresh = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy("refreshing");
    setError("");
    setNotice("");
    try {
      accept(await api<RepoState>("state"));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [accept]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (view !== "log" || !state) return;
    let cancelled = false;
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
    return () => {
      cancelled = true;
    };
  }, [view, state?.version]);
  useEffect(() => {
    scroll.current?.scrollTo(0, 0);
  }, [activePath, view]);
  const switchView = useCallback(
    (next: "files" | "log") => {
      if (lock.current) return;
      clear();
      setView(next);
    },
    [clear],
  );
  const selectFile = useCallback(
    (path: string) => {
      if (lock.current) return;
      clear();
      setView("files");
      setActivePath(path);
    },
    [clear],
  );
  const select = useCallback(
    (next: SelectedLineRange, selected: Selections) => {
      if (lock.current) return;
      setRange(next);
      setSelections(selected);
      setNotice("");
    },
    [],
  );
  const squash = useCallback(async () => {
    if (lock.current || dragging || !count || !state || view !== "files")
      return;
    if (!state.parent) {
      setError(
        state.squashUnavailable || "The working copy needs one mutable parent.",
      );
      return;
    }
    lock.current = true;
    setBusy("squashing");
    setError("");
    setNotice("");
    try {
      const result = await api<{ state: RepoState; warning?: string }>(
        "squash-lines",
        {
          version: state.version,
          selections: Object.entries(selections).map(([id, lines]) => ({
            id,
            lines,
          })),
        },
      );
      accept(result.state);
      setNotice(`${plural(count, "line")} squashed into @-`);
      if (result.warning) setError(result.warning);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [state, selections, count, dragging, view, accept]);
  const undo = useCallback(async () => {
    if (lock.current || dragging || !state?.canUndo) return;
    lock.current = true;
    setBusy("undoing");
    setError("");
    try {
      const result = await api<{ state: RepoState }>("undo", {
        version: state.version,
      });
      accept(result.state);
      setNotice("Squash undone");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [state, dragging, accept]);
  const reset = useCallback(async () => {
    if (lock.current || !state?.repo.demo) return;
    lock.current = true;
    setBusy("resetting");
    setError("");
    try {
      const result = await api<{ state: RepoState }>("reset", {
        version: state.version,
      });
      accept(result.state);
      setView("files");
      setNotice("Fresh demo");
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setBusy("");
    }
  }, [state, accept]);
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
          void squash();
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
          switchView("log");
          break;
        case "f":
          event.preventDefault();
          switchView("files");
          break;
        case "escape":
          if (!lock.current && !dragging) {
            clear();
            setError("");
          }
          break;
      }
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [squash, undo, refresh, switchView, clear, dragging]);
  const additions =
    state?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions =
    state?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  return (
    <div className="app">
      <header className="topbar">
        <span className="app-name">fold</span>
        <span className="divider">/</span>
        <span>{state?.repo.name ?? "…"}</span>
        <span className="source-description">{state?.source.description}</span>
        <span className="revision">
          @ <span>→</span> @-
        </span>
        <button onClick={refresh} disabled={!!busy} title="Refresh (r)">
          refresh <kbd>r</kbd>
        </button>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <nav className="view-tabs" aria-label="View">
            <button
              className={view === "files" ? "active" : ""}
              aria-pressed={view === "files"}
              onClick={() => switchView("files")}
            >
              Files <span>{state?.files.length ?? 0}</span>
            </button>
            <button
              className={view === "log" ? "active" : ""}
              aria-pressed={view === "log"}
              onClick={() => switchView("log")}
            >
              Log
            </button>
          </nav>
          <div className="sidebar-content">
            {view === "files" ? (
              <nav aria-label="Changed files" className="file-list">
                {state?.files.map((item, index, files) => {
                  const folder = item.path.includes("/")
                    ? item.path.slice(0, item.path.lastIndexOf("/") + 1)
                    : "";
                  const previous = files[index - 1]?.path;
                  const sameFolder =
                    previous?.slice(0, previous.lastIndexOf("/") + 1) ===
                    folder;
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
                        disabled={!!busy}
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
                        <span className="file-count">
                          {item.additions + item.deletions}
                        </span>
                      </button>
                    </div>
                  );
                })}
              </nav>
            ) : (
              <div className="log-label">$ jj log</div>
            )}
          </div>
          <div className="sidebar-footer">
            <span className="added">+{additions}</span>
            <span className="removed">−{deletions}</span>
            {state?.repo.demo && (
              <button
                onClick={reset}
                disabled={!!busy}
                title="Create a fresh demo repository; keep the old one on disk"
              >
                reset demo
              </button>
            )}
          </div>
        </aside>
        <main className="viewer">
          <div className="file-bar">
            <span>
              {view === "log" ? "jj log" : (file?.path ?? "Working copy")}
            </span>
            <span className="file-bar-meta">
              {view === "files" && file ? (
                <>
                  <span className="added">+{file.additions}</span>
                  <span className="removed">−{file.deletions}</span>
                </>
              ) : (
                short(state?.source.changeId)
              )}
            </span>
          </div>
          {error && (
            <div className="error" role="alert">
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss error">
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
            ) : view === "log" ? (
              <pre className="jj-log" aria-label="jj log output">
                {logLoading ? "Loading…" : log}
              </pre>
            ) : !file ? (
              <div className="empty">
                No changes in @.
                {state.canUndo && (
                  <button onClick={undo} disabled={!!busy}>
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
                key={`${state.version}:${file.path}`}
                file={file}
                version={state.version}
                range={range}
                disabled={!!busy}
                onSelection={select}
                onDragging={setDragging}
                onError={setError}
                loadFile={loadFile}
              />
            )}
          </div>
        </main>
      </div>
      <footer className="statusbar">
        <span className={count ? "selection-status" : ""} role="status">
          {busy
            ? `${busy}…`
            : count
              ? `${plural(count, "changed line")} selected`
              : range
                ? "Context only — no changed lines"
                : notice ||
                  (view === "log"
                    ? "$ jj log --no-pager"
                    : "Drag code to select lines")}
        </span>
        <div className="shortcuts">
          <button
            onClick={squash}
            disabled={
              !count || !state?.parent || !!busy || dragging || view !== "files"
            }
            title={
              state?.squashUnavailable ??
              "Squash selected lines from @ into @- immediately"
            }
          >
            <kbd>s</kbd> squash → @-
          </button>
          <button
            onClick={undo}
            disabled={!state?.canUndo || !!busy || dragging}
          >
            <kbd>u</kbd> undo
          </button>
          <button onClick={clear} disabled={!range || !!busy || dragging}>
            <kbd>esc</kbd> clear
          </button>
        </div>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
