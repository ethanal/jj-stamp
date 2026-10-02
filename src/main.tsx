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
import {
  refsFromFile,
  refsFromSelection,
  specsForRefs,
  type RowRef,
} from "./optimistic";
import { ContentStore } from "./content-store";
import { RevisionNavigation } from "./revision-navigation";
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
import { useSidebarReveal } from "./useSidebarReveal";
import "./styles.css";

function readExpanded(side: "files" | "log"): boolean {
  try {
    return localStorage.getItem(`jj-stamp.${side}-expanded`) !== "false";
  } catch {
    return true;
  }
}
function App() {
  const {
    hoverSidebars,
    setHoverSidebars,
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
  // A pinned cached preview is display-only: never publish it to SquashQueue.
  const [revisionPreview, setRevisionPreview] = useState<RepoState | null>(
    null,
  );
  const state = revisionPreview ?? queued.view;
  const source =
    revisionPreview?.source ?? queued.confirmed?.source ?? state?.source;
  const contentStore = useMemo(
    () =>
      queued.confirmed
        ? new ContentStore(queued.confirmed.repo.path, {
            loadCommit: (commitId) => api("commit", { commitId }),
            loadFile: (commitId, path) =>
              api("commit-file", { commitId, path }),
          })
        : null,
    [queued.confirmed?.repo.path],
  );
  useEffect(() => () => contentStore?.dispose(), [contentStore]);
  const loadFile = useCallback(
    (path: string, version: string): Promise<FileDiffLoadedFiles> => {
      if (!contentStore || !state || state.version !== version)
        return Promise.reject(
          new Error("The displayed revision changed; reopen its context."),
        );
      // Pierre's loader type excludes deleted sides; its renderer never hydrates
      // new/deleted patches. Scope inference explicitly handles either null side.
      return contentStore.getFile(
        state.source.commitId,
        path,
      ) as Promise<FileDiffLoadedFiles>;
    },
    [contentStore, state?.source.commitId, state?.version],
  );
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
  // Refresh stays stable (it also drives initial loading), but must inspect the
  // latest selection when its response arrives, including sidebar navigation.
  const rangeRef = useRef(range);
  rangeRef.current = range;
  const [picked, setPicked] = useState<RowRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const busyRef = useRef("");
  busyRef.current = busy;
  const [visible, setVisible] = useState(
    document.visibilityState === "visible",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
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
  useLayoutEffect(() => {
    if (!contentStore) return;
    contentStore.setPaused(
      !visible ||
        !!busy ||
        !!queued.pending ||
        queued.recovering ||
        queued.halted,
    );
    if (queued.confirmed) contentStore.seed(queued.confirmed);
    contentStore.setCandidates(log, source?.commitId ?? "");
  }, [
    contentStore,
    queued.confirmed,
    log,
    source?.commitId,
    visible,
    busy,
    queued.pending,
    queued.recovering,
    queued.halted,
  ]);
  const logOperation = useRef<string | undefined>(undefined);
  const logVersion = useRef<string | undefined>(undefined);
  const logRequest = useRef(0);
  // Fresh state can authorize navigation through the existing graph while its
  // replacement loads. A later graph response can also supply a recovery token
  // when the selected source is unavailable and no fresh state can be loaded.
  useLayoutEffect(() => {
    if (queued.confirmed) logVersion.current = queued.confirmed.version;
  }, [queued.confirmed?.version]);
  const [graphRefresh, setGraphRefresh] = useState(0);
  const [showFiles, setShowFiles] = useState(() => readExpanded("files"));
  const [showLog, setShowLog] = useState(() => readExpanded("log"));
  const filesReveal = useSidebarReveal(showFiles, hoverSidebars && !dragging);
  const logReveal = useSidebarReveal(showLog, hoverSidebars && !dragging);
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
  const refreshGeneration = useRef(0);
  const pollContext = useRef({ dragging, focusRefreshPending });
  pollContext.current = { dragging, focusRefreshPending };
  const onDragging = useCallback((value: boolean) => {
    if (value) refreshGeneration.current++;
    pollContext.current.dragging = value;
    setDragging(value);
  }, []);
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
      setRevisionPreview(null);
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
  const replaceAutomatically = useCallback(
    (next: RepoState) => {
      if (next.version === queue.getSnapshot().confirmed?.version) return;
      const clearedSelection = rangeRef.current !== null;
      replace(next);
      if (clearedSelection) setNotice("Repository changed; selection cleared.");
    },
    [queue, replace],
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
      refreshGeneration.current++;
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
        if (automatic) replaceAutomatically(next);
        else replace(next);
      } catch (error) {
        setError(error);
        setGraphRefresh((value) => value + 1);
      } finally {
        lock.current = false;
        setBusy("");
      }
    },
    [queue, replace, replaceAutomatically],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    const onBlur = () => {
      // A poll started before leaving must not publish after returning, even if
      // the tab stayed visible and the response outlived the whole round trip.
      refreshGeneration.current++;
    };
    const onFocus = () => {
      refreshGeneration.current++;
      if (document.visibilityState !== "visible") {
        setFocusRefreshPending(false);
      } else {
        setFocusRefreshPending(true);
      }
    };
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, []);
  useEffect(() => {
    if (!focusRefreshPending) return;
    if (queued.halted) {
      setFocusRefreshPending(false);
      return;
    }
    // Coalesce focus/visibility events and wait for optimistic work to finish.
    // A completed selection is safe to check; never refresh underneath a drag.
    if (
      busy ||
      dragging ||
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
    queued.pending,
    queued.recovering,
    queued.halted,
    refresh,
  ]);
  useEffect(() => {
    let disposed = false;
    let delay = 2_000;
    let timer: ReturnType<typeof setTimeout>;
    const eligible = () => {
      const current = queue.getSnapshot();
      const context = pollContext.current;
      return (
        !disposed &&
        document.visibilityState === "visible" &&
        document.hasFocus() &&
        !lock.current &&
        !busyRef.current &&
        !context.dragging &&
        !context.focusRefreshPending &&
        !!current.confirmed &&
        !current.pending &&
        !current.recovering &&
        !current.halted
      );
    };
    const poll = async () => {
      const before = queue.getSnapshot();
      const generation = refreshGeneration.current;
      const selection = rangeRef.current;
      const isCurrent = () => {
        const current = queue.getSnapshot();
        return (
          eligible() &&
          generation === refreshGeneration.current &&
          before.epoch === current.epoch &&
          before.confirmed === current.confirmed &&
          selection === rangeRef.current
        );
      };
      try {
        if (!eligible()) return;
        const next = await api<RepoState>("state");
        // Never lock or dim the UI for a poll. Foreground work may overtake it;
        // discard stale results rather than replacing a newer review/projection.
        if (!isCurrent()) return;
        delay = 2_000;
        replaceAutomatically(next);
      } catch {
        // Foreground refresh still reports errors. Background failures neither
        // spam diagnostics nor retry mutations, and back off to spare the server.
        if (isCurrent()) delay = Math.min(delay * 2, 30_000);
      } finally {
        // Schedule after completion: even a slow server gets at most one poll.
        if (!disposed) timer = setTimeout(() => void poll(), delay);
      }
    };
    timer = setTimeout(() => void poll(), delay);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [queue, replaceAutomatically]);
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
      !logReveal.visible ||
      queued.pending ||
      queued.recovering ||
      busy === "switching change" ||
      (!queued.confirmed && !graphRefresh)
    )
      return;
    // Graph aliases/configuration can change without a repository operation.
    // Revalidate graph metadata even when immutable content is already cached.
    let cancelled = false;
    const request = ++logRequest.current;
    const confirmedVersion = queued.confirmed?.version;
    const isCurrent = () =>
      !cancelled &&
      request === logRequest.current &&
      confirmedVersion === queue.getSnapshot().confirmed?.version;
    // Keep existing rows and their usable authorization token during the read.
    setLogLoading(true);
    // Load immediately on startup/change selection. Only debounce after history
    // changes, so graph reads don't get ahead of a burst of queued squashes.
    const operation = queued.confirmed?.operation;
    const delay =
      logOperation.current && logOperation.current !== operation ? 120 : 0;
    const timer = setTimeout(() => {
      api<{ version: string; rows: LogRow[] }>("graph")
        .then((result) => {
          if (isCurrent()) {
            setLog(result.rows);
            logVersion.current = result.version;
            logOperation.current = operation;
          }
        })
        .catch((error) => {
          if (isCurrent()) setError(error);
        })
        .finally(() => {
          if (isCurrent()) setLogLoading(false);
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
    logReveal.visible,
    graphRefresh,
    busy === "switching change",
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
      // A read-only refresh need not interrupt browsing the current files.
      // Squash remains guarded by the operation lock until it completes.
      if (
        (lock.current &&
          busy !== "refreshing" &&
          busy !== "switching change") ||
        queue.getSnapshot().recovering
      )
        return;
      clear();
      setActivePath(path);
      // Only explicit navigation resets scroll; squash may remove the active file.
      if (fileView === "all") scrollToFile(path);
      else scroll.current?.scrollTo(0, 0);
    },
    [clear, queue, fileView, scrollToFile, busy],
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
  const squash = useCallback(
    (path?: string) => {
      const current = queue.getSnapshot();
      if (
        lock.current ||
        dragging ||
        !current.view ||
        current.recovering ||
        current.halted
      )
        return;
      if (!current.view.parent || current.view.squashUnavailable) {
        setError(
          current.view.squashUnavailable ||
            "The reviewed change needs one mutable parent.",
        );
        return;
      }
      if (!path && !count) return;
      try {
        // Read the latest projection, not the original patch: earlier queued
        // selections may already have removed part (or all) of this file.
        const refs = path ? refsFromFile(current.view, path) : picked;
        if (!refs.length) return;
        setError("");
        setNotice("");
        queue.enqueue(refs);
        clear();
      } catch (error) {
        setError(error);
      }
    },
    [queue, picked, count, dragging, clear],
  );
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
    refreshGeneration.current++;
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
  const navigationIntent = useRef(0);
  const navigationCallbacks = useRef({
    onState: (_next: RepoState) => {},
    onIntent: (_changeId: string) => {},
    onError: (_error: unknown) => {},
  });
  navigationCallbacks.current = {
    onState: (next) => {
      navigationIntent.current++;
      logVersion.current = next.version;
      replace(next);
      // Also restart an invalidated graph read when reselecting the same change
      // leaves the confirmed version unchanged.
      setGraphRefresh((value) => value + 1);
      setActivePath(next.files[0]?.path ?? "");
      scroll.current?.scrollTo(0, 0);
    },
    onIntent: (changeId) => {
      refreshGeneration.current++;
      // Invalidate outstanding graph responses synchronously, before React's
      // effect cleanup. Neither stale rows/tokens nor late failures may win over
      // a click, even when several stateful selections are coalesced.
      logRequest.current++;
      const intent = ++navigationIntent.current;
      clear();
      setError("");
      const revision = log.find(
        (row) => row.revision?.changeId === changeId,
      )?.revision;
      if (!revision || !contentStore) return;
      // A miss keeps the last useful view while the live selection loads. Never
      // fetch a speculative preview ahead of the user's actual selection POST.
      void contentStore
        .getCommit(revision.commitId, false)
        .then((cached) => {
          if (
            !cached ||
            navigationIntent.current !== intent ||
            busyRef.current !== "switching change"
          )
            return;
          const confirmed = queue.getSnapshot().confirmed;
          if (!confirmed) return;
          void contentStore.getCommit(revision.commitId).catch(() => {}); // demand promotion
          setRevisionPreview({
            ...confirmed,
            source: revision,
            files: cached.files,
            parent: null,
            targets: [],
            version: `preview:${revision.commitId}`,
            operation: "",
            canUndo: false,
            // Validate silently. The preview's null parent and navigation lock
            // still prevent squashing; show eligibility notices only once known.
            squashUnavailable: undefined,
          });
          setActivePath(cached.files[0]?.path ?? "");
          scroll.current?.scrollTo(0, 0);
        })
        .catch(() => {
          /* A cache miss cannot fail revision selection. */
        });
    },
    onError: (error) => {
      navigationIntent.current++;
      setRevisionPreview(null);
      setError(error);
      setGraphRefresh((value) => value + 1);
    },
  };
  const [navigation] = useState(
    () =>
      new RevisionNavigation({
        select: (version, changeId) => api("revision", { version, changeId }),
        onState: (next) => navigationCallbacks.current.onState(next),
        onIntent: (changeId) => navigationCallbacks.current.onIntent(changeId),
        onError: (error) => navigationCallbacks.current.onError(error),
        onBusy: (value) => {
          lock.current = value;
          busyRef.current = value ? "switching change" : "";
          setBusy(busyRef.current);
        },
      }),
  );
  useEffect(() => () => navigation.dispose(), [navigation]);
  const selectRevision = useCallback(
    (changeId: string) => {
      const current = queue.getSnapshot();
      if (
        (lock.current && busyRef.current !== "switching change") ||
        dragging ||
        current.pending ||
        current.recovering ||
        !logVersion.current
      )
        return;
      navigation.request(changeId, logVersion.current);
    },
    [queue, dragging, navigation],
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
  const squashDisabled =
    working ||
    dragging ||
    queued.halted ||
    !state?.parent ||
    !!state.squashUnavailable;
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
          hoverSidebars={hoverSidebars}
          onHoverSidebarsChange={setHoverSidebars}
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
          peeking={filesReveal.peeking}
          hoverHandlers={filesReveal.handlers}
          width={filesWidth}
          resizeDisabled={dragging}
          navigationDisabled={
            dragging ||
            queued.recovering ||
            (!!busy && busy !== "refreshing" && busy !== "switching change")
          }
          onResize={setFilesWidth}
          onToggle={() => {
            filesReveal.dismiss();
            setShowFiles((value) => !value);
          }}
          onSelect={selectFile}
        />
        <ReviewViewer
          state={state}
          source={source}
          file={file}
          renderVersion={state?.version ?? ""}
          contentIdentity={JSON.stringify([
            state?.repo.path,
            state?.source.commitId,
          ])}
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
          squashDisabled={squashDisabled}
          onSquashFile={squash}
          scrollRef={scroll}
          fileSections={fileSections}
          onFileViewChange={setFileView}
          onStyleChange={setStyle}
          onSelection={select}
          onDragging={onDragging}
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
          peeking={logReveal.peeking}
          hoverHandlers={logReveal.handlers}
          width={logWidth}
          pending={queued.pending}
          loading={busy === "switching change" ? false : logLoading}
          dragging={dragging}
          idleActionDisabled={
            busy === "switching change" ? false : idleActionDisabled
          }
          hasVersion={!!logVersion.current}
          onResize={setLogWidth}
          onToggle={() => {
            logReveal.dismiss();
            setShowLog((value) => !value);
          }}
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
        showSquash={!state?.squashUnavailable}
        canSquash={!!count && !squashDisabled}
        canUndo={
          !!queued.confirmed?.canUndo && !idleActionDisabled && !dragging
        }
        working={working}
        dragging={dragging}
        squashTitle={
          state?.squashUnavailable ??
          "Queue selected lines into this change’s immediate parent"
        }
        onSquash={() => squash()}
        onUndo={() => void undo()}
        onClear={clear}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
