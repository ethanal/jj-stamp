import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { HunkContext } from "./hunk-context";
import type { Hunk } from "./types";

// Bump when grammar packages, extraction rules, or result representation change.
export const HUNK_CONTEXT_SCHEMA =
  "tree-sitter-wasm-2.0.2/web-tree-sitter-0.27.0/scope-1";
export type HunkContexts = Record<string, HunkContext>;
export interface HunkContextRequest {
  id: number;
  schema: string;
  path: string;
  hunks: Hunk[];
  files: FileDiffLoadedFiles;
}
export type HunkContextResponse =
  | { id: number; schema: string; contexts: HunkContexts }
  | { id: number; schema: string; error: string };
