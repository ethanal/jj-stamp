import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff, useWorkerPool } from "@pierre/diffs/react";
import type { SelectedLineRange } from "@pierre/diffs";
import type { WorkerStats } from "@pierre/diffs/worker";
import { CodeDiff } from "../src/CodeDiff";
import {
  DiffFontSizeContext,
  DiffRuntime,
  DiffViewport,
  diffVirtualMetrics,
} from "../src/DiffRuntime";
import { colorSchemes, type ColorScheme } from "../src/preferences";
import type { DiffFile, Selections } from "../src/types";
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

const fontPath = "font-runtime.txt";
const fontBase = Array.from(
  { length: 1200 },
  (_, index) => `unchanged runtime line ${index + 1}`,
);
const fontChanged = [...fontBase];
for (let line = 10; line <= 1190; line += 20)
  fontChanged[line - 1] = `updated runtime line ${line}`;
const fontFile: DiffFile = (() => {
  const hunks = Array.from({ length: 60 }, (_, index) => index * 20 + 10).map(
    (line) => ({
      id: `font-hunk-${line}`,
      header: `@@ -${line - 3},7 +${line - 3},7 @@`,
      rows: [
        ...Array.from({ length: 3 }, (_, index) => ({
          raw: ` ${fontBase[line - 4 + index]}`,
          oldLine: line - 3 + index,
          newLine: line - 3 + index,
        })),
        { raw: `-${fontBase[line - 1]}`, oldLine: line },
        { raw: `+${fontChanged[line - 1]}`, newLine: line },
        ...Array.from({ length: 3 }, (_, index) => ({
          raw: ` ${fontBase[line + index]}`,
          oldLine: line + 1 + index,
          newLine: line + 1 + index,
        })),
      ].map((row, index) => ({ ...row, index: index + 1 })),
    }),
  );
  return {
    path: fontPath,
    additions: hunks.length,
    deletions: hunks.length,
    hunks,
    patch: `diff --git a/${fontPath} b/${fontPath}\n--- a/${fontPath}\n+++ b/${fontPath}\n${hunks.map((hunk) => `${hunk.header}\n${hunk.rows.map((row) => row.raw).join("\n")}\n`).join("")}`,
  };
})();

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

function FontFixture() {
  const [fontSize, setFontSize] = useState(13);
  const [selections, setSelections] = useState<Selections>({});
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    document.documentElement.style.setProperty("--font-size", `${fontSize}px`);
  }, [fontSize]);
  return (
    <DiffFontSizeContext.Provider value={fontSize}>
      <div style={{ height: 60 }}>
        <button onClick={() => setFontSize((size) => (size === 13 ? 24 : 13))}>
          Font size
        </button>
        <button onClick={() => viewport.current?.scrollTo({ top: 0 })}>
          Top
        </button>
        <button onClick={() => viewport.current?.scrollTo({ top: 1e7 })}>
          Bottom
        </button>
        <output id="font-range">{JSON.stringify(range)}</output>
        <output id="font-selection">{JSON.stringify(selections)}</output>
      </div>
      <DiffViewport
        className="viewer-scroll"
        ref={viewport}
        style={{ height: 600, flex: "none" }}
      >
        <DiffRuntime colorScheme="dark">
          <CodeDiff
            file={fontFile}
            version="font-runtime"
            contentIdentity="font-runtime"
            style="unified"
            colorScheme="dark"
            vimMode
            selections={selections}
            range={range}
            disabled={false}
            contextDisabled={false}
            onSelection={(nextRange, nextSelections) => {
              setRange(nextRange);
              setSelections(nextSelections);
            }}
            onDragging={() => {}}
            onError={(message) => {
              throw new Error(message);
            }}
            loadFile={async () => ({
              oldFile: { name: fontPath, contents: fontBase.join("\n") + "\n" },
              newFile: {
                name: fontPath,
                contents: fontChanged.join("\n") + "\n",
              },
            })}
          />
        </DiffRuntime>
      </DiffViewport>
    </DiffFontSizeContext.Provider>
  );
}

createRoot(document.getElementById("root")!).render(
  new URLSearchParams(location.search).has("font") ? (
    <FontFixture />
  ) : (
    <Fixture />
  ),
);
