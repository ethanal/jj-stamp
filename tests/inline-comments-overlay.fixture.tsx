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
const path = "clean-code.ts";
const oldLines = ["export const value = 1;", "export const tail = 2;"];
const newLines = ["export const value = 10;", "export const tail = 20;"];
const rows = [
  ...oldLines.map((text, i) => ({
    raw: `-${text}`,
    oldLine: i + 1,
    index: i + 1,
  })),
  ...newLines.map((text, i) => ({
    raw: `+${text}`,
    newLine: i + 1,
    index: i + 3,
  })),
];
const file: DiffFile = {
  path,
  additions: 2,
  deletions: 2,
  patch: [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,2 +1,2 @@",
    ...rows.map((row) => row.raw),
    "",
  ].join("\n"),
  hunks: [{ id: "clean-code-hunk", header: "@@ -1,2 +1,2 @@", rows }],
};
const initial: ProjectedReviewComment[] = [
  { id, body: "A companion <b>comment</b>", startLine: 1, endLine: 2 },
];
function Fixture() {
  const [style, setStyle] = useState<"split" | "unified">("unified");
  const [commentEpoch, setCommentEpoch] = useState(0);
  const [comments, setComments] = useState<ProjectedReviewComment[]>(() =>
    JSON.parse(
      localStorage.getItem("overlay-comments") ?? JSON.stringify(initial),
    ),
  );
  const [fileLoads, setFileLoads] = useState(0);
  const [commentLoads, setCommentLoads] = useState(0);
  const [failure, setFailure] = useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [selections, setSelections] = useState<Selections>({});
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [mutations, setMutations] = useState<ReviewCommentMutation[]>([]);
  const update = (next: ProjectedReviewComment[]) => {
    localStorage.setItem("overlay-comments", JSON.stringify(next));
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
