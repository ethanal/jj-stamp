import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import { CodeDiff } from "../src/CodeDiff";
import type { DiffFile, Selections } from "../src/types";
import "../src/styles.css";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const oldLines = [
  `// JJ-STAMP(${id}): Previous <b>question</b>`,
  "export const value = 1;",
];
const goodLines = [
  `// JJ-STAMP(${id}): Current question`,
  "export const value = 2;",
];
function Fixture() {
  const [style, setStyle] = useState<"split" | "unified">("unified");
  const [malformed, setMalformed] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [loads, setLoads] = useState(0);
  const [selections, setSelections] = useState<Selections>({});
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const newLines = malformed
    ? ["// JJ-STAMP(invalid): Do not hide this", goodLines[1]]
    : goodLines;
  const file: DiffFile = {
    path: "comments.ts",
    additions: 2,
    deletions: 2,
    patch: [
      "diff --git a/comments.ts b/comments.ts",
      "--- a/comments.ts",
      "+++ b/comments.ts",
      "@@ -1,2 +1,2 @@",
      ...oldLines.map((text) => `-${text}`),
      ...newLines.map((text) => `+${text}`),
      "",
    ].join("\n"),
    hunks: [
      {
        id: "comment-hunk",
        header: "@@ -1,2 +1,2 @@",
        rows: [
          ...oldLines.map((text, i) => ({
            index: i + 1,
            raw: `-${text}`,
            oldLine: i + 1,
          })),
          ...newLines.map((text, i) => ({
            index: i + 3,
            raw: `+${text}`,
            newLine: i + 1,
          })),
        ],
      },
    ],
  };
  return (
    <>
      <button onClick={() => setStyle(style === "split" ? "unified" : "split")}>
        Toggle layout
      </button>
      <button onClick={() => setMalformed(!malformed)}>
        Malformed markers
      </button>
      <button onClick={() => setReadOnly(!readOnly)}>
        Historical revision
      </button>
      <output id="loads">{loads}</output>
      <output id="selection">{JSON.stringify(selections)}</output>
      <div style={{ height: 650, display: "flex" }}>
        <div className="viewer-scroll" style={{ width: "100%" }}>
          <CodeDiff
            file={file}
            version={malformed ? "malformed" : "valid"}
            contentIdentity={malformed ? "malformed" : "valid"}
            style={style}
            selections={selections}
            range={range}
            disabled={false}
            readOnly={readOnly}
            contextDisabled={false}
            commentEditingEnabled={!readOnly}
            onComment={async () => {
              throw new Error("Fixture mutation deliberately rejected");
            }}
            onSelection={(range, selections) => {
              setRange(range);
              setSelections(selections);
            }}
            onDragging={() => {}}
            onError={() => {}}
            loadFile={async () => {
              setLoads((loads) => loads + 1);
              return {
                oldFile: {
                  name: file.path,
                  contents: oldLines.join("\n") + "\n",
                },
                newFile: {
                  name: file.path,
                  contents: newLines.join("\n") + "\n",
                },
              };
            }}
          />
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
