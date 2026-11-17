import type { GhosttyCell, ITheme, Terminal } from "ghostty-web";
import { recolorTerminalLine, terminalPaletteMap } from "./terminal-theme";

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
