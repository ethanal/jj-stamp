import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { Virtualizer, type VirtualFileMetrics } from "@pierre/diffs";
import {
  VirtualizerContext,
  WorkerPoolContextProvider,
  useWorkerPool,
  type WorkerInitializationRenderOptions,
  type WorkerPoolOptions,
} from "@pierre/diffs/react";
import { colorSchemes, type ColorScheme } from "./preferences";
import DiffHighlightWorker from "./diff-highlight.worker";

/** Match styles.css and CodeDiff's 25px custom separator, not Pierre's defaults. */
export const diffVirtualMetrics: VirtualFileMetrics = {
  hunkLineCount: 40,
  lineHeight: 19,
  diffHeaderHeight: 44,
  hunkSeparatorHeight: 25,
  spacing: 0,
  paddingTop: 0,
  paddingBottom: 0,
};

const virtualizerConfig = {
  overscrollSize: 500,
  intersectionObserverMargin: 1000,
  resizeDebugging: false,
};

/**
 * Replace the existing viewer-scroll div, rather than adding a nested scroller.
 * Pierre's React Virtualizer does not forward a ref; this small equivalent does.
 * FileDiff automatically selects its virtualized renderer through this context.
 */
export const DiffViewport = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement>
>(function DiffViewport({ children, ...props }, forwardedRef) {
  const [virtualizer] = useState(() =>
    typeof window !== "undefined" &&
    typeof ResizeObserver !== "undefined" &&
    typeof IntersectionObserver !== "undefined"
      ? new Virtualizer(virtualizerConfig)
      : undefined,
  );
  const ref = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) virtualizer?.setup(node);
      else virtualizer?.cleanUp();
      if (typeof forwardedRef === "function") forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef, virtualizer],
  );
  return (
    <VirtualizerContext.Provider value={virtualizer}>
      <div {...props} ref={ref}>
        <div style={{ minHeight: "100%" }}>{children}</div>
      </div>
    </VirtualizerContext.Provider>
  );
});

/**
 * Wrap viewer contents (not the app or its scroll element). The singleton pool
 * owns highlighting, while virtualized FileDiff instances bound main-thread DOM
 * work. A failed worker falls back once to Pierre's normal renderer; only viewer
 * children remount, so the caller's controlled selection and scroll root survive.
 */
export function DiffRuntime({
  children,
  colorScheme,
}: {
  children: ReactNode;
  colorScheme: ColorScheme;
}) {
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const warned = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const fail = useCallback((error: unknown) => {
    if (!mounted.current || warned.current) return;
    warned.current = true;
    console.warn(
      "Diff highlighting worker unavailable; using local highlighting.",
      error,
    );
    setFailed(true);
  }, []);
  // Stable options: no pool recreation on selection, queue, layout or theme
  // changes. Two workers leave CPU room for input and the separate scope worker.
  const poolOptions = useMemo<WorkerPoolOptions>(
    () => ({
      poolSize: Math.min(
        2,
        Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 2) - 1),
      ),
      totalASTLRUCacheSize: 12,
      workerInitializationTimeout: 5000,
      workerFactory() {
        try {
          const worker = new DiffHighlightWorker({ name: "diff-highlight" });
          // Pierre handles startup errors but not all post-startup fatal errors.
          // Switch the whole viewer to fallback instead of leaving a task stuck.
          worker.addEventListener("error", fail);
          worker.addEventListener("messageerror", fail);
          return worker;
        } catch (error) {
          // Factory calls can happen during initialization; defer React updates.
          queueMicrotask(() => fail(error));
          throw error;
        }
      },
    }),
    [fail],
  );
  const [highlighterOptions] = useState<WorkerInitializationRenderOptions>(
    () => ({
      theme: colorSchemes[colorScheme].theme,
      preferredHighlighter: "shiki-js",
      // Do not preload languages on the UI thread. Pierre resolves each grammar
      // on demand and transfers it to the workers for actual tokenization.
      langs: [],
      tokenizeMaxLineLength: 1000,
      maxLineDiffLength: 1000,
      lineDiffType: "word-alt",
    }),
  );
  if (failed || typeof Worker === "undefined") return <>{children}</>;
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <PoolConfiguration colorScheme={colorScheme} onFailure={fail} />
      {children}
    </WorkerPoolContextProvider>
  );
}

function PoolConfiguration({
  colorScheme,
  onFailure,
}: {
  colorScheme: ColorScheme;
  onFailure: (error: unknown) => void;
}) {
  const pool = useWorkerPool();
  useEffect(() => {
    let active = true;
    const report = (error: unknown) => {
      if (active) onFailure(error);
    };
    const unsubscribe = pool?.subscribeToStatChanges((stats) => {
      if (stats.workersFailed)
        report(new Error("Diff worker pool initialization failed"));
    });
    // Pool render options override FileDiff.options.theme, so update the pool
    // explicitly. Its versioning ignores stale async theme resolutions.
    void pool
      ?.setRenderOptions({ theme: colorSchemes[colorScheme].theme })
      .catch(report);
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [pool, colorScheme, onFailure]);
  return null;
}
