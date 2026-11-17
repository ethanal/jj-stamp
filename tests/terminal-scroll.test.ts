import test from "node:test";
import assert from "node:assert/strict";
import type { Terminal } from "ghostty-web";
import { fitTerminal, installTerminalScroll } from "../src/terminal-scroll.ts";

// Node's EventTarget needs an options object to remove capture listeners;
// browsers also accept the boolean shorthand used by the adapter.
class ElementTarget extends EventTarget {
  override removeEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: EventListenerOptions | boolean,
  ) {
    super.removeEventListener(
      type,
      callback,
      typeof options === "boolean" ? { capture: options } : options,
    );
  }
}

function fixture() {
  const spacer = { style: { height: "" } };
  class Viewport extends ElementTarget {
    clientHeight = 100;
    assignments = 0;
    private top = 0;
    get scrollTop() {
      return Math.max(
        0,
        Math.min(this.top, Number.parseFloat(spacer.style.height) || 0),
      );
    }
    set scrollTop(value: number) {
      this.assignments++;
      // Sticky terminal occupies clientHeight; the spacer adds scrollback.
      this.top = Math.max(
        0,
        Math.min(value, Number.parseFloat(spacer.style.height) || 0),
      );
    }
  }
  const viewport = new Viewport();
  const element = new ElementTarget();
  const metrics = { width: 8, height: 10 };
  const state = {
    length: 10,
    offset: 0,
    alternate: false,
    appended: 0,
    historyLimit: Infinity,
    failure: undefined as Error | undefined,
  };
  const scrollListeners = new Set<() => void>();
  const inputListeners = new Set<() => void>();
  const scrollCalls: number[] = [];
  const renderCalls: unknown[][] = [];
  const writes: Array<string | Uint8Array> = [];
  let mouseDowns = 0;
  const handleMouseDown = () => mouseDowns++;
  element.addEventListener("mousedown", handleMouseDown, true);
  const renderer = {
    getMetrics: () => metrics,
    render(...args: unknown[]) {
      assert.equal(this, renderer, "renderer receiver is preserved");
      renderCalls.push(args);
    },
  };
  const terminal = {
    element,
    renderer,
    handleMouseDown,
    wasmTerm: { isAlternateScreen: () => state.alternate },
    getScrollbackLength: () => state.length,
    getViewportY: () => state.offset,
    scrollToLine(offset: number) {
      assert.equal(this, terminal);
      scrollCalls.push(offset);
      const next = Math.max(0, Math.min(state.length, offset));
      if (next === state.offset) return;
      state.offset = next;
      for (const listener of scrollListeners) listener();
    },
    scrollToBottom() {
      this.scrollToLine(0);
    },
    onScroll(listener: () => void) {
      scrollListeners.add(listener);
      return { dispose: () => scrollListeners.delete(listener) };
    },
    onData(listener: () => void) {
      inputListeners.add(listener);
      return { dispose: () => inputListeners.delete(listener) };
    },
    write(data: string | Uint8Array, callback?: () => void) {
      assert.equal(this, terminal, "write receiver is preserved");
      writes.push(data);
      if (state.failure) throw state.failure;
      state.length = Math.min(
        state.historyLimit,
        state.length + state.appended,
      );
      // Ghostty 0.4 resets to bottom during write, firing onScroll.
      if (state.offset !== 0) this.scrollToBottom();
      callback?.();
    },
  };
  return {
    terminal,
    viewport,
    spacer,
    metrics,
    state,
    scrollCalls,
    scrollListeners,
    inputListeners,
    renderCalls,
    writes,
    mouseDowns: () => mouseDowns,
    install: () =>
      installTerminalScroll(
        terminal as unknown as Terminal,
        viewport as unknown as HTMLElement,
        spacer as unknown as HTMLElement,
      ),
    render: () =>
      terminal.renderer.render("buffer", true, 999, "scrollback", 1),
    input: () => {
      for (const listener of inputListeners) listener();
    },
  };
}

function fitFixture() {
  const calls: number[][] = [];
  const terminal = {
    element: { clientWidth: 803, clientHeight: 405 },
    renderer: { getMetrics: () => ({ width: 8, height: 20 }) },
    cols: 80,
    rows: 24,
    resize(cols: number, rows: number) {
      calls.push([cols, rows]);
      this.cols = cols;
      this.rows = rows;
    },
  };
  return {
    terminal,
    calls,
    fit: () => fitTerminal(terminal as unknown as Terminal),
  };
}

test("fit uses the full client box without reserving another scrollbar", () => {
  const f = fitFixture();
  f.fit();
  assert.deepEqual(f.calls, [[100, 20]]);
  f.fit();
  assert.equal(f.calls.length, 1, "unchanged dimensions do not resize");
  f.terminal.element.clientWidth = 800;
  f.fit();
  assert.equal(f.calls.length, 1, "exact cell boundary still fits 100 columns");
});

test("fit clamps both dimensions and skips hidden or unavailable geometry", () => {
  const f = fitFixture();
  f.terminal.element = { clientWidth: 1, clientHeight: 1 };
  f.fit();
  f.terminal.element = { clientWidth: 100_000, clientHeight: 100_000 };
  f.fit();
  assert.deepEqual(f.calls, [
    [1, 1],
    [500, 300],
  ]);
  for (const [clientWidth, clientHeight] of [
    [0, 100],
    [100, 0],
    [0, 0],
  ]) {
    f.terminal.element = { clientWidth, clientHeight };
    f.fit();
  }
  fitTerminal({ renderer: f.terminal.renderer } as unknown as Terminal);
  fitTerminal({
    element: { clientWidth: 800, clientHeight: 400 },
  } as unknown as Terminal);
  fitTerminal({
    element: { clientWidth: 800, clientHeight: 400 },
    renderer: { getMetrics: () => undefined },
  } as unknown as Terminal);
  assert.equal(f.calls.length, 2);
});

test("native and terminal scrolling synchronize with bottom-relative offsets", () => {
  const f = fixture();
  const adapter = f.install();
  assert.equal(f.spacer.style.height, "100px");
  assert.equal(f.viewport.scrollTop, 100);
  f.viewport.scrollTop = 30;
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.equal(f.state.offset, 7);
  assert.deepEqual(f.scrollCalls, [7]);
  f.terminal.scrollToLine(4);
  assert.equal(f.viewport.scrollTop, 60);
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.deepEqual(f.scrollCalls, [7, 4], "programmatic scroll does not echo");
  f.viewport.scrollTop = -100;
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.equal(f.state.offset, 10);
  f.viewport.scrollTop = 1_000;
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.equal(f.state.offset, 0);
  adapter.dispose();
});

test("fractional native scrolling survives scroll events and render reconciliation", () => {
  const f = fixture();
  const adapter = f.install();
  f.viewport.scrollTop = 34.25;
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.equal(f.state.offset, 7);
  const assignments = f.viewport.assignments;
  f.render();
  f.render();
  assert.equal(
    f.viewport.scrollTop,
    34.25,
    "do not snap native pixels to rows",
  );
  assert.equal(f.viewport.assignments, assignments);
  assert.deepEqual(
    f.scrollCalls,
    [7],
    "unchanged renders do not scroll terminal",
  );
  f.viewport.scrollTop = 47.5;
  // A compositor scroll can precede the browser's scroll event.
  f.render();
  assert.equal(f.state.offset, 5);
  assert.equal(f.viewport.scrollTop, 47.5);
  assert.deepEqual(f.renderCalls.at(-1), ["buffer", true, 5, "scrollback", 0]);
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.deepEqual(f.scrollCalls, [7, 5]);
  adapter.dispose();
});

test("renders use live offsets and disable the entire canvas scrollbar", () => {
  const f = fixture();
  const adapter = f.install();
  f.terminal.scrollToLine(3);
  f.render();
  assert.deepEqual(f.renderCalls, [["buffer", true, 3, "scrollback", 0]]);
  f.metrics.height = 12;
  f.render();
  assert.equal(f.spacer.style.height, "120px");
  assert.equal(f.viewport.scrollTop, 84);
  adapter.dispose();
});

test("shrinking history clamps a stale terminal offset without scroll feedback", () => {
  const f = fixture();
  const adapter = f.install();
  f.terminal.scrollToLine(8);
  f.state.length = 3;
  f.render();
  assert.equal(f.spacer.style.height, "30px");
  assert.equal(f.viewport.scrollTop, 0);
  assert.equal(f.state.offset, 3);
  assert.deepEqual(f.scrollCalls, [8, 3]);
  f.viewport.dispatchEvent(new Event("scroll"));
  f.render();
  assert.deepEqual(f.scrollCalls, [8, 3]);
  adapter.dispose();
});

test("hidden viewport does not change scroll state until it becomes measurable", () => {
  const f = fixture();
  f.viewport.clientHeight = 0;
  const adapter = f.install();
  assert.equal(f.spacer.style.height, "");
  assert.equal(f.viewport.assignments, 0);
  f.render();
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.deepEqual(f.scrollCalls, []);
  assert.equal(f.viewport.assignments, 0);
  f.viewport.clientHeight = 100;
  f.render();
  assert.equal(f.spacer.style.height, "100px");
  assert.equal(f.viewport.scrollTop, 100);
  adapter.dispose();
});

test("normal wheels retain native defaults; alternate-screen wheels reach Ghostty", () => {
  const f = fixture();
  const adapter = f.install();
  for (const alternate of [false, true]) {
    f.state.alternate = alternate;
    let stopped = 0;
    const wheel = new Event("wheel", { bubbles: true, cancelable: true });
    wheel.stopPropagation = () => stopped++;
    f.viewport.dispatchEvent(wheel);
    assert.equal(stopped, alternate ? 0 : 1);
    assert.equal(wheel.defaultPrevented, false);
  }
  adapter.dispose();
});

test("alternate screen removes native history and normal screen restores it", () => {
  const f = fixture();
  const adapter = f.install();
  f.terminal.scrollToLine(4);
  f.state.alternate = true;
  f.render();
  assert.equal(f.spacer.style.height, "0px");
  assert.equal(f.viewport.scrollTop, 0);
  assert.equal(f.state.offset, 0);
  f.state.alternate = false;
  f.render();
  assert.equal(f.spacer.style.height, "100px");
  assert.equal(f.viewport.scrollTop, 100);
  adapter.dispose();
});

test("appending before eviction preserves the visible history line; bottom follows output", () => {
  const f = fixture();
  const adapter = f.install();
  f.viewport.scrollTop = 32.5;
  // write must reconcile native scrolling even before its DOM event arrives.
  f.state.appended = 3;
  const data = new Uint8Array([65]);
  let callbacks = 0;
  f.terminal.write(data, () => callbacks++);
  assert.equal(f.state.length, 13);
  assert.equal(f.state.offset, 10);
  assert.equal(f.state.length - f.state.offset, 3, "same retained history row");
  assert.equal(f.spacer.style.height, "130px");
  assert.equal(f.viewport.scrollTop, 30);
  assert.equal(callbacks, 1);
  assert.equal(f.writes[0], data);
  f.input();
  assert.equal(f.state.offset, 0, "typing returns to prompt");
  assert.equal(f.viewport.scrollTop, 130);
  f.terminal.write("more output");
  assert.equal(f.state.offset, 0);
  assert.equal(f.viewport.scrollTop, 160);
  adapter.dispose();
});

test("retained-length eviction stays bounded without pretending to track evicted lines", () => {
  const f = fixture();
  const adapter = f.install();
  f.terminal.scrollToLine(5);
  f.state.historyLimit = 10;
  f.state.appended = 3;
  f.terminal.write("evicted history");
  assert.equal(f.state.length, 10);
  assert.equal(f.state.offset, 5);
  assert.equal(f.viewport.scrollTop, 50);
  adapter.dispose();
});

test("input returns to bottom even before a pending native scroll event", () => {
  const f = fixture();
  const adapter = f.install();
  f.viewport.scrollTop = 30;
  f.input();
  f.viewport.dispatchEvent(new Event("scroll"));
  f.render();
  assert.equal(f.state.offset, 0);
  assert.equal(f.viewport.scrollTop, 100);
  adapter.dispose();
});

test("write failure propagates without leaving synchronization disabled", () => {
  const f = fixture();
  const adapter = f.install();
  f.state.failure = new Error("write failed");
  assert.throws(() => f.terminal.write("output"), f.state.failure);
  f.terminal.scrollToLine(6);
  assert.equal(f.viewport.scrollTop, 40);
  f.state.failure = undefined;
  f.state.appended = 2;
  f.terminal.write("recovered");
  assert.equal(f.state.offset, 8);
  assert.equal(f.viewport.scrollTop, 40);
  adapter.dispose();
});

test("dispose removes native and terminal listeners and restores original hooks", () => {
  const f = fixture();
  const originalRender = f.terminal.renderer.render;
  const originalWrite = f.terminal.write;
  const adapter = f.install();
  assert.notEqual(f.terminal.renderer.render, originalRender);
  assert.notEqual(f.terminal.write, originalWrite);
  f.terminal.element.dispatchEvent(new Event("mousedown"));
  assert.equal(f.mouseDowns(), 0, "canvas scrollbar hit target is detached");
  adapter.dispose();
  assert.equal(f.spacer.style.height, "");
  assert.equal(f.scrollListeners.size, 0);
  assert.equal(f.inputListeners.size, 0);
  f.spacer.style.height = "100px";
  f.viewport.scrollTop = 20;
  f.viewport.dispatchEvent(new Event("scroll"));
  assert.deepEqual(f.scrollCalls, [], "native scroll listener is removed");
  let stopped = false;
  const wheel = new Event("wheel");
  wheel.stopPropagation = () => {
    stopped = true;
  };
  f.viewport.dispatchEvent(wheel);
  assert.equal(stopped, false, "capture-phase wheel listener is removed");
  f.terminal.element.dispatchEvent(new Event("mousedown"));
  assert.equal(f.mouseDowns(), 1, "original capture-phase hit target restored");
  f.terminal.scrollToLine(4);
  assert.equal(f.viewport.scrollTop, 20, "onScroll listener is removed");
  f.input();
  assert.equal(f.state.offset, 4, "onData listener is removed");
  f.render();
  assert.deepEqual(f.renderCalls.at(-1), [
    "buffer",
    true,
    999,
    "scrollback",
    1,
  ]);
  f.state.appended = 2;
  f.terminal.write("unwrapped output");
  assert.equal(f.state.offset, 0, "original write no longer preserves history");
  assert.deepEqual(f.writes, ["unwrapped output"]);
});
