/// <reference types="vite/client" />

// Make Pierre's worker the actual Vite entry. A local worker that only imports
// this module for side effects becomes empty in production: the package marks
// worker.js as side-effect-free, so Rollup discards that import.
export { default } from "@pierre/diffs/worker/worker.js?worker";
