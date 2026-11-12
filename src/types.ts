export interface Row {
  index: number;
  raw: string;
  /** The source line has no terminating LF; not a separate selectable row. */
  noNewline?: boolean;
  oldLine?: number;
  newLine?: number;
}
export interface Hunk {
  id: string;
  header: string;
  rows: Row[];
}
export interface DiffFile {
  path: string;
  /** Original path for a rename; path always identifies the destination. */
  oldPath?: string;
  patch: string;
  additions: number;
  deletions: number;
  unsupported?: string;
  /** Display is supported, but this file cannot be squashed. */
  squashUnsupported?: string;
  hunks: Hunk[];
}
export interface Revision {
  changeId: string;
  commitId: string;
  description: string;
  author?: string;
  changeIdPrefix?: string;
}
export interface LogRow {
  graph: string;
  revision?: Revision;
  bookmarks?: string[];
  mutable?: boolean;
  isWorkingCopy?: boolean;
  isEmpty?: boolean;
}
export interface RepoState {
  repo: { name: string; path: string };
  version: string;
  source: Revision;
  parent: Revision | null;
  squashUnavailable?: string;
  targets: Revision[];
  files: DiffFile[];
  operation: string;
  canUndo: boolean;
}
export type Selections = Record<string, number[]>;

/** Filesystem invalidation hints, never mutation authorization or file contents. */
export interface RepositoryChange {
  workspace: boolean;
  heads: string[] | null;
}
