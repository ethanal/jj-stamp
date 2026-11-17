import type { GhosttyCell, ITheme, Terminal } from "ghostty-web";
import { recolorTerminalLine, terminalPaletteMap } from "./terminal-theme";

/**
 * Ghostty 0.4 fills each cell separately in CSS pixels. At fractional DPRs,
 * antialiased rectangle edges expose the underlying background as a grid.
 * Snap shared edges (not widths) to backing-store pixels, so adjacent fills
 * meet exactly without overlapping their neighbors. Keep text metrics and
 * glyph rendering untouched. This patches only this terminal's canvas context.
 */
export function installTerminalPixelAlignment(term: Terminal) {
  const context = term.renderer!.getCanvas().getContext("2d")!;
  const fillRect = context.fillRect.bind(context);
  context.fillRect = (x, y, width, height) => {
    // Read the actual transform: canvas resizing resets it, and the renderer
    // owns its scale. window.devicePixelRatio need not match that scale.
    const { a, b, c, d, e, f } = context.getTransform();
    if (b !== 0 || c !== 0 || a <= 0 || d <= 0) {
      fillRect(x, y, width, height);
      return;
    }
    const left = Math.round(x * a + e);
    const top = Math.round(y * d + f);
    const right = Math.round((x + width) * a + e);
    const bottom = Math.round((y + height) * d + f);
    fillRect(
      (left - e) / a,
      (top - f) / d,
      (right - left) / a,
      (bottom - top) / d,
    );
  };
}

/**
 * Compatibility shim for ghostty-web 0.4: options.theme is not live, and its
 * WASM build cannot process OSC palette changes. Adapt the public renderer
 * inputs, without rewriting parser state, replaying output or restarting PTYs.
 * Both active/alternate screens and scrollback use the current UI palette.
 */
export function installTerminalTheme(
  term: Terminal,
  initial: ITheme,
  current: ITheme = initial,
) {
  const renderer = term.renderer!;
  const render = renderer.render.bind(renderer);
  let palette = terminalPaletteMap(initial, current);
  renderer.setTheme(current);
  const adapters = new WeakMap<object, object>();
  function adapted<T extends object>(target: T): T {
    let adapter = adapters.get(target);
    if (!adapter) {
      adapter = new Proxy(target, {
        get(object, key) {
          const value = Reflect.get(object, key, object);
          if (
            (key === "getLine" || key === "getScrollbackLine") &&
            typeof value === "function"
          )
            return (row: number) =>
              recolorTerminalLine(
                value.call(object, row) as GhosttyCell[] | null,
                palette,
              );
          return typeof value === "function" ? value.bind(object) : value;
        },
      });
      adapters.set(target, adapter);
    }
    return adapter as T;
  }
  renderer.render = (buffer, forceAll, viewport, scrollback, opacity) =>
    render(
      adapted(buffer),
      forceAll,
      viewport,
      scrollback ? adapted(scrollback) : undefined,
      opacity,
    );
  return (theme: ITheme) => {
    palette = terminalPaletteMap(initial, theme);
    renderer.setTheme(theme);
    if (term.wasmTerm)
      renderer.render(term.wasmTerm, true, term.getViewportY(), term);
  };
}
