import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import { CodeDiff } from "../src/CodeDiff";
import { SplitDiffLayout } from "../src/SplitDiffLayout";
import type { DiffFile, Selections } from "../src/types";
import "../src/styles.css";

function shortFile(path: string): DiffFile {
  const rows = [
    ...Array.from({ length: 6 }, (_, i) => ({
      raw: `-const original${i + 1} = ${i + 1};`,
      oldLine: i + 1,
    })),
    ...Array.from({ length: 6 }, (_, i) => ({
      raw: `+const updated${i + 1} = ${i + 11};`,
      newLine: i + 1,
    })),
  ].map((row, i) => ({ ...row, index: i + 1 }));
  const header = "@@ -1,6 +1,6 @@";
  return {
    path,
    additions: 6,
    deletions: 6,
    hunks: [{ id: path, header, rows }],
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      header,
      ...rows.map((row) => row.raw),
      "",
    ].join("\n"),
  };
}

const files = [shortFile("first.ts"), shortFile("second.ts")];
function Fixture() {
  const [style, setStyle] = useState<"unified" | "split">("unified");
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [active, setActive] = useState("first.ts");
  const [dragging, setDragging] = useState(false);
  const [allFiles, setAllFiles] = useState(false);
  return (
    <>
      <header style={{ padding: 16 }}>
        <strong>Short diff — fast drag selection</strong>{" "}
        <button
          onClick={() => setStyle(style === "unified" ? "split" : "unified")}
        >
          Layout
        </button>
        <button onClick={() => setAllFiles(!allFiles)}>All files</button>
      </header>
      <div style={{ height: 650, display: "flex" }}>
        <SplitDiffLayout active={style === "split"} disabled={dragging}>
          <div className="viewer-scroll">
            {files.slice(0, allFiles ? 2 : 1).map((file) => (
              <section key={file.path}>
                <h3 style={{ margin: 0, padding: 12 }}>{file.path}</h3>
                <CodeDiff
                  file={file}
                  version="fixture"
                  contentIdentity={`fixture:${file.path}`}
                  style={style}
                  colorScheme="dark"
                  range={active === file.path ? range : null}
                  selections={active === file.path ? selections : {}}
                  disabled={false}
                  contextDisabled={false}
                  onSelection={(next, selected) => {
                    setActive(file.path);
                    setRange(next);
                    setSelections(selected);
                  }}
                  onDragging={setDragging}
                  onError={(message) => {
                    throw new Error(message);
                  }}
                  loadFile={async () => ({
                    oldFile: {
                      name: file.path,
                      contents:
                        file.hunks[0].rows
                          .slice(0, 6)
                          .map((row) => row.raw.slice(1))
                          .join("\n") + "\n",
                    },
                    newFile: {
                      name: file.path,
                      contents:
                        file.hunks[0].rows
                          .slice(6)
                          .map((row) => row.raw.slice(1))
                          .join("\n") + "\n",
                    },
                  })}
                />
              </section>
            ))}
          </div>
        </SplitDiffLayout>
      </div>
      <div hidden>
        <output id="range">{JSON.stringify(range)}</output>
        <output id="selection">{JSON.stringify(selections)}</output>
        <output id="dragging">{String(dragging)}</output>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
