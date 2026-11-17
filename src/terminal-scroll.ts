import type { Terminal } from "ghostty-web";

/**
 * Browser-owned scrollback viewport around Ghostty's sticky canvas.
 * Fit to the actual client box (which already excludes a native scrollbar),
 * not FitAddon's additional, unconditional 15px scrollbar reservation.
 */
export function fitTerminal(term: Terminal) {
  const element = term.element;
  const metrics = term.renderer?.getMetrics();
  if (!element?.clientWidth || !element.clientHeight || !metrics) return;
  const cols = Math.max(
    1,
    Math.min(500, Math.floor(element.clientWidth / metrics.width)),
  );
  const rows = Math.max(
    1,
    Math.min(300, Math.floor(element.clientHeight / metrics.height)),
  );
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows);
}

export function installTerminalScroll(
  term: Terminal,
  viewport: HTMLElement,
  spacer: HTMLElement,
) {
  const renderer = term.renderer!;
  const render = renderer.render.bind(renderer);
  const write = term.write.bind(term);

  // Audited against ghostty-web 0.4.0. Its public custom-wheel hook runs AFTER
  // preventDefault, so intercept normal-screen wheels at the ancestor instead.
  // Its canvas scrollbar also has an invisible capture-phase mouse hit target;
  // remove only that handler, leaving selection, links and focus untouched.
  const mouseDown = (term as unknown as { handleMouseDown: EventListener })
    .handleMouseDown;
  if (typeof mouseDown !== "function")
    throw new Error("Unsupported Ghostty scrollbar handler");
  term.element!.removeEventListener("mousedown", mouseDown, true);

  let writing = false;
  let syncing = false;
  let lastLength = -1;
  let lastHeight = -1;
  let lastViewport = -1;
  let lastTop = 0;
  const alternate = () => term.wasmTerm?.isAlternateScreen() ?? false;

  const readScroll = () => {
    if (syncing || !viewport.clientHeight || viewport.scrollTop === lastTop)
      return;
    lastTop = viewport.scrollTop;
    const height = renderer.getMetrics().height;
    // Ghostty 0.4's actual public offset is measured BACK from the bottom,
    // despite scrollToLine's declaration comment saying the opposite.
    const length = alternate() ? 0 : term.getScrollbackLength();
    lastViewport = Math.max(
      0,
      Math.min(length, Math.round(length - lastTop / height)),
    );
    syncing = true;
    term.scrollToLine(lastViewport);
    syncing = false;
  };
  const sync = () => {
    if (syncing || writing || !viewport.clientHeight) return;
    const length = alternate() ? 0 : term.getScrollbackLength();
    const height = renderer.getMetrics().height;
    const offset = Math.min(length, term.getViewportY());
    if (
      length !== lastLength ||
      height !== lastHeight ||
      offset !== lastViewport
    ) {
      syncing = true;
      spacer.style.height = `${length * height}px`;
      viewport.scrollTop = (length - offset) * height;
      lastTop = viewport.scrollTop;
      lastLength = length;
      lastHeight = height;
      lastViewport = offset;
      if (term.getViewportY() !== offset) term.scrollToLine(offset);
      syncing = false;
    }
  };
  const wheel = (event: WheelEvent) => {
    // Native wheel/trackpad scrolling, including browser inertia. Do not
    // preventDefault. Full-screen apps retain Ghostty's arrow-key forwarding.
    if (!alternate()) event.stopPropagation();
  };
  viewport.addEventListener("wheel", wheel, { capture: true, passive: true });
  viewport.addEventListener("scroll", readScroll, { passive: true });
  const scroll = term.onScroll(sync);

  // Use Ghostty's existing render loop instead of adding another animation loop
  // or trusting onRender (not emitted by 0.4). Reconcile native scroll first:
  // a compositor scroll may have happened before its DOM event is delivered.
  renderer.render = (buffer, forceAll, _offset, scrollback) => {
    readScroll();
    sync();
    // Opacity zero bypasses the canvas scrollbar entirely, including the
    // background strip it otherwise paints over the last terminal columns.
    render(buffer, forceAll, term.getViewportY(), scrollback, 0);
  };
  term.write = (data, callback) => {
    readScroll();
    const offset = term.getViewportY();
    const length = term.getScrollbackLength();
    const wasAlternate = alternate();
    writing = true;
    try {
      write(data, callback);
      // Keep the line being read stationary as output arrives. Follow output
      // only when already at the bottom; typing still returns to the prompt.
      // Once Ghostty evicts retained history, older lines can shift: 0.4 exposes
      // the retained length but no total appended/evicted-row counter.
      if (offset > 0 && !wasAlternate && !alternate())
        term.scrollToLine(
          offset + Math.max(0, term.getScrollbackLength() - length),
        );
    } finally {
      writing = false;
      sync();
    }
  };
  const input = term.onData(() => {
    readScroll();
    term.scrollToBottom();
  });
  sync();

  return {
    dispose() {
      viewport.removeEventListener("wheel", wheel, true);
      viewport.removeEventListener("scroll", readScroll);
      scroll.dispose();
      input.dispose();
      renderer.render = render;
      term.write = write;
      spacer.style.height = "";
      term.element?.addEventListener("mousedown", mouseDown, true);
    },
  };
}
