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
import { advanceVimSelection, firstVimSelection } from "./vim-squash";
import type { VimCursorRequest } from "./vim-navigation";
import { ContentStore } from "./content-store";
import { RevisionNavigation } from "./revision-navigation";
import { FilesystemRefresh, parseRepositoryChange } from "./filesystem-refresh";
import { SquashQueue } from "./squash-queue";
import { api, errorMessage, errorDetails, type ErrorDetail } from "./api";
import { DiffFontSizeContext } from "./DiffRuntime";
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
import { ShortcutsDialog } from "./ShortcutsDialog";
import { useSidebarReveal } from "./useSidebarReveal";
import { useScrollActiveFile } from "./useScrollActiveFile";
import "./styles.css";

function readExpanded(side: "files" | "log"): boolean {
  try {
    return localStorage.getItem(`jj-stamp.${side}-expanded`) !== "false";
  } catch {
    return true;
  }
}

function retainActivePath(files: RepoState["files"], current: string): string {
  return files.some((file) => file.path === current)
    ? current
    : (files[0]?.path ?? "");
}

function App() {
  const {
    fontSize,
    setFontSize,
    vimMode,
    setVimMode,
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
    filesPeekWidth,
    setFilesPeekWidth,
    logPeekWidth,
    setLogPeekWidth,
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
  const [navigationTarget, setNavigationTarget] = useState<string | null>(null);
  const [previewUnavailable, setPreviewUnavailable] = useState(false);
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
  const [vimCursorRequest, setVimCursorRequest] =
    useState<VimCursorRequest | null>(null);
  const vimCursorRequestId = useRef(0);
  const [picked, setPicked] = useState<RowRef[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState("");
  const busyRef = useRef("");
  busyRef.current = busy;
  const [focused, setFocused] = useState(() => document.hasFocus());
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
  const [logFocusRequest, setLogFocusRequest] = useState(0);
  const [filesFocusRequest, setFilesFocusRequest] = useState(0);
  const [openRevisionId, setOpenRevisionId] = useState<string | null>(null);
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
  const autoRefreshContext = useRef({ dragging, focusRefreshPending });
  autoRefreshContext.current = { dragging, focusRefreshPending };
  const filesystemRefresh = useRef<FilesystemRefresh | null>(null);
  const onDragging = useCallback((value: boolean) => {
    if (value) refreshGeneration.current++;
    autoRefreshContext.current.dragging = value;
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
  const [revisionScrollRequest, setRevisionScrollRequest] = useState(0);
  useLayoutEffect(() => {
    if (!revisionScrollRequest) return;
    if (fileView === "all") scrollToFile(activePath);
    else scroll.current?.scrollTo(0, 0);
  }, [revisionScrollRequest, fileView, scrollToFile]);
  const file =
    state?.files.find((file) => file.path === activePath) ?? state?.files[0];
  const { path: pickerPath, reset: resetPickerPath } = useScrollActiveFile(
    fileView === "all",
    state?.files,
    file?.path,
    scroll,
    fileSections,
  );
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
  const error = [
    queued.error &&
      `Squash in ${queued.confirmed?.source.changeIdPrefix ?? queued.confirmed?.source.changeId ?? "the original change"}: ${queued.error}`,
    localError?.message,
  ]
    .filter(Boolean)
    .join("\n\n");
  const diagnostics = [...queued.errorDetails, ...(localError?.details ?? [])];
  const clear = useCallback(() => {
    setVimCursorRequest(null);
    setRange(null);
    setPicked([]);
    setNotice("");
  }, []);
  const replace = useCallback(
    (next: RepoState) => {
      setRevisionPreview(null);
      queue.replace(next);
      clear();
      setActivePath((current) => retainActivePath(next.files, current));
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
      // A quiet read started before leaving must not publish after returning.
      refreshGeneration.current++;
      setFocused(false);
    };
    const onFocus = () => {
      refreshGeneration.current++;
      setFocused(document.hasFocus());
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
    const eligible = () => {
      const current = queue.getSnapshot();
      const context = autoRefreshContext.current;
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
    const controller = new FilesystemRefresh({
      eligible,
      operation: () => queue.getSnapshot().confirmed?.operation,
      refresh: async () => {
        const before = queue.getSnapshot();
        const generation = refreshGeneration.current;
        const selection = rangeRef.current;
        const next = await api<RepoState>("state");
        // Never lock or dim the UI for a filesystem-triggered check. Foreground
        // work may overtake it; retain the invalidation, not the stale response.
        const current = queue.getSnapshot();
        if (
          !eligible() ||
          generation !== refreshGeneration.current ||
          before.epoch !== current.epoch ||
          before.confirmed !== current.confirmed ||
          selection !== rangeRef.current
        )
          return false;
        replaceAutomatically(next);
        return true;
      },
    });
    filesystemRefresh.current = controller;
    return () => {
      disposed = true;
      controller.dispose();
      filesystemRefresh.current = null;
    };
  }, [queue, replaceAutomatically]);
  useEffect(() => {
    filesystemRefresh.current?.wake();
  }, [focused, visible, busy, dragging, focusRefreshPending, queued]);
  useEffect(() => {
    if (!focused || !visible || !queued.confirmed) return;
    const events = new EventSource("/api/events");
    // Establishing/re-establishing observation needs one catch-up check: changes
    // may have happened between the last state read and attaching the watcher.
    events.addEventListener("ready", () => {
      filesystemRefresh.current?.changed({ workspace: true, heads: null });
    });
    events.addEventListener("change", (event) => {
      const change = parseRepositoryChange((event as MessageEvent).data);
      if (change) filesystemRefresh.current?.changed(change);
    });
    // Watch limits/unsupported filesystems fall back to focus/manual refresh,
    // not a reconnect or state-polling loop. Network disconnects reconnect via SSE.
    events.addEventListener("unavailable", () => events.close());
    return () => events.close();
  }, [focused, visible, !!queued.confirmed]);
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
      queued.pending ||
      queued.recovering ||
      busy === "switching change" ||
      (!queued.confirmed && !graphRefresh)
    )
      return;
    // Keep the graph warm even while collapsed. Hovering/pinning must neither
    // trigger a fresh read nor cancel an in-flight background update.
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
    (path: string, { preserveScroll = false } = {}) => {
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
      resetPickerPath();
      setActivePath(path);
      // Sidebar navigation reveals the heading. Vim boundary motion instead
      // lets CodeDiff scroll only as far as needed to reveal its new cursor.
      if (!preserveScroll) {
        if (fileView === "all") scrollToFile(path);
        else scroll.current?.scrollTo(0, 0);
      }
    },
    [clear, queue, fileView, scrollToFile, busy, resetPickerPath],
  );
  const select = useCallback(
    (path: string, next: SelectedLineRange | null, selected: Selections) => {
      const current = queue.getSnapshot();
      if (
        lock.current ||
        revisionPreview ||
        current.recovering ||
        !current.view
      )
        return;
      try {
        if (next) {
          resetPickerPath();
          setActivePath(path);
        }
        setVimCursorRequest(null);
        setPicked(refsFromSelection(current.view, selected));
        setRange(next);
        setNotice("");
      } catch (error) {
        setError(error);
        clear();
      }
    },
    [queue, clear, revisionPreview, resetPickerPath],
  );
  const squash = useCallback(
    (path?: string) => {
      const current = queue.getSnapshot();
      if (
        lock.current ||
        dragging ||
        revisionPreview ||
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
      let enqueued = false;
      try {
        // Read the latest projection, not the original patch: earlier queued
        // selections may already have removed part (or all) of this file.
        const refs = path ? refsFromFile(current.view, path) : picked;
        if (!refs.length) return;
        setError("");
        setNotice("");
        queue.enqueue(refs);
        enqueued = true;
        const snapshot = queue.getSnapshot();
        const projected =
          snapshot.halted || snapshot.recovering ? null : snapshot.view;
        if (vimMode && !path && range && file && projected) {
          let nextFile = projected.files.find(
            (entry) => entry.path === file.path,
          );
          let next = advanceVimSelection(file, nextFile, range, style, refs);
          if (!nextFile) {
            nextFile = projected.files.find(
              (entry) => !entry.unsupported && entry.hunks.length,
            );
            next = nextFile ? firstVimSelection(nextFile, style) : null;
          }
          if (next && nextFile) {
            clear();
            setActivePath(nextFile.path);
            setVimCursorRequest({
              request: ++vimCursorRequestId.current,
              path: nextFile.path,
              point: {
                line: next.range.end,
                side: next.range.endSide ?? next.range.side ?? "additions",
              },
            });
            return;
          }
        }
        clear();
      } catch (error) {
        if (enqueued) clear();
        setError(error);
      }
    },
    [
      queue,
      picked,
      count,
      dragging,
      clear,
      vimMode,
      range,
      file,
      style,
      revisionPreview,
    ],
  );
  const undo = useCallback(async () => {
    const current = queue.getSnapshot();
    if (
      lock.current ||
      dragging ||
      current.pending ||
      current.recovering ||
      revisionPreview ||
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
  }, [queue, dragging, replace, revisionPreview]);
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
      setNavigationTarget(null);
      setPreviewUnavailable(false);
      // Keep the reading position when a snapshot becomes the live revision.
      const wasPreviewed =
        revisionPreview?.source.changeId === next.source.changeId;
      replace(next);
      // Also restart an invalidated graph read when reselecting the same change
      // leaves the confirmed version unchanged.
      setGraphRefresh((value) => value + 1);
      if (!wasPreviewed) setRevisionScrollRequest((value) => value + 1);
    },
    onIntent: (changeId) => {
      refreshGeneration.current++;
      // Invalidate outstanding graph responses synchronously, before React's
      // effect cleanup. Neither stale rows/tokens nor late failures may win over
      // a click, even when several stateful selections are coalesced.
      logRequest.current++;
      const intent = ++navigationIntent.current;
      setNavigationTarget(changeId);
      setPreviewUnavailable(false);
      clear();
      setError("");
      // @ resolves live on the server, so it cannot reuse a graph-row preview.
      if (changeId === "@") setRevisionPreview(null);
      const revision = log.find(
        (row) => row.revision?.changeId === changeId,
      )?.revision;
      if (!revision || !contentStore) return;
      // During a squash this is a user-requested immutable read, not a live
      // source switch. Demand reads bypass paused speculation and can miss cache.
      // Ordinary navigation still uses cached-only previews beside its live POST.
      const deferred = queue.getSnapshot().pending > 0;
      void contentStore
        .getCommit(revision.commitId, deferred)
        .then((cached) => {
          if (
            !cached ||
            navigationIntent.current !== intent ||
            busyRef.current !== "switching change"
          )
            return;
          const confirmed = queue.getSnapshot().confirmed;
          if (!confirmed) return;
          // Cached-only probes need promotion. A deferred demand read already
          // did this; repeating it would refetch a snapshot too large to cache.
          if (!deferred)
            void contentStore.getCommit(revision.commitId).catch(() => {});
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
          setActivePath((current) => retainActivePath(cached.files, current));
          setRevisionScrollRequest((value) => value + 1);
        })
        .catch(() => {
          // A missing/unsupported snapshot cannot cancel queued work or trigger
          // an early stateful selection. Still open the live change after drain.
          if (deferred && navigationIntent.current === intent)
            setPreviewUnavailable(true);
        });
    },
    onError: (error) => {
      setOpenRevisionId(null);
      navigationIntent.current++;
      setNavigationTarget(null);
      setPreviewUnavailable(false);
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
  useLayoutEffect(() => {
    const settle = () => {
      const current = queue.getSnapshot();
      // Hold the navigation lock across the whole drain and live handoff. React
      // may not have rendered the final acknowledgement yet: use its fresh token
      // synchronously, before another click or background refresh can intervene.
      if (current.halted || current.recovering) {
        // A failed/warned queue must never be cleared by an automatic replace().
        if (navigation.cancelDeferred()) {
          navigationIntent.current++;
          setNavigationTarget(null);
          setPreviewUnavailable(false);
          setRevisionPreview(null);
          setOpenRevisionId(null);
          clear();
          setNotice("Navigation canceled because squashing stopped.");
        }
      } else if (!current.pending && current.confirmed) {
        navigation.resume(current.confirmed.version);
      }
    };
    const unsubscribe = queue.subscribe(settle);
    settle();
    return unsubscribe;
  }, [navigation, queue, clear]);
  const selectRevision = useCallback(
    (changeId: string, open = false) => {
      const current = queue.getSnapshot();
      if (
        (lock.current && busyRef.current !== "switching change") ||
        dragging ||
        current.recovering ||
        !logVersion.current
      )
        return;
      setOpenRevisionId(open ? changeId : null);
      if (open) {
        // Closing the graph must not wait for the live selection or diff load.
        // Keep focus outside the hidden graph while that work continues.
        logReveal.dismiss();
        setShowLog(false);
        scroll.current?.focus({ preventScroll: true });
      }
      if (current.pending && changeId === current.confirmed?.source.changeId) {
        // Returning to the source cancels only an unsent handoff, never a squash.
        navigation.cancelDeferred();
        navigationIntent.current++;
        setNavigationTarget(null);
        setPreviewUnavailable(false);
        setRevisionPreview(null);
        clear();
        setActivePath((path) => retainActivePath(current.view!.files, path));
        setRevisionScrollRequest((value) => value + 1);
        return;
      }
      // Arrow/j/k navigation may have already selected this revision. Enter
      // doesn't need another request once that selection is acknowledged.
      if (
        open &&
        !lock.current &&
        current.confirmed?.source.changeId === changeId
      )
        return;
      navigation.request(changeId, current.pending ? null : logVersion.current);
    },
    [queue, dragging, navigation, logReveal.dismiss, clear],
  );
  useLayoutEffect(() => {
    if (!openRevisionId || busy) return;
    setOpenRevisionId(null);
    if (
      queued.confirmed?.source.changeId !== openRevisionId ||
      document.activeElement !== scroll.current
    )
      return;
    // Move into the confirmed diff once ready, unless the user moved focus
    // elsewhere while loading. Empty/unsupported revisions keep viewer focus.
    const surface = fileSections.current
      .get(file?.path ?? "")
      ?.querySelector<HTMLElement>(".code-surface");
    (surface ?? scroll.current)?.focus({ preventScroll: true });
  }, [openRevisionId, busy, queued.confirmed?.source.changeId, file?.path]);
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
        case "@":
          event.preventDefault();
          selectRevision("@");
          break;
        case "l":
          event.preventDefault();
          setOpenRevisionId(null);
          if (!showLog) setLogFocusRequest((value) => value + 1);
          setShowLog((value) => !value);
          break;
        case "f":
          event.preventDefault();
          setOpenRevisionId(null);
          if (!showFiles) setFilesFocusRequest((value) => value + 1);
          setShowFiles((value) => !value);
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
  }, [
    squash,
    undo,
    refresh,
    queue,
    clear,
    dragging,
    showFiles,
    showLog,
    selectRevision,
  ]);
  const additions =
    state?.files.reduce((sum, file) => sum + file.additions, 0) ?? 0;
  const deletions =
    state?.files.reduce((sum, file) => sum + file.deletions, 0) ?? 0;
  const idleActionDisabled = working || queued.pending > 0;
  const squashDisabled =
    working ||
    !!revisionPreview ||
    dragging ||
    queued.halted ||
    !state?.parent ||
    !!state.squashUnavailable;
  const squashSourceLabel =
    queued.confirmed?.source.changeIdPrefix ??
    queued.confirmed?.source.changeId;
  const destinationLabel =
    navigationTarget === "@"
      ? "the working copy"
      : (log.find((row) => row.revision?.changeId === navigationTarget)
          ?.revision?.changeIdPrefix ?? navigationTarget);
  const navigationNotice =
    navigationTarget && (queued.pending || revisionPreview)
      ? [
          revisionPreview
            ? `Read-only snapshot of ${source?.changeIdPrefix ?? source?.changeId}.`
            : "Read-only while navigation is pending.",
          queued.pending
            ? `Finishing squashes in ${squashSourceLabel}; then opening ${destinationLabel}.`
            : `Validating the live revision of ${destinationLabel}.`,
          previewUnavailable
            ? "Snapshot unavailable; waiting for the live revision."
            : revisionPreview
              ? "The diff may change before squashing is enabled."
              : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";
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
            <LineCounts
              additions={additions}
              deletions={deletions}
              label="Change line counts"
            />
          </span>
        </RevisionHeading>
        <div className="toolbar-actions">
          <button
            className="action-button"
            onClick={() => void refresh()}
            disabled={idleActionDisabled}
            title="Refresh repository"
          >
            Refresh
          </button>
          <SettingsDialog
            fontSize={fontSize}
            onFontSizeChange={setFontSize}
            colorScheme={colorScheme}
            onColorSchemeChange={setColorScheme}
            hoverSidebars={hoverSidebars}
            onHoverSidebarsChange={setHoverSidebars}
            vimMode={vimMode}
            onVimModeChange={setVimMode}
            disabled={dragging}
          />
        </div>
      </header>
      <ShortcutsDialog disabled={dragging} />
      <div
        className={`workspace ${showLog ? "" : "log-collapsed"} ${showFiles ? "" : "files-collapsed"}`}
        style={
          {
            "--files-preferred-width": `${filesWidth}px`,
            "--log-preferred-width": `${logWidth}px`,
            "--files-peek-width": `${filesPeekWidth}px`,
            "--log-peek-width": `${logPeekWidth}px`,
          } as CSSProperties
        }
      >
        <FilesSidebar
          focusRequest={filesFocusRequest}
          vimMode={vimMode}
          files={state?.files}
          activePath={pickerPath}
          source={source}
          parent={state?.parent}
          expanded={showFiles}
          peeking={filesReveal.peeking}
          hoverHandlers={filesReveal.handlers}
          width={filesReveal.peeking ? filesPeekWidth : filesWidth}
          resizeDisabled={dragging}
          navigationDisabled={
            dragging ||
            queued.recovering ||
            (!!busy && busy !== "refreshing" && busy !== "switching change")
          }
          onResize={filesReveal.peeking ? setFilesPeekWidth : setFilesWidth}
          onToggle={() => {
            filesReveal.dismiss();
            setShowFiles((value) => !value);
          }}
          onSelect={selectFile}
        />
        <DiffFontSizeContext.Provider value={fontSize}>
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
            vimMode={vimMode}
            vimCursorRequest={vimCursorRequest}
            selections={selections}
            range={range}
            busy={busy}
            working={working || !!revisionPreview}
            readOnlyPreview={!!revisionPreview}
            navigationNotice={navigationNotice}
            onReturnToSource={
              queued.pending && navigationTarget && queued.confirmed
                ? () => selectRevision(queued.confirmed!.source.changeId)
                : undefined
            }
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
            onFileViewChange={(view) => {
              // Enter one-file mode on the file shown as selected in the picker.
              if (view === "single" && pickerPath && pickerPath !== file?.path)
                selectFile(pickerPath);
              setFileView(view);
            }}
            onNavigateFile={(path) =>
              selectFile(path, { preserveScroll: true })
            }
            onStyleChange={setStyle}
            onSelection={select}
            onDragging={onDragging}
            onError={setError}
            onRefresh={() => void refresh()}
            onDismissError={() => {
              setError("");
              queue.clearError();
            }}
            loadFile={loadFile}
          />
        </DiffFontSizeContext.Provider>
        <RevisionGraph
          focusRequest={logFocusRequest}
          vimMode={vimMode}
          rows={log}
          source={source}
          expanded={showLog}
          peeking={logReveal.peeking}
          hoverHandlers={logReveal.handlers}
          width={logReveal.peeking ? logPeekWidth : logWidth}
          pending={queued.pending}
          loading={busy === "switching change" ? false : logLoading}
          switching={busy === "switching change"}
          dragging={dragging}
          idleActionDisabled={busy === "switching change" ? false : working}
          hasVersion={!!logVersion.current}
          onResize={logReveal.peeking ? setLogPeekWidth : setLogWidth}
          onToggle={() => {
            setOpenRevisionId(null);
            logReveal.dismiss();
            setShowLog((value) => !value);
          }}
          onSelectRevision={(changeId) => void selectRevision(changeId)}
          onOpenRevision={(changeId) => selectRevision(changeId, true)}
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
