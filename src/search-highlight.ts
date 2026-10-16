import type { DiffSearchMatch } from "./diff-search";

const paintedRows = new WeakMap<
  HTMLElement,
  { key: string; spans: HTMLElement[] }
>();

/** Highlight text without flattening the renderer's syntax/word-diff spans. */
export function paintSearchMatches(
  row: HTMLElement,
  matches: readonly DiffSearchMatch[],
  current: DiffSearchMatch | null | undefined,
) {
  const key = matches
    .map((match) => `${match.start}:${match.end}:${match === current}`)
    .join(",");
  const previous = paintedRows.get(row);
  // Selection and cursor paints must not rewrite text or disturb browser copy
  // selection. The renderer may replace a row's children during virtualization.
  if (
    previous?.key === key &&
    previous.spans.every((span) => row.contains(span))
  )
    return;

  for (const span of row.querySelectorAll("[data-fold-search-text]")) {
    const parent = span.parentNode!;
    span.replaceWith(...span.childNodes);
    parent.normalize();
  }

  const spans: HTMLElement[] = [];
  if (matches.length) {
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    let offset = 0;
    for (const node of nodes) {
      const text = node.data;
      const end = offset + text.length;
      const overlaps = matches.filter(
        (match) => match.start < end && match.end > offset,
      );
      if (overlaps.length) {
        const fragment = document.createDocumentFragment();
        let cursor = 0;
        for (const match of overlaps) {
          const start = Math.max(0, match.start - offset);
          const stop = Math.min(text.length, match.end - offset);
          fragment.append(text.slice(cursor, start));
          const span = document.createElement("span");
          span.setAttribute("data-fold-search-text", "");
          span.toggleAttribute("data-fold-search-current", match === current);
          span.textContent = text.slice(start, stop);
          fragment.append(span);
          spans.push(span);
          cursor = stop;
        }
        fragment.append(text.slice(cursor));
        node.replaceWith(fragment);
      }
      offset = end;
    }
  }
  paintedRows.set(row, { key, spans });
}
