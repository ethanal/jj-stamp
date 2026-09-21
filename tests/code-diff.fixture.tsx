import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import { CodeDiff } from "../src/CodeDiff";
import type { DiffFile, Selections } from "../src/types";

const path = "scroll-fixture.txt";
const base = Array.from(
  { length: 300 },
  (_, i) => `unchanged fixture line ${i + 1}`,
);
const changed = base.map((text, i) =>
  i % 20 === 9 ? `updated fixture line ${i + 1}` : text,
);
function makeFile(squashed: boolean): DiffFile {
  const hunks = Array.from({ length: 15 }, (_, i) => i * 20 + 10)
    .filter((line) => !squashed || line !== 90)
    .map((line) => ({
      id: `hunk-${line}`,
      header: `@@ -${line - 3},7 +${line - 3},7 @@`,
      rows: [
        ...Array.from({ length: 3 }, (_, i) => ({
          raw: ` ${base[line - 4 + i]}`,
          oldLine: line - 3 + i,
          newLine: line - 3 + i,
        })),
        { raw: `-${base[line - 1]}`, oldLine: line },
        { raw: `+${changed[line - 1]}`, newLine: line },
        ...Array.from({ length: 3 }, (_, i) => ({
          raw: ` ${base[line + i]}`,
          oldLine: line + 1 + i,
          newLine: line + 1 + i,
        })),
      ].map((row, i) => ({ ...row, index: i + 1 })),
    }));
  return {
    path,
    additions: hunks.length,
    deletions: hunks.length,
    hunks,
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks.map((hunk) => `${hunk.header}\n${hunk.rows.map((row) => row.raw).join("\n")}\n`).join("")}`,
  };
}
function Fixture() {
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const [theme, setTheme] = useState<"dark" | "light" | "dim">("dark");
  const [squashed, setSquashed] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const [selections, setSelections] = useState<Selections>({});
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  return (
    <>
      <button onClick={() => setStyle(style === "split" ? "unified" : "split")}>
        Layout
      </button>
      <button
        onClick={() =>
          setTheme(
            theme === "dark" ? "light" : theme === "light" ? "dim" : "dark",
          )
        }
      >
        Theme
      </button>
      <button onClick={() => setEpoch(epoch + 1)}>Refresh</button>
      <button
        onClick={() => {
          setSquashed(true);
          setSelections({});
          setRange(null);
        }}
      >
        Squash
      </button>
      <output id="selection">{JSON.stringify(selections)}</output>
      <output id="dragging">{String(dragging)}</output>
      <output id="error">{error}</output>
      <div
        className="viewer-scroll"
        style={{ height: 420, overflow: "auto", marginTop: 20 }}
      >
        <CodeDiff
          file={makeFile(squashed)}
          version={String(epoch)}
          renderKey={String(epoch)}
          style={style}
          colorScheme={theme}
          selections={selections}
          range={range}
          disabled={false}
          contextDisabled={false}
          onSelection={(next, selections) => {
            setRange(next);
            setSelections(selections);
          }}
          onDragging={setDragging}
          onError={setError}
          loadFile={async () => ({
            oldFile: {
              name: path,
              contents:
                base
                  .map((text, i) => (squashed && i === 89 ? changed[i] : text))
                  .join("\n") + "\n",
            },
            newFile: { name: path, contents: changed.join("\n") + "\n" },
          })}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
