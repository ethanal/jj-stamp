import assert from "node:assert/strict";
import test from "node:test";
import {
  FileDiff,
  parsePatchFiles,
  type FileDiffMetadata,
} from "@pierre/diffs";
import {
  extractSelectedRightHandText,
  installCopySelectionHandler,
  readRenderedRightHandLines,
  type CopySelection,
} from "../src/copy-selection.ts";

const patch = `diff --git a/example.txt b/example.txt
--- a/example.txt
+++ b/example.txt
@@ -10,4 +10,5 @@
 before
-old
+\tnew  
++literal plus
 middle
 after
@@ -30,2 +31,2 @@
-old second
+-literal minus
 end
\\ No newline at end of file
`;
const fileDiff = parsePatchFiles(patch)[0].files[0];
// Use the actual renderer's coordinate implementation without needing a DOM.
class Indexer extends FileDiff {
  constructor(private metadata: FileDiffMetadata) {
    super();
  }
  protected getDiffForLineIndex() {
    return this.metadata;
  }
}
const getLineIndex = new Indexer(fileDiff).getLineIndex;
const extract = (selection: Partial<CopySelection> = {}) =>
  extractSelectedRightHandText({
    range: { start: 10, end: 14 },
    fileDiff,
    getLineIndex,
    ...selection,
  });

test("copies context and additions, preserving tabs/spaces and literal +/- code", () => {
  assert.equal(extract(), "before\n\tnew  \n+literal plus\nmiddle\nafter\n");
  assert.equal(
    extract({ range: { start: 31, end: 32 } }),
    "-literal minus\nend",
  );
});

test("reversed and cross-side unified selections follow visual row order", () => {
  assert.equal(extract({ range: { start: 14, end: 10 } }), extract());
  assert.equal(
    extract({
      range: { start: 11, side: "deletions", end: 12, endSide: "additions" },
    }),
    "\tnew  \n+literal plus\n",
  );
  assert.equal(
    extract({
      range: { start: 12, side: "additions", end: 11, endSide: "deletions" },
    }),
    "\tnew  \n+literal plus\n",
  );
});

test("single unified deletion is not widened to its replacement", () => {
  assert.equal(
    extract({ range: { start: 11, end: 11, side: "deletions" } }),
    null,
  );
});

test("split left-side selections copy only aligned right-side rows", () => {
  assert.equal(
    extract({
      style: "split",
      range: { start: 11, end: 11, side: "deletions" },
    }),
    "\tnew  \n",
  );
  assert.equal(
    extract({ style: "split", range: { start: 11, end: 12 } }),
    "\tnew  \n+literal plus\n",
  );
  assert.equal(
    extract({
      style: "split",
      range: { start: 12, side: "additions", end: 11, endSide: "deletions" },
    }),
    "\tnew  \n+literal plus\n",
  );
});

test("context-only ranges are copyable even without squash selections", () => {
  assert.equal(extract({ range: { start: 13, end: 14 } }), "middle\nafter\n");
});

test("packed partial metadata uses hunk coordinates, not array offsets", () => {
  assert.equal(extract({ range: { start: 31, end: 31 } }), "-literal minus\n");
  assert.equal(
    extract({ range: { start: 13, end: 31 } }),
    "middle\nafter\n-literal minus\n",
  );
});

test("full contents include hidden and expanded context between hunks", () => {
  const lines = Array.from({ length: 40 }, (_, i) => `full line ${i + 1}\n`);
  const full = { ...fileDiff, isPartial: false, additionLines: lines };
  assert.equal(
    extract({ fileDiff: full, range: { start: 14, end: 31 } }),
    lines.slice(13, 31).join(""),
  );
  assert.equal(
    extract({ newFileContents: lines.join(""), range: { start: 14, end: 31 } }),
    lines.slice(13, 31).join(""),
  );
});

test("rendered context fallback fills unknown lines, source overrides DOM", () => {
  assert.equal(
    extract({
      range: { start: 14, end: 16 },
      renderedLines: [
        { line: 14, text: "not the source" },
        { line: 16, text: "expanded 16" },
        { line: 15, text: "expanded 15" },
      ],
    }),
    "after\nexpanded 15\nexpanded 16",
  );
});

test("full sources override stale rendered rows and partial contents", () => {
  const index = (n: number): [number, number] => [n - 1, n - 1];
  assert.equal(
    extract({
      range: { start: 1, end: 100 },
      getLineIndex: index,
      newFileContents: "only line",
      renderedLines: [{ line: 99, text: "stale" }],
    }),
    "only line",
  );
  assert.equal(
    extract({ newFileContents: "", range: { start: 10, end: 14 } }),
    null,
  );
});

test("preserves blank lines, CRLF, Unicode, and missing EOF newline", () => {
  const getLineIndex = (n: number): [number, number] => [n - 1, n - 1];
  const newFileContents = "\tα  \r\n\r\nlast 🦊";
  assert.equal(
    extract({ getLineIndex, newFileContents, range: { start: 1, end: 3 } }),
    newFileContents,
  );
  assert.equal(
    extract({ getLineIndex, newFileContents, range: { start: 2, end: 2 } }),
    "\r\n",
  );
  assert.equal(
    extract({
      getLineIndex,
      newFileContents: "one\n",
      range: { start: 2, end: 2 },
    }),
    null,
  );
});

test("absent ranges and unresolvable endpoints do not overwrite clipboard", () => {
  assert.equal(extract({ range: null }), null);
  assert.equal(extract({ getLineIndex: () => undefined }), null);
});

test("split deletion padding is omitted, not guessed as the next surviving line", () => {
  const deletionDiff = parsePatchFiles(`diff --git a/a b/a
--- a/a
+++ b/a
@@ -1,4 +1,2 @@
-a
-b
-c
+x
 last
`)[0].files[0];
  const getLineIndex = new Indexer(deletionDiff).getLineIndex;
  assert.equal(
    extract({
      fileDiff: deletionDiff,
      getLineIndex,
      style: "split",
      range: { start: 2, end: 3, side: "deletions" },
    }),
    null,
  );
});

// Small event host keeps handler logic testable without a DOM dependency;
// tests/copy-selection.e2e.ts covers real ShadowRoot, focus and OS clipboard.
function eventHost() {
  const listeners = new Set<(event: ClipboardEvent) => void>();
  const document = {
    activeElement: null as unknown,
    getSelection: () => null as Selection | null,
  };
  const root = {
    ownerDocument: document,
    querySelectorAll: () => [],
    addEventListener: (_: string, listener: (event: ClipboardEvent) => void) =>
      listeners.add(listener),
    removeEventListener: (
      _: string,
      listener: (event: ClipboardEvent) => void,
    ) => listeners.delete(listener),
  } as unknown as HTMLElement;
  const dispatch = (overrides: Partial<ClipboardEvent> = {}) => {
    const data = new Map<string, string>();
    const event = {
      defaultPrevented: false,
      cancelable: true,
      composedPath: () => [root],
      clipboardData: {
        setData: (type: string, value: string) => data.set(type, value),
      },
      preventDefault() {
        (this as { defaultPrevented: boolean }).defaultPrevented = true;
      },
      ...overrides,
    } as ClipboardEvent;
    for (const listener of listeners) listener(event);
    return { event, data };
  };
  return { root, document, dispatch };
}
const defaultSelection: CopySelection = {
  fileDiff,
  getLineIndex,
  range: { start: 11, end: 12 },
};

test("copy event writes plain text synchronously and cancels native copy; cleanup works", () => {
  const { root, dispatch } = eventHost();
  let selection: CopySelection | null = defaultSelection;
  const cleanup = installCopySelectionHandler(root, () => selection);
  const { event, data } = dispatch();
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual([...data], [["text/plain", "\tnew  \n+literal plus\n"]]);
  selection = null;
  assert.equal(
    dispatch().event.defaultPrevented,
    false,
    "getter reads latest selection",
  );
  selection = defaultSelection;
  cleanup();
  assert.equal(dispatch().event.defaultPrevented, false);
});

test("native selections and editable controls retain browser copy", () => {
  const { root, document, dispatch } = eventHost();
  installCopySelectionHandler(root, () => defaultSelection);
  document.getSelection = () =>
    ({ isCollapsed: false, toString: () => "native" }) as Selection;
  assert.equal(dispatch().event.defaultPrevented, false);
  document.getSelection = () => null;
  const input = { matches: () => true } as unknown as HTMLElement;
  assert.equal(
    dispatch({ composedPath: () => [input, root] }).event.defaultPrevented,
    false,
  );
  document.activeElement = { matches: () => false, isContentEditable: true };
  assert.equal(dispatch().event.defaultPrevented, false);
});

test("null clipboardData, cancelled/noncancelable events, and deletion-only spans are untouched", () => {
  const { root, dispatch } = eventHost();
  let selection = defaultSelection;
  installCopySelectionHandler(root, () => selection);
  assert.equal(dispatch({ clipboardData: null }).event.defaultPrevented, false);
  assert.equal(dispatch({ defaultPrevented: true }).data.size, 0);
  assert.equal(dispatch({ cancelable: false }).data.size, 0);
  selection = {
    ...defaultSelection,
    range: { start: 11, end: 11, side: "deletions" },
  };
  assert.equal(dispatch().event.defaultPrevented, false);
});

test("DOM adapter excludes old columns and deletion rows and retains blank code", () => {
  const row = (
    line: string,
    text: string,
    lineType = "context",
    oldColumn = false,
  ) => ({
    dataset: { line, lineType },
    textContent: text,
    closest: (selector: string) =>
      selector === "[data-deletions]" && oldColumn ? {} : null,
  });
  const shadow = {
    querySelectorAll: (selector: string) => {
      assert.equal(
        selector,
        "[data-line]",
        "must not read line-number gutters",
      );
      return [
        row("10", "old\n", "change-deletion"),
        row("10", "old context\n", "context", true),
        row("10", "+literal new\n", "change-addition"),
        row("11", "\n"),
        row("invalid", "not code"),
      ];
    },
  } as unknown as ParentNode;
  assert.deepEqual(readRenderedRightHandLines(shadow), [
    { line: 10, text: "+literal new\n" },
    { line: 11, text: "\n" },
  ]);
});

test("shadow-root native selection and shadow-focused editable input keep native copy", () => {
  const { root, document, dispatch } = eventHost();
  installCopySelectionHandler(root, () => defaultSelection);
  Object.defineProperty(root, "shadowRoot", {
    configurable: true,
    value: {
      getSelection: () => ({
        isCollapsed: false,
        toString: () => "shadow text",
      }),
    },
  });
  assert.equal(dispatch().event.defaultPrevented, false);
  Object.defineProperty(root, "shadowRoot", { value: null });
  document.activeElement = {
    shadowRoot: { activeElement: { matches: () => true } },
  };
  assert.equal(dispatch().event.defaultPrevented, false);
});
