import test from "node:test";
import assert from "node:assert/strict";
import type { GhosttyCell, ITheme, Terminal } from "ghostty-web";
import { installTerminalTheme } from "../src/terminal-renderer.ts";

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
