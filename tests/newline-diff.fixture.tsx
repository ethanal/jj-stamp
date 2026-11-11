import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { SelectedLineRange } from "@pierre/diffs";
import "../src/styles.css";
import { CodeDiff } from "../src/CodeDiff";
import type { Selections } from "../src/types";
import { newlineCases, newlineFile } from "./newline-cases";

const query = new URLSearchParams(location.search);
const scenario = query.has("large")
  ? {
      name: "unterminated-context" as const,
      before: `${"context\n".repeat(400)}old\nlast`,
      after: `${"context\n".repeat(400)}new\nlast`,
      header: "@@ -1,402 +1,402 @@" as const,
      body: `${" context\n".repeat(400)}-old\n+new\n last\n\\ No newline at end of file`,
      markers: { unified: 1, split: 2 } as const,
    }
  : newlineCases.find((item) => item.name === query.get("case"))!;
const file = newlineFile(scenario, query.get("transport") === "lf");
function Fixture() {
  const [style, setStyle] = useState<"unified" | "split">(
    query.get("style") === "split" ? "split" : "unified",
  );
  const [range, setRange] = useState<SelectedLineRange | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [error, setError] = useState("");
  const [loads, setLoads] = useState(0);
  return (
    <>
      <button onClick={() => setStyle(style === "split" ? "unified" : "split")}>
        Layout
      </button>
      <output id="range" hidden>
        {JSON.stringify(range)}
      </output>
      <output id="selection" hidden>
        {JSON.stringify(selections)}
      </output>
      <output id="error" hidden>
        {error}
      </output>
      <output id="loads" hidden>
        {loads}
      </output>
      <div className="viewer-scroll" style={{ height: 600 }}>
        <CodeDiff
          file={file}
          version="fixture"
          contentIdentity="newline-fixture"
          style={style}
          selections={selections}
          range={range}
          disabled={false}
          contextDisabled={false}
          onDragging={() => {}}
          onError={setError}
          onSelection={(next, selections) => {
            setRange(next);
            setSelections(selections);
          }}
          loadFile={async () => {
            setLoads((count) => count + 1);
            return {
              oldFile: { name: file.path, contents: scenario.before },
              newFile: { name: file.path, contents: scenario.after },
            };
          }}
        />
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
