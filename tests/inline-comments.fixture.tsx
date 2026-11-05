import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import { CodeDiff } from "../src/CodeDiff";
import type { DiffFile, Selections } from "../src/types";
import "../src/styles.css";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const source = new URLSearchParams(location.search).get("source");
const wrappers: Record<
  string,
  { path: string; before: string; after: string }
> = {
  rust: {
    path: "comments.rs",
    before: 'const TEXT: &str = r###"',
    after: '"###;',
  },
  template: {
    path: "comments.ts",
    before: "const text = `",
    after: "`;",
  },
  block: { path: "comments.json", before: "/*", after: "*/" },
  python: { path: "comments.py", before: 'text = """', after: '"""' },
  markdown: { path: "comments.md", before: "```text", after: "```" },
  extensionless: { path: "COMMENTS", before: 'arbitrary "', after: '"' },
};
const wrapper = source ? wrappers[source] : undefined;
const path = wrapper?.path ?? "comments.ts";
const surround = (lines: string[]) =>
  wrapper ? [wrapper.before, ...lines, wrapper.after] : lines;
const oldLines = [
  `  // JJ-STAMP(${id}): Previous <b>question</b>`,
  "export const value = 1;",
];
const goodLines = [
  `  // JJ-STAMP(${id}): Current question`,
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
  const oldSource = surround(oldLines);
  const newSource = surround(newLines);
  const header = `@@ -1,${oldSource.length} +1,${newSource.length} @@`;
  const file: DiffFile = {
    path,
    additions: newSource.length,
    deletions: oldSource.length,
    patch: [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      header,
      ...oldSource.map((text) => `-${text}`),
      ...newSource.map((text) => `+${text}`),
      "",
    ].join("\n"),
    hunks: [
      {
        id: "comment-hunk",
        header,
        rows: [
          ...oldSource.map((text, i) => ({
            index: i + 1,
            raw: `-${text}`,
            oldLine: i + 1,
          })),
          ...newSource.map((text, i) => ({
            index: i + oldSource.length + 1,
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
                  contents: oldSource.join("\n") + "\n",
                },
                newFile: {
                  name: file.path,
                  contents: newSource.join("\n") + "\n",
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
