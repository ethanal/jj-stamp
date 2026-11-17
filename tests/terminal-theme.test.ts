import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import {
  recolorTerminalLine,
  terminalColorRoles,
  terminalNativeTheme,
  terminalPaletteMap,
  terminalTheme,
} from "../src/terminal-theme.ts";
import { Ghostty, type GhosttyCell, type ITheme } from "ghostty-web";
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

test("internal palette gives ANSI and defaults distinct, stable identities", () => {
  const original = Object.fromEntries(
    terminalColorRoles.map((key) => [key, "#2aa198"]),
  );
  const native = terminalNativeTheme(original);
  assert.equal(
    new Set(terminalColorRoles.map((role) => native[role])).size,
    terminalColorRoles.length,
  );
  assert.deepEqual(native, terminalNativeTheme({ foreground: "#ffffff" }));
  assert.ok(Object.values(original).every((color) => color === "#2aa198"));
});

test("real WASM preserves all ANSI roles across initially colliding palettes", async () => {
  const rgb = (color: string) => parseInt(color.slice(1), 16);
  const colorOf = (cell: GhosttyCell, side: "fg" | "bg") =>
    (cell[`${side}_r`] << 16) | (cell[`${side}_g`] << 8) | cell[`${side}_b`];
  const initial: ITheme = Object.fromEntries(
    terminalColorRoles.map((role) => [role, "#2aa198"]),
  );
  const target: ITheme = Object.fromEntries(
    terminalColorRoles.map((role, index) => [
      role,
      `#20${(index + 1).toString(16).padStart(4, "0")}`,
    ]),
  );
  const native = terminalNativeTheme(initial);
  const wasm = await readFile(
    createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm"),
  );
  const ghostty = await Ghostty.load(
    `data:application/wasm;base64,${wasm.toString("base64")}`,
  );
  const terminal = ghostty.createTerminal(80, 5, {
    fgColor: rgb(native.foreground!),
    bgColor: rgb(native.background!),
    palette: terminalColorRoles.slice(0, 16).map((role) => rgb(native[role]!)),
  });
  try {
    const colors = Array.from({ length: 16 }, (_, i) =>
      i < 8 ? 30 + i : 90 + i - 8,
    );
    const sample =
      colors
        .map((code, i) => `\x1b[${code}m${String.fromCharCode(65 + i)}`)
        .join("") + "\x1b[0mQ";
    terminal.write(sample);
    const before = terminal.getLine(0)!.map((cell) => ({ ...cell }));
    const recolored = recolorTerminalLine(
      before,
      terminalPaletteMap(native, target),
    )!;
    for (let i = 0; i < 17; i++) {
      const role = terminalColorRoles[i];
      assert.equal(colorOf(before[i], "fg"), rgb(native[role]!), role);
      assert.equal(colorOf(recolored[i], "fg"), rgb(target[role]!), role);
      assert.equal(colorOf(recolored[i], "bg"), rgb(target.background!));
    }
    // Native identity survives theme changes, including newly written output.
    terminal.write(`\r\n${sample}`);
    const fresh = recolorTerminalLine(
      terminal.getLine(1),
      terminalPaletteMap(native, target),
    )!;
    assert.deepEqual(fresh.slice(0, 17), recolored.slice(0, 17));
    const back = recolorTerminalLine(
      before,
      terminalPaletteMap(native, initial),
    )!;
    assert.ok(
      back.slice(0, 17).every((cell) => colorOf(cell, "fg") === 0x2aa198),
    );
    // Background roles must not collapse either; fixed indexed colors and
    // explicit truecolors outside the reserved identities stay unchanged.
    terminal.write(
      "\r\n\x1b[44mB\x1b[46mC\x1b[41mR\x1b[101mH\x1b[0m" +
        "\x1b[38;5;16mX\x1b[38;2;42;161;152mY",
    );
    const background = recolorTerminalLine(
      terminal.getLine(2),
      terminalPaletteMap(native, target),
    )!;
    for (const [index, role] of (
      ["blue", "cyan", "red", "brightRed"] as const
    ).entries())
      assert.equal(colorOf(background[index], "bg"), rgb(target[role]!));
    assert.equal(colorOf(background[4], "fg"), 0);
    assert.equal(colorOf(background[5], "fg"), 0x2aa198);
  } finally {
    terminal.free();
  }
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
