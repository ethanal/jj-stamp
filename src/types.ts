export interface Row {
  index: number;
  raw: string;
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
  patch: string;
  additions: number;
  deletions: number;
  unsupported?: string;
  hunks: Hunk[];
}
export interface Revision {
  changeId: string;
  commitId: string;
  description: string;
}
export interface RepoState {
  repo: { name: string; path: string; demo: boolean };
  version: string;
  source: Revision;
  targets: Revision[];
  files: DiffFile[];
  operation: string;
  canUndo: boolean;
}
export interface Preview {
  token: string;
  patch: string;
  specs: string[];
  command: string;
  selectedLines: number;
}
export type Selections = Record<string, number[]>;
