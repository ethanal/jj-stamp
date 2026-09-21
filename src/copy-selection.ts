import type {
  FileDiffMetadata,
  GetLineIndexUtility,
  SelectedLineRange,
} from "@pierre/diffs";

/** Text includes its original line terminator, when present. */
export interface RightHandLine {
  line: number;
  text: string;
}

export interface CopySelection {
  range: SelectedLineRange | null;
  getLineIndex: GetLineIndexUtility;
  style?: "unified" | "split";
  /** Use the live renderer metadata: expansion hydrates its partial contents. */
  fileDiff?: FileDiffMetadata;
  /** Optional already-loaded full contents; copying never initiates a fetch. */
  newFileContents?: string;
  /** Optional fallback for expanded context not yet represented in metadata. */
  renderedLines?: readonly RightHandLine[];
}

/** Extract whole new-file lines in the same visual span used for line selection.
 * Context is included, deletions are not. Split left-side selections copy their
 * aligned right-hand rows, whereas a deletion-only unified span returns null.
 * Preserve code whitespace, line endings, and a missing final newline. Null
 * means there is no new-side text to copy (and the clipboard is left alone).
 *
 * This function is pure; callers may supply readRenderedRightHandLines(shadow)
 * separately. Source text wins over DOM text, never gutters or diff indicators.
 */
export function extractSelectedRightHandText({
  range,
  getLineIndex,
  style = "unified",
  fileDiff,
  newFileContents,
  renderedLines = [],
}: CopySelection): string | null {
  if (!range) return null;
  const axis = style === "split" ? 1 : 0;
  const start = getLineIndex(range.start, range.side ?? "additions")?.[axis];
  const end = getLineIndex(
    range.end,
    range.endSide ?? range.side ?? "additions",
  )?.[axis];
  if (
    start == null ||
    end == null ||
    !Number.isFinite(start) ||
    !Number.isFinite(end)
  )
    return null;
  const low = Math.min(start, end),
    high = Math.max(start, end);
  const lines = new Map<number, string>();
  for (const row of renderedLines) lines.set(row.line, row.text);
  if (fileDiff) {
    if (fileDiff.isPartial) {
      // Partial arrays are packed hunk contents, NOT indexed by file line.
      for (const hunk of fileDiff.hunks) {
        for (let i = 0; i < hunk.additionCount; i++) {
          const text = fileDiff.additionLines[hunk.additionLineIndex + i];
          if (text !== undefined) lines.set(hunk.additionStart + i, text);
        }
      }
    } else {
      // Full content is authoritative, including absence of stale DOM rows.
      lines.clear();
      fileDiff.additionLines.forEach((text, i) => lines.set(i + 1, text));
    }
  }
  if (newFileContents !== undefined) {
    lines.clear();
    // Unlike split("\n"), do not manufacture a phantom row at EOF.
    (newFileContents.match(/[^\n]*\n|[^\n]+$/g) ?? []).forEach((text, i) =>
      lines.set(i + 1, text),
    );
  }
  const selected = [...lines]
    .filter(([line]) => {
      const index = getLineIndex(line, "additions")?.[axis];
      return index != null && index >= low && index <= high;
    })
    .sort(([a], [b]) => a - b);
  if (!selected.length) return null;
  // DOM-only lines may lack terminators. Add separators only where required;
  // source-backed lines retain CRLF, LF, and the final EOF newline exactly.
  return selected
    .map(([, text], i) =>
      i < selected.length - 1 && !text.endsWith("\n") ? `${text}\n` : text,
    )
    .join("");
}

/** Read code rows, not gutters. Unified context already has new-side numbers;
 * split context is duplicated, so exclude the entire deletions column. */
export function readRenderedRightHandLines(
  shadow: ParentNode,
): RightHandLine[] {
  return [...shadow.querySelectorAll<HTMLElement>("[data-line]")]
    .filter(
      (row) =>
        row.dataset.lineType !== "change-deletion" &&
        !row.closest("[data-deletions]"),
    )
    .flatMap((row) => {
      const line = Number(row.dataset.line);
      return Number.isSafeInteger(line) && line > 0
        ? [{ line, text: row.textContent ?? "" }]
        : [];
    });
}

function hasNativeSelection(root: HTMLElement, event: ClipboardEvent): boolean {
  const selected = (selection: Selection | null | undefined) =>
    selection != null &&
    (!selection.isCollapsed || selection.toString().length > 0);
  if (selected(root.ownerDocument.getSelection())) return true;
  // Chromium exposes ShadowRoot.getSelection; other browsers use document's
  // selection. Check event-path roots too, including nested shadow editors.
  const nodes = [root, ...event.composedPath(), ...root.querySelectorAll("*")];
  for (const node of nodes) {
    const shadow = (node as Element).shadowRoot;
    if (
      shadow &&
      selected(
        (
          shadow as ShadowRoot & {
            getSelection?: () => Selection | null;
          }
        ).getSelection?.(),
      )
    )
      return true;
  }
  return false;
}

function isEditable(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return (
    !!element?.matches &&
    (element.matches("input, textarea, select") || element.isContentEditable)
  );
}

/** Install on the focusable CodeDiff root, NOT document: unrelated controls
 * keep native copy. The getter runs at copy time, so React refs may provide
 * fresh range/layout/metadata without reinstalling after every drag update.
 * Works with Cmd+C, Ctrl+C, and the browser Copy command; no key interception,
 * asynchronous Clipboard API, permission request, or insecure-context fallback.
 */
export function installCopySelectionHandler(
  root: HTMLElement,
  getSelection: () => CopySelection | null,
): () => void {
  const copy = (event: ClipboardEvent) => {
    if (event.defaultPrevented || !event.clipboardData || !event.cancelable)
      return;
    if (event.composedPath().some(isEditable)) return;
    let active = root.ownerDocument.activeElement;
    while (active?.shadowRoot?.activeElement)
      active = active.shadowRoot.activeElement;
    if (isEditable(active) || hasNativeSelection(root, event)) return;
    const selection = getSelection();
    const text = selection && extractSelectedRightHandText(selection);
    if (text == null) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
  };
  root.addEventListener("copy", copy);
  return () => root.removeEventListener("copy", copy);
}
