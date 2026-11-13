import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CodeDiff } from "../src/CodeDiff";
import { GoToRevision } from "../src/GoToRevision";
import type { DiffFile } from "../src/types";
import "../src/styles.css";

const rows = Array.from({ length: 8 }, (_, index) => ({
  index: index + 1,
  newLine: index + 1,
  raw: `+line ${index + 1}`,
}));
const file: DiffFile = {
  path: "goto.txt",
  additions: rows.length,
  deletions: 0,
  patch: `diff --git a/goto.txt b/goto.txt\nnew file mode 100644\n--- /dev/null\n+++ b/goto.txt\n@@ -0,0 +1,8 @@\n${rows.map((row) => row.raw).join("\n")}\n`,
  hunks: [{ id: "goto-hunk", header: "@@ -0,0 +1,8 @@", rows }],
};

function Fixture() {
  const [disabled, setDisabled] = useState(false);
  const [vimMode, setVimMode] = useState(false);
  const [pending, setPending] = useState(false);
  const [requests, setRequests] = useState<string[]>([]);
  useEffect(() => {
    Object.assign(window, {
      gotoFixture: { setDisabled, setVimMode },
    });
  }, []);
  return (
    <>
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          padding: 20,
          gap: 6,
        }}
      >
        <GoToRevision
          disabled={disabled || pending}
          vimMode={vimMode}
          onSubmit={async (id) => {
            setRequests((previous) => [...previous, id]);
            setPending(true);
            try {
              return await new Promise<boolean>((resolve, reject) => {
                Object.assign(window, {
                  settleGoto: (result: boolean | string) =>
                    typeof result === "string"
                      ? reject(new Error(result))
                      : resolve(result),
                });
              });
            } finally {
              setPending(false);
            }
          }}
        />
        <button className="action-button">Refresh</button>
        <button className="action-button">Settings</button>
      </div>
      <button id="previous">Previous focus</button>
      <input aria-label="Other input" />
      <span
        contentEditable
        suppressContentEditableWarning
        aria-label="Editable text"
      >
        editable
      </span>
      <dialog aria-label="Other modal">Other modal</dialog>
      <output id="requests">{JSON.stringify(requests)}</output>
      <div className="viewer-scroll" style={{ height: 400 }}>
        <CodeDiff
          file={file}
          version="goto-v1"
          contentIdentity="goto-v1"
          style="unified"
          vimMode={vimMode}
          selections={{}}
          range={null}
          disabled={disabled}
          contextDisabled
          onSelection={() => {}}
          onDragging={() => {}}
          onError={(error) => {
            throw new Error(error);
          }}
          loadFile={async () => ({
            oldFile: { name: file.path, contents: "" },
            newFile: {
              name: file.path,
              contents: rows.map((row) => row.raw.slice(1)).join("\n") + "\n",
            },
          })}
        />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
