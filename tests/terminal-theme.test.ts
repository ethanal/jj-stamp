import test from "node:test";
import assert from "node:assert/strict";
import {
  recolorTerminalLine,
  terminalPaletteMap,
  terminalTheme,
} from "../src/terminal-theme.ts";
import type { GhosttyCell } from "ghostty-web";
import { configPatchSchema, defaultConfig } from "../src/config.ts";

test("terminal colors follow UI semantic palette, including selection and ANSI", () => {
  const palette = terminalTheme({
    getPropertyValue: (key) => ` ${key} `,
  });
  assert.equal(palette.background, "--bg");
  assert.equal(palette.foreground, "--fg");
  assert.equal(palette.cursor, "--strong");
  assert.equal(palette.cursorAccent, "--bg");
  assert.equal(palette.selectionBackground, "--diff-selection-bg");
  assert.equal(palette.red, "--red");
  assert.equal(palette.green, "--added");
  assert.equal(palette.yellow, "--modified");
  assert.equal(palette.blue, "--accent");
  assert.equal(palette.magenta, "--bookmark");
  assert.equal(palette.brightWhite, "--strong");
  assert.equal(Object.keys(palette).length, 22);
});

test("live palette adaptation preserves native cells and unrelated truecolors", () => {
  const palette = terminalPaletteMap(
    { foreground: "#abcdef", background: "#123456", red: "#aa0000" },
    { foreground: "#112233", background: "#445566", red: "#ff0000" },
  );
  const original = {
    codepoint: 65,
    fg_r: 171,
    fg_g: 205,
    fg_b: 239,
    bg_r: 18,
    bg_g: 52,
    bg_b: 86,
  } as GhosttyCell;
  const colored = recolorTerminalLine([original], palette)![0];
  assert.deepEqual([colored.fg_r, colored.fg_g, colored.fg_b], [17, 34, 51]);
  assert.deepEqual([colored.bg_r, colored.bg_g, colored.bg_b], [68, 85, 102]);
  assert.deepEqual(
    [original.fg_r, original.fg_g, original.fg_b],
    [171, 205, 239],
  );
  const truecolor = { ...original, fg_r: 99, fg_g: 88, fg_b: 77 };
  assert.deepEqual(recolorTerminalLine([truecolor], palette)![0].fg_r, 99);
  assert.equal(recolorTerminalLine(null, palette), null);
});

test("shell defaults to native and accepts one literal executable, not multiline input", () => {
  assert.equal(defaultConfig.shell, "");
  assert.deepEqual(configPatchSchema.parse({ shell: " /bin/zsh " }), {
    shell: "/bin/zsh",
  });
  assert.deepEqual(
    configPatchSchema.parse({ shell: "/path with spaces/shell" }),
    {
      shell: "/path with spaces/shell",
    },
  );
  for (const shell of [
    12,
    null,
    "/bin/sh\0bad",
    "/bin/sh\n-c bad",
    "x".repeat(4097),
  ]) {
    assert.equal(configPatchSchema.safeParse({ shell }).success, false);
  }
});
