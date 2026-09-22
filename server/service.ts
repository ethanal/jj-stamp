import { createHash, randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  parseFile,
  parseRevisionListing,
  reconcileListing,
  ranges,
  assertExactPreview,
} from "./diff.ts";
import type { FileDiff, Hunk, Row, RevisionListing } from "./diff.ts";
import { editorExpression, resolveEditorPath } from "./editor.ts";
import { ApiError } from "./errors.ts";
import { jj, processOutput, run, ProcessError } from "./process.ts";
import {
  parseRevisionRecord,
  revisionFieldsTemplate,
  revisionTemplate,
} from "./revision.ts";
import type { Revision } from "./revision.ts";

import { ServiceTiming, jjTimingName, toolTimingName } from "./timing.ts";
import type { OperationName, TimingObserver } from "./timing.ts";

export type {
  OperationTiming,
  SubprocessTiming,
  TimingObserver,
} from "./timing.ts";
export { ApiError } from "./errors.ts";
export type { Revision } from "./revision.ts";
export interface LogRow {
  /** The graph prefix or connector line emitted by jj, preserved verbatim. */
  graph: string;
  revision?: Revision;
  mutable?: boolean;
  isWorkingCopy?: boolean;
}
export interface RevisionSelection {
  version: string;
  changeId: string;
}
export interface ReviewHunk {
  id: string;
  header: string;
  rows: Row[];
}
export interface ReviewFile {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
  unsupported?: string;
  hunks: ReviewHunk[];
}
export interface State {
  repo: { name: string; path: string };
  version: string;
  source: Revision;
  targets: Revision[];
  parent: Revision | null;
  squashUnavailable?: string;
  files: ReviewFile[];
  operation: string;
  canUndo: boolean;
}
// Revision IDs pin the diff bytes. Repository versions do not depend on
// rendering or transient hunk-tool errors, so graph reads need no diff loading.
type RevisionView = Pick<
  State,
  "source" | "targets" | "parent" | "squashUnavailable"
>;
interface UnavailableView {
  unavailable: {
    changeId: string;
    reason: "missing" | "divergent";
    revisions: Revision[];
  };
}
type ReviewView = RevisionView | UnavailableView;
interface ViewSelection {
  allowUnavailable?: boolean;
  allowConflicts?: boolean;
  changeId?: string;
  requireMutable?: boolean;
}
interface ViewOptions {
  selections?: ViewSelection[];
  allowConflicts?: boolean;
  snapshot?: boolean;
}
export interface Selection {
  id: string;
  lines: number[];
}
export interface SquashLinesInput {
  version: string;
  selections: Selection[];
}
export interface FileContents {
  oldFile: { name: string; contents: string } | null;
  newFile: { name: string; contents: string } | null;
}
export interface PreviewInput {
  version: string;
  target: string;
  selections: Selection[];
}
interface Preview {
  token: string;
  patch: string;
  specs: string[];
  command: string;
  selectedLines: number;
}
interface Plan extends Preview {
  version: string;
  source: Revision;
  target: Revision;
  selections: Selection[];
  expires: number;
}
interface Undo {
  operation: string;
  beforeOperation: string;
  afterVersion: string;
  sourceCommit: string;
  targetCommit: string;
  targetChangeId: string;
}
interface SessionHistory {
  undo?: Undo;
  pending?: {
    beforeOperation: string;
    sourceCommit: string;
    sourceChangeId: string;
    targetCommit: string;
    targetChangeId: string;
    kind: "squash" | "undo";
  };
}
interface Operation {
  id: string;
  parents: string[];
  description: string;
  attributes: string;
}
export interface ServiceOptions {
  repoPath: string;
  revision?: string;
  editorRunner?: typeof run;
  toolRunner?: typeof run;
  jjRunner?: typeof jj;
  onTiming?: TimingObserver;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const reviewLogRevset =
  "trunk() | ((tracked_remote_bookmarks() & ~::trunk())::) | (mutable() & mine())::";

function same(actual: unknown, expected: unknown) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
function squashArgs(specs: string[], source: string, target: string): string[] {
  return [
    "squash",
    ...specs,
    "--from",
    source,
    "--into",
    target,
    "--use-destination-message",
    "--keep-emptied",
  ];
}

function stale(): never {
  throw new ApiError(
    409,
    "STALE_STATE",
    "The repository changed. Refresh the diff and review your selection again; nothing was squashed.",
  );
}

/** All requests, including reads (which snapshot jj), share one serial queue. */
export class ReviewService {
  private queue: Promise<unknown> = Promise.resolve();
  private activePath?: string;
  private history: SessionHistory = {};
  private readonly plans = new Map<string, Plan>();
  // Commit IDs pin both the tree and its parent(s). Never cache mutable revsets,
  // workspace snapshots, operation heads, conflicts, or configuration decisions.
  private readonly fileCache = new Map<string, ReviewFile[]>();
  private readonly jjRunner: typeof jj;
  private readonly repoPath: string;
  private readonly requestedRevision: string;
  private sourceChangeId?: string;
  private initialization?: Promise<void>;
  private readonly editorRunner: typeof run;
  private readonly toolRunner: typeof run;
  private readonly timing?: ServiceTiming;
  constructor(options: ServiceOptions) {
    if (!options?.repoPath)
      throw new Error("ReviewService requires explicit repoPath.");
    this.editorRunner = options.editorRunner ?? run;
    this.toolRunner = options.toolRunner ?? run;
    this.jjRunner = options.jjRunner ?? jj;
    if (options.onTiming) {
      this.timing = new ServiceTiming(options.onTiming);
      this.jjRunner = this.timing.wrap(this.jjRunner, (_cwd, args) =>
        jjTimingName(args),
      );
      this.toolRunner = this.timing.wrap(this.toolRunner, (_command, args) =>
        toolTimingName(args),
      );
      this.editorRunner = this.timing.wrap(this.editorRunner, () => "nvim");
    }
    this.repoPath = path.resolve(options.repoPath);
    this.requestedRevision = options.revision ?? "@";
  }
  private serial<T>(name: OperationName, task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(
      this.timing ? this.timing.task(name, task) : task,
    );
    this.queue = result.catch(() => undefined);
    return result;
  }
  private get root() {
    if (!this.activePath) throw new Error("Repository not initialized");
    return this.activePath;
  }
  private init(snapshot = true): Promise<void> {
    // Memoize even failures: retrying initialization must never reinterpret @ or
    // a moving bookmark after an error.
    return (this.initialization ??= this.initialize(snapshot));
  }
  private async initialize(snapshot: boolean): Promise<void> {
    const root = await realpath(
      (
        await this.jjRunner(this.repoPath, [
          "root",
          ...(snapshot ? [] : ["--ignore-working-copy"]),
        ])
      ).stdout.trim(),
    );
    let requested: Revision[];
    try {
      if (!this.requestedRevision.trim()) throw new Error("Empty revision.");
      requested = await this.revisions(
        this.requestedRevision,
        root,
        snapshot,
        true,
      );
    } catch (error) {
      if (!(error instanceof ProcessError) && this.requestedRevision.trim())
        throw error;
      throw new ApiError(
        400,
        "INVALID_REVISION",
        "The requested revision cannot be resolved. Choose exactly one visible, non-divergent change.",
      );
    }
    if (requested.length !== 1)
      throw new ApiError(
        400,
        "INVALID_REVISION",
        "The requested revision must resolve to exactly one visible, non-divergent change.",
      );
    const source = requested[0];
    // Visibility and divergence were checked in the same jj query that resolved
    // the initial expression. Subsequent reads follow only this change identity
    // and revalidate it live; never re-evaluate a moving @ or bookmark.
    this.sourceChangeId = source.changeId;
    this.activePath = root;
  }
  private changeRevset(changeId: string): string {
    return `change_id(${JSON.stringify(changeId)})`;
  }
  private get sourceRevset(): string {
    if (!this.sourceChangeId) throw new Error("Repository not initialized");
    return this.changeRevset(this.sourceChangeId);
  }
  private requireView(view: ReviewView): RevisionView {
    if ("unavailable" in view) {
      const { changeId, reason, revisions } = view.unavailable;
      throw new ApiError(
        409,
        "SOURCE_UNAVAILABLE",
        reason === "missing"
          ? `Selected change ${changeId} has no visible revision (it may have been abandoned). Explicitly choose another change in the revision graph, or resolve it with jj and refresh. The source was not switched to the working copy.`
          : `Selected change ${changeId} is divergent (${revisions.length} visible revisions). Resolve its divergence with jj and refresh, or explicitly choose another change in the revision graph. The source was not switched to the working copy.`,
        { sourceChangeId: changeId, sourceStatus: reason },
      );
    }
    return view;
  }
  private async operation(): Promise<Operation> {
    const output = (
      await this.jjRunner(this.root, [
        "op",
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "--config",
        "ui.log-word-wrap=false",
        "--limit",
        "1",
        "-T",
        'json(self.id()) ++ "\\t" ++ json(self.parents().map(|op| op.id())) ++ "\\t" ++ json(self.description()) ++ "\\t" ++ json(self.attributes())',
      ])
    ).stdout.trim();
    const [id, parents, description, attributes] = output
      .split("\t")
      .map((value) => JSON.parse(value));
    if (
      typeof id !== "string" ||
      !/^[0-9a-f]{32,128}$/.test(id) ||
      !Array.isArray(parents)
    )
      throw new Error("Cannot read a unique jj operation.");
    return { id, parents, description, attributes };
  }
  private async revisions(
    revset: string,
    root = this.root,
    snapshot = true,
    requireVisible = false,
  ): Promise<Revision[]> {
    const output = (
      await this.jjRunner(root, [
        "log",
        "--no-graph",
        "--config",
        "ui.log-word-wrap=false",
        "-r",
        revset,
        "-T",
        requireVisible
          ? revisionFieldsTemplate +
            ' ++ "\\t" ++ json(hidden) ++ "\\t" ++ json(divergent) ++ "\\n"'
          : revisionTemplate,
        ...(snapshot ? [] : ["--ignore-working-copy"]),
      ])
    ).stdout.trim();
    if (!output) return [];
    return output.split("\n").map((line) => {
      const { revision, flags: visibility } = parseRevisionRecord(
        line,
        requireVisible ? 2 : 0,
        "Unrecognized revision identity.",
        "Unrecognized revision visibility.",
      );
      if (requireVisible && visibility.some(Boolean)) {
        throw new ApiError(
          400,
          "INVALID_REVISION",
          "The requested change is hidden, abandoned, or divergent. Choose exactly one visible, non-divergent change.",
        );
      }
      return revision;
    });
  }
  private async files(
    source: string,
    reconcileHunks = true,
  ): Promise<ReviewFile[]> {
    const key = `${this.root}:${source}`;
    const cached = this.fileCache.get(key);
    if (cached) return structuredClone(cached);
    const diff = (
      await this.jjRunner(this.root, [
        "diff",
        "--git",
        "-r",
        source,
        "--ignore-working-copy",
      ])
    ).stdout;
    const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
    const parsedFiles = new Map<ReviewFile, FileDiff>();
    const files: ReviewFile[] = [];
    for (const patch of sections) {
      const next = /^\+\+\+ b\/(.*)$/m.exec(patch)?.[1];
      const old = /^--- a\/(.*)$/m.exec(patch)?.[1];
      const fallback =
        /^diff --git a\/(.*?) b\/(.*)$/m.exec(patch)?.[2] ?? "Unsupported file";
      const name = next ?? old ?? fallback;
      const file: ReviewFile = {
        path: name,
        patch,
        additions: 0,
        deletions: 0,
        hunks: [],
      };
      try {
        parsedFiles.set(file, parseFile(patch, name));
      } catch (error) {
        file.unsupported =
          error instanceof Error ? error.message : String(error);
      }
      files.push(file);
    }
    // Editor validation only needs pinned diff paths. Never run a hunk tool
    // here: its internal jj reads may snapshot the workspace on a cache miss.
    if (!reconcileHunks) return files;
    // One whole-revision listing, regardless of file count. Reconcile exact
    // paths, ordered hunks and every body row before exposing any selections.
    if (parsedFiles.size) {
      let listing: RevisionListing | undefined;
      let listingError: unknown;
      try {
        listing = parseRevisionListing(
          (
            await this.toolRunner(
              "jj-hunk-tool",
              ["hunks", "-r", source],
              this.root,
            )
          ).stdout,
          files.map((file) => file.path),
        );
      } catch (error) {
        listingError = error;
      }
      for (const [file, parsed] of parsedFiles) {
        try {
          if (!listing) throw listingError;
          const hunks = reconcileListing(parsed, listing);
          file.hunks = parsed.hunks.map((hunk, i) => ({
            ...hunk,
            id: hunks[i].id,
          }));
          const changedRows = parsed.hunks.flatMap((hunk) => hunk.rows);
          for (const row of changedRows) {
            if (row.raw[0] === "+") file.additions++;
            if (row.raw[0] === "-") file.deletions++;
          }
        } catch (error) {
          file.unsupported =
            error instanceof Error ? error.message : String(error);
        }
      }
    }
    const ids = files.flatMap((file) => file.hunks.map((hunk) => hunk.id));
    if (new Set(ids).size !== ids.length)
      throw new Error(
        "Duplicate hunk IDs across files; refusing ambiguous selections.",
      );
    // Do not retain transient tool failures or unsupported interpretations.
    if (files.every((file) => !file.unsupported)) {
      if (this.fileCache.size >= 16)
        this.fileCache.delete(this.fileCache.keys().next().value!);
      this.fileCache.set(key, structuredClone(files));
    }
    return files;
  }
  /** One jj log reads all requested views; graph-only reads never snapshot. */
  private async readViews({
    selections = [{}],
    allowConflicts = false,
    snapshot = true,
  }: ViewOptions = {}): Promise<ReviewView[]> {
    const revsets = selections.map((selection) => {
      const source = selection.changeId
        ? this.changeRevset(selection.changeId)
        : this.sourceRevset;
      return [source, `mutable() & ::${source} ~ ${source}`, `${source}-`];
    });
    const contained = (revset: string) =>
      ` ++ "\\t" ++ json(self.contained_in(${JSON.stringify(revset)}))`;
    const rows = (
      await this.jjRunner(this.root, [
        "log",
        "--no-graph",
        ...(snapshot ? [] : ["--ignore-working-copy"]),
        "--config",
        "ui.log-word-wrap=false",
        "-r",
        revsets
          .flat()
          .map((revset) => `(${revset})`)
          .join(" | "),
        "-T",
        revisionFieldsTemplate +
          revsets.flat().map(contained).join("") +
          ' ++ "\\t" ++ json(self.contained_in("conflicts()"))' +
          ' ++ "\\t" ++ json(self.contained_in("mutable()")) ++ "\\n"',
      ])
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) =>
        parseRevisionRecord(
          line,
          selections.length * 3 + 2,
          "Unrecognized revision metadata.",
        ),
      );
    return selections.map((selection, index) => {
      const metadata = rows.map(({ revision, flags }) => ({
        revision,
        source: flags[index * 3],
        target: flags[index * 3 + 1],
        parent: flags[index * 3 + 2],
        conflict: flags[flags.length - 2],
        mutable: flags[flags.length - 1],
      }));
      const sources = metadata
        .filter((entry) => entry.source)
        .map((entry) => entry.revision);
      if (selection.requireMutable && sources.length !== 1)
        throw new ApiError(
          400,
          "INVALID_REVISION",
          "Choose exactly one visible, non-divergent change.",
        );
      if (sources.length !== 1) {
        const unavailable: UnavailableView = {
          unavailable: {
            changeId: selection.changeId ?? this.sourceChangeId!,
            reason: sources.length ? "divergent" : "missing",
            revisions: sources,
          },
        };
        if (!selection.allowUnavailable) this.requireView(unavailable);
        return unavailable;
      }
      const source = sources[0];
      if (
        !allowConflicts &&
        !selection.allowConflicts &&
        metadata.some((entry) => entry.source && entry.conflict)
      )
        throw new ApiError(
          409,
          "CONFLICTED_SOURCE",
          "The selected revision contains conflicts. Resolve it with jj or select a clean revision before reviewing or squashing.",
        );
      const mutableSource = metadata.filter(
        (entry) => entry.source && entry.mutable,
      );
      if (selection.requireMutable && !mutableSource.length)
        throw new ApiError(
          409,
          "IMMUTABLE_SOURCE",
          "Choose a mutable change. Immutable revisions cannot be selected for squashing.",
        );
      const targets = mutableSource.length
        ? metadata
            .filter((entry) => entry.target && !entry.conflict)
            .map((entry) => entry.revision)
        : [];
      const parents = metadata
        .filter((entry) => entry.parent)
        .map((entry) => entry.revision);
      const parent =
        parents.length === 1
          ? (targets.find(
              (target) => target.commitId === parents[0].commitId,
            ) ?? null)
          : null;
      const squashUnavailable = !mutableSource.length
        ? "The current revision is immutable."
        : parents.length !== 1
          ? "Squashing requires exactly one immediate parent; merges are not supported."
          : metadata.some((entry) => entry.parent && entry.conflict)
            ? "The immediate parent contains conflicts; resolve it with jj before squashing."
            : !parent
              ? "The immediate parent is immutable; squashing into an older ancestor is not allowed."
              : undefined;
      return {
        source,
        targets,
        parent,
        ...(squashUnavailable ? { squashUnavailable } : {}),
      };
    });
  }
  private version(view: ReviewView, operation: string): string {
    return hash(JSON.stringify([this.root, operation, view]));
  }
  private state(
    view: RevisionView,
    operation: string,
    files: ReviewFile[],
  ): State {
    const version = this.version(view, operation);
    return {
      repo: { name: path.basename(this.root), path: this.root },
      ...view,
      files,
      version,
      operation,
      canUndo:
        !this.history.pending &&
        this.history.undo?.operation === operation &&
        this.history.undo.afterVersion === version,
    };
  }
  private async validateViews(
    views: ReviewView[],
    operation: string,
    options: ViewOptions = {},
  ): Promise<void> {
    // Re-evaluate configuration even on diff-cache hits. Graph reads validate
    // recorded history only; other reads also snapshot working-copy edits.
    // Check the operation LAST, so changes during the metadata read are caught.
    const current = await this.readViews(options);
    if ((await this.operation()).id !== operation || !same(current, views))
      stale();
  }
  private async readState(
    allowConflicts = false,
    snapshot = true,
  ): Promise<State> {
    await this.init(snapshot);
    const views = await this.readViews({ allowConflicts, snapshot });
    const view = this.requireView(views[0]);
    // The pinned diff does not depend on the operation query. Overlap these
    // reads, but drain BOTH even on failure before releasing the serial queue.
    // Metadata and the operation head are still rechecked in order below.
    const [operationResult, filesResult] = await Promise.allSettled([
      this.operation(),
      this.files(view.source.commitId, snapshot),
    ]);
    if (operationResult.status === "rejected") throw operationResult.reason;
    if (filesResult.status === "rejected") throw filesResult.reason;
    const operation = operationResult.value;
    const files = filesResult.value;
    await this.validateViews(views, operation.id, { allowConflicts, snapshot });
    return this.state(view, operation.id, files);
  }
  /** Wait for all accepted requests before a graceful service shutdown. */
  async drain(): Promise<void> {
    await this.queue;
  }
  getState(): Promise<State> {
    return this.serial("state", () => this.readState());
  }
  selectRevision(input: RevisionSelection): Promise<{ state: State }> {
    return this.serial("revision", async () => {
      if (
        !input ||
        typeof input.changeId !== "string" ||
        !/^[k-z]{1,64}$/.test(input.changeId) ||
        Object.keys(input).some(
          (key) => key !== "version" && key !== "changeId",
        )
      )
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Supply a change ID and the current state version.",
        );
      await this.init();
      // Resolve both identities and their live eligibility in one snapshot.
      // The candidate is not published until its diff and BOTH views validate.
      const selections = [
        { allowUnavailable: true, allowConflicts: true },
        { changeId: input.changeId, requireMutable: true },
      ];
      const views = await this.readViews({ selections });
      const operation = await this.operation();
      if (
        !input.version ||
        this.version(views[0], operation.id) !== input.version
      )
        stale();
      this.assertNotPending();
      const candidate = this.requireView(views[1]);
      const files = await this.files(candidate.source.commitId);
      await this.validateViews(views, operation.id, { selections });
      const state = this.state(candidate, operation.id, files);
      this.sourceChangeId = state.source.changeId;
      this.plans.clear();
      // Keep the process-local history guard. canUndo is only true when its exact
      // attributed operation AND selected-source state version still match.
      return { state };
    });
  }
  getLog(
    options: { includeOutput?: boolean } = {},
  ): Promise<{ version: string; output: string; rows: LogRow[] }> {
    const name = options.includeOutput === false ? "graph" : "log";
    return this.serial(name, async () => {
      await this.init(false);
      // The graph remains a read-only recovery path when the pinned source is
      // absent, divergent or conflicted. Its version still identifies that old
      // source and its live availability; selection never silently follows @.
      const viewOptions: ViewOptions = {
        snapshot: false,
        selections: [{ allowUnavailable: true, allowConflicts: true }],
      };
      const views = await this.readViews(viewOptions);
      const operation = await this.operation();
      // Bound the graph by relevant history, not an arbitrary entry count.
      // Preserve the configured text template for compatibility callers.
      const output =
        options.includeOutput === false
          ? ""
          : (
              await this.jjRunner(this.root, [
                "log",
                "-r",
                reviewLogRevset,
                "--at-operation",
                operation.id,
              ])
            ).stdout;
      // jj renders every node, branch and connector. Only the metadata after a
      // random delimiter is machine-readable; descriptions never supply graph.
      const marker = `jj-stamp-${randomBytes(16).toString("hex")}:`;
      const template =
        JSON.stringify(marker) +
        " ++ " +
        revisionFieldsTemplate +
        ' ++ "\\t" ++ json(self.contained_in("mutable()"))' +
        ' ++ "\\t" ++ json(current_working_copy) ++ "\\n"';
      const rendered = (
        await this.jjRunner(this.root, [
          "log",
          "--config",
          "ui.log-word-wrap=false",
          "-r",
          `(${reviewLogRevset}) | ${this.sourceRevset} | @`,
          "--at-operation",
          operation.id,
          "-T",
          template,
        ])
      ).stdout;
      const lines = rendered.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const rows = lines.map((line): LogRow => {
        const index = line.indexOf(marker);
        if (index === -1) return { graph: line };
        const { revision, flags } = parseRevisionRecord(
          line.slice(index + marker.length),
          2,
          "Unrecognized revision in jj graph.",
        );
        const [mutable, isWorkingCopy] = flags;
        return {
          graph: line.slice(0, index),
          revision,
          mutable,
          isWorkingCopy,
        };
      });
      await this.validateViews(views, operation.id, viewOptions);
      return { version: this.version(views[0], operation.id), output, rows };
    });
  }
  /** Open workspace bytes, never a temporary historical file or a new editor. */
  openEditor(input: {
    version: string;
    path: string;
    line: number;
  }): Promise<{ ok: true }> {
    return this.serial("editor", async () => {
      if (
        !input ||
        Object.keys(input).some(
          (key) => !["version", "path", "line"].includes(key),
        ) ||
        typeof input.version !== "string" ||
        !/^[0-9a-f]{64}$/.test(input.version) ||
        typeof input.path !== "string" ||
        !input.path.length ||
        input.path.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(input.path) ||
        path.isAbsolute(input.path) ||
        input.path
          .split("/")
          .some((part) => !part || part === "." || part === "..") ||
        !Number.isSafeInteger(input.line) ||
        input.line < 1
      )
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Supply the current version, a repository-relative file path, and a positive integer line.",
        );
      // Unlike diff reads, an editor request must not even snapshot jj edits.
      const before = await this.readState(false, false);
      this.requireVersion(before, input.version);
      const file = before.files.find((file) => file.path === input.path);
      if (!file)
        throw new ApiError(
          400,
          "INVALID_PATH",
          "Choose a file in the current diff.",
        );
      if (/^(?:deleted file mode |\+\+\+ \/dev\/null$)/m.test(file.patch))
        throw new ApiError(
          422,
          "EDITOR_FILE_UNAVAILABLE",
          "Deleted files cannot be opened in the workspace editor.",
        );
      await resolveEditorPath(this.root, input.path);
      await this.revalidateVersion(before.version, false, false);
      const absolute = await resolveEditorPath(this.root, input.path);
      try {
        const result = await this.editorRunner(
          "nvim",
          [
            "--server",
            "127.0.0.1:4242",
            "--remote-expr",
            editorExpression(absolute, input.line),
          ],
          this.root,
        );
        if (result.stdout.trim() !== "1")
          throw new Error(
            result.stderr.trim() ||
              result.stdout.trim() ||
              "Neovim did not confirm opening the file.",
          );
      } catch (error) {
        throw new ApiError(
          503,
          "EDITOR_UNAVAILABLE",
          "Could not open the file in Neovim. Ensure nvim is on PATH and an existing session is listening with nvim --listen 127.0.0.1:4242. " +
            (error instanceof Error ? error.message : String(error)),
        );
      }
      return { ok: true };
    });
  }
  getFile(input: { version: string; path: string }): Promise<FileContents> {
    return this.serial("file", async () => {
      const before = await this.readState();
      this.requireVersion(before, input.version);
      const file = before.files.find((file) => file.path === input.path);
      if (!file)
        throw new ApiError(
          400,
          "INVALID_PATH",
          "Choose a file in the current diff.",
        );
      if (file.unsupported)
        throw new ApiError(422, "UNSUPPORTED_DIFF", file.unsupported);
      const parents = await this.revisions(`${before.source.commitId}-`);
      if (parents.length !== 1)
        throw new ApiError(
          422,
          "UNSUPPORTED_DIFF",
          "File context requires exactly one source parent; merge context is not supported.",
        );
      // A literal root-relative fileset prevents glob or fileset syntax in names
      // from reading additional paths. Both revisions are full pinned commit IDs.
      const read = async (revision: string) => ({
        name: file.path,
        contents: (
          await this.jjRunner(this.root, [
            "file",
            "show",
            "-r",
            revision,
            "--",
            `root-file:${JSON.stringify(file.path)}`,
          ])
        ).stdout,
      });
      const oldFile = /^--- \/dev\/null$/m.test(file.patch)
        ? null
        : await read(parents[0].commitId);
      const newFile = /^\+\+\+ \/dev\/null$/m.test(file.patch)
        ? null
        : await read(before.source.commitId);
      await this.revalidateVersion(before.version);
      return { oldFile, newFile };
    });
  }
  squashLines(
    input: SquashLinesInput,
  ): Promise<{ state: State; output: string; warning?: string }> {
    return this.serial("squash-lines", async () => {
      // Reject target overrides even when called directly rather than via HTTP.
      if (
        Object.keys(input).some(
          (key) => key !== "version" && key !== "selections",
        )
      )
        throw new ApiError(
          400,
          "INVALID_REQUEST",
          "Squash destination is always the immediate parent; no target override is accepted.",
        );
      const state = await this.readState();
      this.requireVersion(state, input.version);
      this.assertNotPending();
      if (!state.parent)
        throw new ApiError(
          409,
          "SQUASH_UNAVAILABLE",
          state.squashUnavailable ?? "No mutable immediate parent.",
        );
      const preview = await this.prepare(state, {
        ...input,
        target: state.parent.changeId,
      });
      // Direct requests never expose a token or yield the serial queue. Validate
      // the exact pinned preview once, then snapshot/recheck before execution.
      await this.revalidateVersion(state.version);
      return this.executeSquash(
        {
          ...preview,
          token: "",
          version: state.version,
          source: state.source,
          target: state.parent,
          selections: structuredClone(input.selections),
          expires: Date.now(),
        },
        state,
      );
    });
  }
  private requireVersion(state: State, version: string): void {
    if (!version || version !== state.version) stale();
  }
  private async revalidateVersion(
    version: string,
    allowConflicts = false,
    snapshot = true,
  ): Promise<State> {
    const state = await this.readState(allowConflicts, snapshot);
    this.requireVersion(state, version);
    return state;
  }
  private pendingError(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
  ): ApiError {
    const pending = this.history.pending;
    if (!pending) return new ApiError(status, code, message, details);
    const recoveryAction =
      "Inspect jj op log --no-pager and reconcile history before restarting. Restarting forgets this in-memory guard and undo state; it does not repair, undo, or retry repository operations. Do not blindly repeat the squash.";
    return new ApiError(
      status,
      code,
      `${message} Pending ${pending.kind}; before operation: ${pending.beforeOperation}; source commit: ${pending.sourceCommit}; source change: ${pending.sourceChangeId}; target commit: ${pending.targetCommit}; target change: ${pending.targetChangeId}. ${recoveryAction}`,
      {
        ...details,
        pending: structuredClone(pending),
        recoveryAction,
      },
    );
  }
  private assertNotPending() {
    if (this.history.pending)
      throw this.pendingError(
        409,
        "RECOVERY_REQUIRED",
        "A previous history operation did not finish cleanly. No automatic retry or rollback was attempted.",
      );
  }
  private async prepare(
    state: State,
    input: PreviewInput,
  ): Promise<Omit<Preview, "token">> {
    this.requireVersion(state, input.version);
    this.assertNotPending();
    const target = state.targets.find((rev) => rev.changeId === input.target);
    if (!target)
      throw new ApiError(
        400,
        "INVALID_TARGET",
        "Choose a conflict-free mutable ancestor of the current revision.",
      );
    if (
      !Array.isArray(input.selections) ||
      !input.selections.length ||
      input.selections.length > 2000
    )
      throw new ApiError(
        400,
        "INVALID_SELECTION",
        "Select at least one changed line.",
      );
    const byId = new Map<string, number[]>();
    for (const selection of input.selections) {
      if (
        !selection ||
        typeof selection.id !== "string" ||
        byId.has(selection.id) ||
        !Array.isArray(selection.lines) ||
        !selection.lines.length ||
        selection.lines.length > 100000 ||
        selection.lines.some((n) => !Number.isSafeInteger(n) || n < 1) ||
        new Set(selection.lines).size !== selection.lines.length
      ) {
        throw new ApiError(
          400,
          "INVALID_SELECTION",
          "Selections must contain unique hunks and unique, positive patch-body line indices.",
        );
      }
      byId.set(
        selection.id,
        [...selection.lines].sort((a, b) => a - b),
      );
    }
    const picked: Array<{
      patch: string;
      path: string;
      hunk: Hunk;
      lines: number[];
    }> = [];
    const specs: string[] = [];
    let selectedLines = 0;
    for (const file of state.files)
      for (const hunk of file.hunks) {
        const lines = byId.get(hunk.id);
        if (!lines) continue;
        if (file.unsupported)
          throw new ApiError(422, "UNSUPPORTED_DIFF", file.unsupported);
        const changed = hunk.rows.filter((row) => /^[+-]/.test(row.raw));
        const changedIndices = new Set(changed.map((row) => row.index));
        if (lines.some((index) => !changedIndices.has(index)))
          throw new ApiError(
            400,
            "INVALID_SELECTION",
            "Only changed (+/−) rows can be selected; context lines and source line numbers are not valid selections.",
          );
        picked.push({ patch: file.patch, path: file.path, hunk, lines });
        specs.push(
          lines.length === changed.length
            ? hunk.id
            : `${hunk.id}:${ranges(lines)}`,
        );
        selectedLines += lines.length;
        byId.delete(hunk.id);
      }
    if (byId.size || !specs.length)
      throw new ApiError(
        400,
        "INVALID_SELECTION",
        "The selected hunk does not exist in this diff.",
      );
    const patch = (
      await this.toolRunner(
        "jj-hunk-tool",
        ["patch", ...specs, "-r", state.source.commitId],
        this.root,
      )
    ).stdout;
    try {
      assertExactPreview(patch, picked);
    } catch (error) {
      throw new ApiError(422, "UNSAFE_PREVIEW", (error as Error).message);
    }
    const args = squashArgs(specs, state.source.commitId, target.commitId);
    return {
      patch,
      specs,
      command: ["jj-hunk-tool", ...args].join(" "),
      selectedLines,
    };
  }
  preview(input: PreviewInput): Promise<Preview> {
    return this.serial("preview", async () =>
      this.previewInternal(input, await this.readState()),
    );
  }
  private async previewInternal(
    input: PreviewInput,
    state: State,
  ): Promise<Preview> {
    const preview = await this.prepare(state, input);
    await this.revalidateVersion(state.version);
    const token = randomBytes(32).toString("hex");
    for (const [key, plan] of this.plans)
      if (plan.expires < Date.now()) this.plans.delete(key);
    if (this.plans.size >= 100)
      this.plans.delete(this.plans.keys().next().value!);
    this.plans.set(token, {
      ...preview,
      token,
      version: state.version,
      source: state.source,
      target: state.targets.find((t) => t.changeId === input.target)!,
      selections: structuredClone(input.selections),
      expires: Date.now() + 10 * 60_000,
    });
    return { ...preview, token };
  }
  squash(
    token: string,
  ): Promise<{ state: State; output: string; warning?: string }> {
    return this.serial("squash", () => this.squashInternal(token));
  }
  private async squashInternal(
    token: string,
  ): Promise<{ state: State; output: string; warning?: string }> {
    const plan = this.plans.get(token);
    this.plans.delete(token); // One shot, even on an ambiguous failure. Never retry a rewrite.
    if (!plan || plan.expires < Date.now())
      throw new ApiError(
        409,
        "STALE_PREVIEW",
        "This preview expired or was already used. Refresh and preview your selection again.",
      );
    const before = await this.readState();
    this.requireVersion(before, plan.version);
    const check = await this.prepare(before, {
      version: plan.version,
      target: plan.target.changeId,
      selections: plan.selections,
    });
    if (
      !same(check.specs, plan.specs) ||
      check.patch !== plan.patch ||
      check.command !== plan.command
    )
      stale();
    await this.revalidateVersion(before.version);
    return this.executeSquash(plan, before);
  }
  private async executeSquash(
    plan: Plan,
    before: State,
  ): Promise<{ state: State; output: string; warning?: string }> {
    // Compare change identities: rebasing an existing conflict changes its
    // commit ID, but does not mean this squash introduced that conflict.
    const existingConflicts = new Set(
      (await this.revisions("conflicts()")).map(
        (revision) => revision.changeId,
      ),
    );
    if ((await this.operation()).id !== before.operation) stale();
    this.history = {
      pending: {
        beforeOperation: before.operation,
        sourceCommit: plan.source.commitId,
        sourceChangeId: plan.source.changeId,
        targetCommit: plan.target.commitId,
        targetChangeId: plan.target.changeId,
        kind: "squash",
      },
    };
    this.plans.clear();
    let result;
    try {
      result = await this.toolRunner(
        "jj-hunk-tool",
        squashArgs(plan.specs, plan.source.commitId, plan.target.commitId),
        this.root,
      );
    } catch (error) {
      return this.failedMutation(error, before.operation);
    }
    let afterOp: Operation;
    try {
      afterOp = await this.operation();
    } catch (error) {
      throw this.pendingError(
        409,
        "HISTORY_CHANGED",
        "The tool completed, but its operation could not be attributed. Automatic undo is disabled; do not retry the squash.",
        { output: processOutput(result), cause: String(error) },
      );
    }
    if (
      !this.isSquashOperation(
        afterOp,
        before.operation,
        plan.source.commitId,
        plan.target.commitId,
      )
    ) {
      throw this.pendingError(
        409,
        "HISTORY_CHANGED",
        "The tool completed, but operation history changed unexpectedly. Automatic undo is disabled; do not retry the squash.",
        { output: processOutput(result), currentOperation: afterOp.id },
      );
    }
    // Positive, live attribution ends mutation uncertainty. Clear only this
    // process's guard before reads that can snapshot or fail. No history scan,
    // replay, rollback, or disk bookkeeping is involved.
    this.history = {};
    let after: State;
    let warning: string | undefined;
    try {
      // Include warning reads in the post-success boundary, before publishing
      // undo. The final state validation must cover every repository read.
      if (
        (await this.revisions("conflicts()", this.root, false)).some(
          (revision) => !existingConflicts.has(revision.changeId),
        )
      )
        warning =
          "The squash created a conflict. Undo this operation or resolve the affected revision with jj before editing it.";
      after = await this.readState(true);
      if (after.operation !== afterOp.id)
        throw new Error("Another operation followed the squash.");
    } catch (error) {
      throw new ApiError(
        409,
        "HISTORY_CHANGED",
        "The squash completed and was attributed, but the repository changed or its updated view could not be validated. Automatic undo is disabled. Inspect jj op log and refresh before reviewing more work; do not retry the completed squash. No retry or rollback was attempted.",
        {
          output: processOutput(result),
          completedOperation: afterOp.id,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    this.history = {
      undo: {
        operation: afterOp.id,
        beforeOperation: before.operation,
        afterVersion: after.version,
        sourceCommit: plan.source.commitId,
        targetCommit: plan.target.commitId,
        targetChangeId: plan.target.changeId,
      },
    };
    after.canUndo = true;
    return {
      state: after,
      output: processOutput(result).trim(),
      ...(warning ? { warning } : {}),
    };
  }
  private isSquashOperation(
    operation: Operation,
    parent: string,
    source: string,
    target: string,
  ): boolean {
    return (
      same(operation.parents, [parent]) &&
      operation.description === `squash commits into ${target}` &&
      operation.attributes.includes(`--from ${source} --into ${target} `) &&
      operation.attributes.includes("--tool jj-hunk-tool")
    );
  }
  private async failedMutation(
    error: unknown,
    beforeOperation: string,
  ): Promise<never> {
    let current: string | undefined;
    try {
      current = (await this.operation()).id;
    } catch {
      /* Remain fail-closed. */
    }
    if (current === beforeOperation) {
      this.history = {};
    }
    const output =
      error instanceof ProcessError
        ? processOutput(error.result)
        : String(error);
    const dependencyHint = /failed to run patch/.test(output)
      ? "jj-hunk-tool could not start its required patch executable. Install GNU patch or repair the packaged runtime. "
      : "";
    throw this.pendingError(
      500,
      current === beforeOperation ? "TOOL_FAILED" : "PARTIAL_FAILURE",
      dependencyHint +
        (current === beforeOperation
          ? "The tool failed without a recorded history change. Nothing was automatically retried. Refresh before trying again."
          : "The tool failed and history may have changed. Inspect jj op log before doing anything else. No retry or rollback was attempted."),
      { output, ...(current ? { currentOperation: current } : {}) },
    );
  }
  undo(version: string): Promise<{ state: State; output: string }> {
    return this.serial("undo", async () => {
      const state = await this.readState(true);
      this.requireVersion(state, version);
      this.assertNotPending();
      const undo = this.history.undo;
      if (!state.canUndo || !undo)
        throw new ApiError(
          409,
          "UNDO_UNAVAILABLE",
          "Undo is only available for the last app squash while the repository is unchanged.",
        );
      const operation = await this.operation();
      if (
        operation.id !== undo.operation ||
        !this.isSquashOperation(
          operation,
          undo.beforeOperation,
          undo.sourceCommit,
          undo.targetCommit,
        )
      )
        stale();
      await this.jjRunner(this.root, ["status"]);
      if ((await this.operation()).id !== undo.operation) stale();
      this.history = {
        pending: {
          beforeOperation: undo.operation,
          sourceCommit: undo.sourceCommit,
          sourceChangeId: state.source.changeId,
          targetCommit: undo.targetCommit,
          targetChangeId: undo.targetChangeId,
          kind: "undo",
        },
      };
      this.plans.clear();
      let result;
      try {
        result = await this.jjRunner(this.root, [
          "op",
          "revert",
          undo.operation,
        ]);
      } catch (error) {
        return this.failedMutation(error, undo.operation);
      }
      const after = await this.operation();
      if (!same(after.parents, [undo.operation]))
        throw this.pendingError(
          409,
          "HISTORY_CHANGED",
          "History changed during undo. No further action was attempted.",
          { currentOperation: after.id },
        );
      this.history = {};
      return {
        state: await this.readState(),
        output: processOutput(result).trim(),
      };
    });
  }
}
