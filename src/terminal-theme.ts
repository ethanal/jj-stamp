import type { GhosttyCell, ITheme } from "ghostty-web";

/** Use the same semantic palette as the surrounding UI, including ANSI colors. */
export function terminalTheme(
  style: Pick<CSSStyleDeclaration, "getPropertyValue">,
): ITheme {
  const color = (name: string) => style.getPropertyValue(`--${name}`).trim();
  return {
    background: color("bg"),
    foreground: color("fg"),
    cursor: color("strong"),
    cursorAccent: color("bg"),
    selectionBackground: color("diff-selection-bg"),
    selectionForeground: color("diff-selection-fg"),
    black: color("bg"),
    red: color("red"),
    green: color("added"),
    yellow: color("modified"),
    blue: color("accent"),
    magenta: color("bookmark"),
    cyan: color("diff-selection-border"),
    white: color("fg"),
    brightBlack: color("muted"),
    brightRed: color("removed"),
    brightGreen: color("added"),
    brightYellow: color("modified"),
    brightBlue: color("accent"),
    brightMagenta: color("bookmark"),
    brightCyan: color("diff-selection-border"),
    brightWhite: color("strong"),
  };
}

export function terminalPaletteMap(initial: ITheme, current: ITheme) {
  const palette = new Map<number, number>();
  for (const key of [
    "black",
    "red",
    "green",
    "yellow",
    "blue",
    "magenta",
    "cyan",
    "white",
    "brightBlack",
    "brightRed",
    "brightGreen",
    "brightYellow",
    "brightBlue",
    "brightMagenta",
    "brightCyan",
    "brightWhite",
    "foreground",
    "background",
  ] as const) {
    if (initial[key] && current[key])
      palette.set(
        parseInt(initial[key].slice(1), 16),
        parseInt(current[key].slice(1), 16),
      );
  }
  return palette;
}

/** Native cells contain resolved RGB, not color indices. Only palette-matching
 * colors are remapped; unrelated application truecolors remain unchanged. */
export function recolorTerminalLine(
  line: GhosttyCell[] | null,
  palette: Map<number, number>,
) {
  return (
    line?.map((cell) => {
      const fg = palette.get((cell.fg_r << 16) | (cell.fg_g << 8) | cell.fg_b);
      const bg = palette.get((cell.bg_r << 16) | (cell.bg_g << 8) | cell.bg_b);
      return {
        ...cell,
        ...(fg === undefined
          ? {}
          : { fg_r: fg >> 16, fg_g: (fg >> 8) & 255, fg_b: fg & 255 }),
        ...(bg === undefined
          ? {}
          : { bg_r: bg >> 16, bg_g: (bg >> 8) & 255, bg_b: bg & 255 }),
      };
    }) ?? null
  );
}
