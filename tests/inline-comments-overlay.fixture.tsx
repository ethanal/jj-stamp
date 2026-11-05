import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import { CodeDiff } from "../src/CodeDiff";
import type { DiffFile, Selections } from "../src/types";
import type {
  ProjectedReviewComment,
  ReviewCommentMutation,
  ReviewCommentOverlay,
} from "../src/review-comments";
import "../src/styles.css";

const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const missingId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const scenario = new URLSearchParams(location.search).get("source") ?? "ts";
const sources: Record<string, { path: string; lines: string[] }> = {
  ts: {
    path: "clean-code.ts",
    lines: ["export const value = 10;", "export const tail = 20;"],
  },
  rust: {
    path: "raw-syntax.rs",
    lines: [
      'const TEXT: &str = r###"raw "quotes" /* //',
      'still raw"###;',
      "fn keep<'a>(value: &'a str) -> &'a str { value }",
      "const RATIO: i32 = 20 / 2;",
    ],
  },
  python: {
    path: "source.py",
    lines: ['text = """triple quotes', 'still text"""', "value = 20 // 2"],
  },
  json: {
    path: "source.json",
    lines: ['{"url": "https://example.test",', '"value": 20}'],
  },
  markdown: {
    path: "source.md",
    lines: ["# Review notes", "Text with `//` and an unmatched apostrophe'"],
  },
  extensionless: {
    path: "SOURCE",
    lines: ["arbitrary source syntax /*", '20 / 2 "'],
  },
};
const { path, lines: newLines } = sources[scenario];
const oldLines = newLines.map((text) => text.replace("20", "2"));
const storageKey = `overlay-comments:${path}`;
const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
const rows = [
  ...oldLines.map((text, i) => ({
    raw: `-${text}`,
    oldLine: i + 1,
    index: i + 1,
  })),
  ...newLines.map((text, i) => ({
    raw: `+${text}`,
    newLine: i + 1,
    index: i + oldLines.length + 1,
  })),
];
const file: DiffFile = {
  path,
  additions: newLines.length,
  deletions: oldLines.length,
  patch: [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    header,
    ...rows.map((row) => row.raw),
    "",
  ].join("\n"),
  hunks: [{ id: "clean-code-hunk", header, rows }],
};
const initial: ProjectedReviewComment[] = [
  { id, body: "A companion <b>comment</b>", startLine: 1, endLine: 2 },
];
function Fixture() {
  const [style, setStyle] = useState<"split" | "unified">("unified");
  const [commentEpoch, setCommentEpoch] = useState(0);
  const [comments, setComments] = useState<ProjectedReviewComment[]>(() =>
    JSON.parse(localStorage.getItem(storageKey) ?? JSON.stringify(initial)),
  );
  const [fileLoads, setFileLoads] = useState(0);
  const [commentLoads, setCommentLoads] = useState(0);
  const [failure, setFailure] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [selections, setSelections] = useState<Selections>({});
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [mutations, setMutations] = useState<ReviewCommentMutation[]>([]);
  const update = (next: ProjectedReviewComment[]) => {
    localStorage.setItem(storageKey, JSON.stringify(next));
    setComments(next);
    setCommentEpoch((epoch) => epoch + 1);
  };
  return (
    <>
      <button onClick={() => setStyle(style === "split" ? "unified" : "split")}>
        Toggle layout
      </button>
      <button onClick={() => setFailure(!failure)}>Toggle failed save</button>
      <button onClick={() => setReadOnly(!readOnly)}>
        Historical revision
      </button>
      <button
        onClick={() =>
          update(
            comments.map((comment) => ({
              ...comment,
              body: "Externally changed companion",
            })),
          )
        }
      >
        External comment save
      </button>
      <output id="loads">{fileLoads}</output>
      <output id="comment-loads">{commentLoads}</output>
      <output id="selection">{JSON.stringify(selections)}</output>
      <output id="mutations">{JSON.stringify(mutations)}</output>
      <div style={{ height: 650, display: "flex" }}>
        <div className="viewer-scroll" style={{ width: "100%" }}>
          <CodeDiff
            file={file}
            version={`state-${commentEpoch}`}
            contentIdentity="immutable-clean-code"
            commentIdentity={`companion-${commentEpoch}`}
            style={style}
            selections={selections}
            range={range}
            disabled={false}
            readOnly={readOnly}
            contextDisabled={false}
            commentEditingEnabled={!readOnly}
            loadComments={async (): Promise<ReviewCommentOverlay> => {
              setCommentLoads((loads) => loads + 1);
              return {
                comments,
                unmapped: [
                  {
                    id: missingId,
                    body: "Keep this unresolved body visible",
                    reason: "The original source range was deleted.",
                  },
                ],
                issues: [],
                editable: true,
              };
            }}
            onComment={async (mutation) => {
              setMutations((previous) => [...previous, mutation]);
              if (failure) throw new Error("Companion revision save failed");
              if (mutation.action === "add")
                update([
                  ...comments,
                  {
                    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    body: mutation.body,
                    startLine: mutation.line,
                    endLine: mutation.endLine ?? mutation.line,
                  },
                ]);
              else if (mutation.action === "remove")
                update(
                  comments.filter((comment) => comment.id !== mutation.id),
                );
              else
                update(
                  comments.map((comment) =>
                    comment.id === mutation.id
                      ? { ...comment, body: mutation.body }
                      : comment,
                  ),
                );
            }}
            onSelection={(range, selections) => {
              setRange(range);
              setSelections(selections);
            }}
            onDragging={() => {}}
            onError={() => {}}
            loadFile={async () => {
              setFileLoads((loads) => loads + 1);
              return {
                oldFile: { name: path, contents: oldLines.join("\n") + "\n" },
                newFile: { name: path, contents: newLines.join("\n") + "\n" },
              };
            }}
          />
        </div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
