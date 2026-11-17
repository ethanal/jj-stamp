/// <reference types="vite/client" />

import { Ghostty } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import {
  detectTerminalQuerySupport,
  TerminalQueryResponder,
  type TerminalQuerySupport,
} from "./terminal-queries";
export { Terminal, FitAddon } from "ghostty-web";
export {
  installTerminalPixelAlignment,
  installTerminalTheme,
} from "./terminal-renderer";

// Fetch a local, content-hashed asset (browser-cacheable), never a CDN. Give
// each session its own WASM memory: ghostty-web 0.4 can expose stale screen cells
// when an emulator is freed and recreated within a shared Ghostty instance.
export function loadGhostty() {
  return Ghostty.load(wasmUrl);
}

let querySupport: Promise<TerminalQuerySupport> | undefined;

export async function loadTerminalQueries() {
  // Probe a separate disposable instance, once per asset/page. Never free and
  // reuse the real session's WASM memory (even for an otherwise empty probe).
  // Detect each family independently so a future native fix gets no duplicate
  // replies. Failed loads must remain retryable, not poison the module cache.
  querySupport ??= Ghostty.load(wasmUrl)
    .then((ghostty) => detectTerminalQuerySupport(ghostty.createTerminal(1, 1)))
    .catch((error: unknown) => {
      querySupport = undefined;
      throw error;
    });
  return new TerminalQueryResponder(await querySupport);
}
