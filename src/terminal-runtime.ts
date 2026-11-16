/// <reference types="vite/client" />

import { Ghostty } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
export { Terminal, FitAddon } from "ghostty-web";
export { installTerminalTheme } from "./terminal-renderer";

// Fetch a local, content-hashed asset (browser-cacheable), never a CDN. Give
// each session its own WASM memory: ghostty-web 0.4 can expose stale screen cells
// when an emulator is freed and recreated within a shared Ghostty instance.
export function loadGhostty() {
  return Ghostty.load(wasmUrl);
}
