import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, useWorkerPool } from "@pierre/diffs/react";
import type { WorkerStats } from "@pierre/diffs/worker";
import {
  DiffRuntime,
  DiffViewport,
  diffVirtualMetrics,
} from "../src/DiffRuntime";
import { colorSchemes, type ColorScheme } from "../src/preferences";
import "../src/styles.css";

const oldContents = Array.from({ length: 200 }, (_, i) =>
  [
    `export function scope${i}(input: number): number {`,
    "  let result = input;",
    ...Array.from({ length: 24 }, (_, n) => `  result += ${n + 1};`),
    "  return result;",
    "}",
    "",
  ].join("\n"),
).join("\n");
const fileDiff = parseDiffFromFile(
  { name: "large.ts", contents: oldContents, cacheKey: "old" },
  {
    name: "large.ts",
    contents: oldContents.replaceAll("result += 15;", "result += 150;"),
    cacheKey: "new",
  },
);

function Stats() {
  const pool = useWorkerPool();
  const [stats, setStats] = useState<WorkerStats>();
  useEffect(() => pool?.subscribeToStatChanges(setStats), [pool]);
  return (
    <output id="pool-stats" style={{ display: "none" }}>
      {pool ? JSON.stringify(stats) : "fallback"}
    </output>
  );
}

function Fixture() {
  const [colorScheme, setColorScheme] = useState<ColorScheme>("dark");
  const [diffStyle, setDiffStyle] = useState<"unified" | "split">("unified");
  const viewport = useRef<HTMLDivElement>(null);
  const options = useMemo(
    () => ({
      theme: colorSchemes[colorScheme].theme,
      themeType: colorSchemes[colorScheme].themeType,
      diffStyle,
      disableFileHeader: true,
      hunkSeparators: "line-info-basic" as const,
      expansionLineCount: 10,
      collapsedContextThreshold: 0,
      unsafeCSS:
        '[data-code] { padding-top: 0; padding-bottom: 0; } [data-separator="line-info-basic"] { height: 25px; }',
    }),
    [colorScheme, diffStyle],
  );
  return (
    <>
      <div style={{ height: 60 }}>
        <button
          onClick={() =>
            setColorScheme((value) => (value === "dark" ? "light" : "dark"))
          }
        >
          Theme
        </button>
        <button
          onClick={() =>
            setDiffStyle((value) => (value === "unified" ? "split" : "unified"))
          }
        >
          Layout
        </button>
        <button onClick={() => viewport.current?.scrollTo({ top: 1e7 })}>
          Bottom
        </button>
        <button onClick={() => viewport.current?.scrollTo({ top: 0 })}>
          Top
        </button>
      </div>
      <DiffViewport
        className="viewer-scroll"
        ref={viewport}
        style={{ height: 600, flex: "none" }}
      >
        <DiffRuntime colorScheme={colorScheme}>
          <Stats />
          <FileDiff
            fileDiff={fileDiff}
            options={options}
            metrics={diffVirtualMetrics}
          />
        </DiffRuntime>
      </DiffViewport>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
