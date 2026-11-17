import test from "node:test";
import assert from "node:assert/strict";
import type { GhosttyCell, ITheme, Terminal } from "ghostty-web";
import {
  installTerminalPixelAlignment,
  installTerminalTheme,
} from "../src/terminal-renderer.ts";

test("rectangle edges meet in device pixels across scales and canvas resizes", () => {
  let transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const fills: number[][] = [];
  const context = {
    getTransform: () => transform,
    fillRect(x: number, y: number, width: number, height: number) {
      assert.equal(this, context);
      const { a, d, e, f } = transform;
      fills.push([x * a + e, y * d + f, width * a, height * d]);
    },
  };
  installTerminalPixelAlignment({
    renderer: { getCanvas: () => ({ getContext: () => context }) },
  } as unknown as Terminal);
  for (const scale of [1, 1.1, 1.25, 1.5, 1.75, 2, 2.5]) {
    // Change the transform on the same context, as resize() does.
    transform = { a: scale, b: 0, c: 0, d: scale, e: 0, f: 0 };
    fills.length = 0;
    for (let row = 0; row < 4; row++)
      for (let col = 0; col < 4; col++)
        context.fillRect(col * 9, row * 15, 9, 15);
    for (let i = 0; i < fills.length; i++) {
      const [x, y, width, height] = fills[i];
      for (const value of fills[i])
        assert.ok(Math.abs(value - Math.round(value)) < 1e-10);
      if (i % 4 < 3) assert.ok(Math.abs(x + width - fills[i + 1][0]) < 1e-10);
      if (i < 12) assert.ok(Math.abs(y + height - fills[i + 4][1]) < 1e-10);
    }
    assert.equal(fills[0][0], 0);
    assert.equal(fills[0][1], 0);
    assert.equal(Math.round(fills[3][0] + fills[3][2]), Math.round(36 * scale));
    assert.equal(
      Math.round(fills[12][1] + fills[12][3]),
      Math.round(60 * scale),
    );
  }
});

test("alignment uses the canvas transform and leaves unsupported transforms alone", () => {
  let transform = { a: 1.25, b: 0, c: 0, d: 1.5, e: 0.25, f: 0.5 };
  let last: number[] = [];
  const context = {
    getTransform: () => transform,
    fillRect: (...rect: number[]) => {
      last = rect;
    },
  };
  installTerminalPixelAlignment({
    renderer: { getCanvas: () => ({ getContext: () => context }) },
  } as unknown as Terminal);
  context.fillRect(1, 2, 9, 15);
  assert.deepEqual(last, [1.4, 7 / 3, 8.8, 44 / 3]);
  context.fillRect(1, 2, 0, 0);
  assert.deepEqual(last, [1.4, 7 / 3, 0, 0]);
  for (const change of [{ b: 1 }, { c: 1 }, { a: 0 }, { d: -1 }]) {
    transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, ...change };
    context.fillRect(1, 2, 9, 15);
    assert.deepEqual(last, [1, 2, 9, 15]);
  }
});

test("live renderer adapts viewport and scrollback without touching native state", () => {
  const cell = {
    codepoint: 65,
    fg_r: 17,
    fg_g: 34,
    fg_b: 51,
    bg_r: 68,
    bg_g: 85,
    bg_b: 102,
  } as GhosttyCell;
  const initial = { foreground: "#112233", background: "#445566" };
  const current = { foreground: "#aabbcc", background: "#ddeeff" };
  const captures: Array<{
    live: GhosttyCell[];
    history: GhosttyCell[];
    viewport: number;
    force: boolean;
  }> = [];
  const buffer = {
    getLine(row: number) {
      assert.equal(this, buffer);
      assert.equal(row, 0);
      return [cell];
    },
  };
  let selected: ITheme | undefined;
  const renderer = {
    setTheme(theme: ITheme) {
      assert.equal(this, renderer);
      selected = theme;
    },
    render(
      native: typeof buffer,
      force: boolean,
      viewport: number,
      scrollback: { getScrollbackLine(row: number): GhosttyCell[] },
    ) {
      assert.equal(this, renderer);
      captures.push({
        live: native.getLine(0),
        history: scrollback.getScrollbackLine(0),
        viewport,
        force,
      });
    },
  };
  const terminal = {
    renderer,
    wasmTerm: buffer,
    getViewportY: () => 7,
    getScrollbackLine(row: number) {
      assert.equal(this, terminal);
      assert.equal(row, 0);
      return [cell];
    },
  };
  const apply = installTerminalTheme(terminal as unknown as Terminal, initial);
  apply(current);
  assert.equal(selected, current);
  assert.equal(
    captures[0].viewport,
    7,
    "palette changes preserve scroll position",
  );
  assert.equal(
    captures[0].force,
    true,
    "unchanged/blank cells are repainted too",
  );
  for (const line of [captures[0].live, captures[0].history]) {
    assert.deepEqual(
      [line[0].fg_r, line[0].fg_g, line[0].fg_b],
      [170, 187, 204],
    );
    assert.deepEqual(
      [line[0].bg_r, line[0].bg_g, line[0].bg_b],
      [221, 238, 255],
    );
  }
  assert.equal(cell.fg_r, 17);
  assert.equal(cell.bg_r, 68);
  apply(initial);
  assert.deepEqual(
    captures[1].live,
    [cell],
    "returning to original palette is lossless",
  );
});
