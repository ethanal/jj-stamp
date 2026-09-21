import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  parseFile,
  parseRevisionListing,
  reconcileListing,
  ranges,
  assertExactPreview,
} from "./diff.ts";
import type { FileDiff, Hunk, Row, RevisionListing } from "./diff.ts";
import { jj, run, ProcessError } from "./process.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export interface Revision {
  changeId: string;
  commitId: string;
  description: string;
  author?: string;
  /** jj's shortest distinguishing prefix, not an arbitrary fixed truncation. */
  changeIdPrefix?: string;
}
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
interface Active {
  path: string;
}
interface Undo {
  operation: string;
  beforeOperation: string;
  afterVersion: string;
  sourceCommit: string;
  targetCommit: string;
}
interface Journal {
  undo?: Undo;
  pending?: {
    beforeOperation: string;
    sourceCommit: string;
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
  dataDir: string;
  repoPath: string;
  revision?: string;
  editorRunner?: typeof run;
  toolRunner?: typeof run;
  jjRunner?: typeof jj;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const reviewLogRevset =
  "trunk() | ((tracked_remote_bookmarks() & ~::trunk())::) | (mutable() & mine())::";
const revisionTemplate =
  'json(change_id) ++ "\\t" ++ json(commit_id) ++ "\\t" ++ json(description.first_line()) ++ "\\t" ++ json(author.name()) ++ "\\t" ++ json(change_id.shortest(8).prefix()) ++ "\\n"';

async function readJSON<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function atomicJSON(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, file);
}
function same(actual: unknown, expected: unknown) {
  return JSON.stringify(actual) === JSON.stringify(expected);
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
  private active?: Active;
  private journal: Journal = {};
  private plans = new Map<string, Plan>();
  // Commit IDs pin both the tree and its parent(s). Never cache mutable revsets,
  // workspace snapshots, operation heads, conflicts, or configuration decisions.
  private fileCache = new Map<string, ReviewFile[]>();
  private jjRunner: typeof jj;
  readonly dataDir: string;
  private readonly repoPath: string;
  private readonly requestedRevision: string;
  private sourceChangeId?: string;
  private initialization?: Promise<void>;
  private editorRunner: typeof run;
  private toolRunner: typeof run;
  constructor(options: ServiceOptions) {
    if (!options?.repoPath || !options?.dataDir)
      throw new Error("ReviewService requires explicit repoPath and dataDir.");
    this.editorRunner = options.editorRunner ?? run;
    this.toolRunner = options.toolRunner ?? run;
    this.jjRunner = options.jjRunner ?? jj;
    this.dataDir = path.resolve(options.dataDir);
    this.repoPath = path.resolve(options.repoPath);
    this.requestedRevision = options.revision ?? "@";
  }
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private get root() {
    if (!this.active) throw new Error("Repository not initialized");
    return this.active.path;
  }
  private get journalPath() {
    return path.join(
      this.dataDir,
      `operations-${hash(this.root).slice(0, 20)}.json`,
    );
  }
  private saveJournal() {
    return atomicJSON(this.journalPath, this.journal);
  }
  private init(snapshot = true): Promise<void> {
    // Memoize even failures: retrying initialization must never reinterpret @ or
    // a moving bookmark after an error (including a corrupt recovery journal).
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
    await mkdir(this.dataDir, { recursive: true });
    const journal =
      (await readJSON<Journal>(
        path.join(this.dataDir, `operations-${hash(root).slice(0, 20)}.json`),
      )) ?? {};
    // Publish initialized state only after the durable recovery guard was read.
    this.journal = journal;
    this.sourceChangeId = source.changeId;
    this.active = { path: root };
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
          ? revisionTemplate.replace(
              ' ++ "\\n"',
              ' ++ "\\t" ++ json(hidden) ++ "\\t" ++ json(divergent) ++ "\\n"',
            )
          : revisionTemplate,
        ...(snapshot ? [] : ["--ignore-working-copy"]),
      ])
    ).stdout.trim();
    if (!output) return [];
    return output.split("\n").map((line) => {
      const [
        changeId,
        commitId,
        description,
        author,
        changeIdPrefix,
        ...visibility
      ] = line.split("\t").map((value) => JSON.parse(value));
      if (
        !/^[k-z]+$/.test(changeId) ||
        !/^[0-9a-f]{40,64}$/.test(commitId) ||
        typeof description !== "string" ||
        typeof author !== "string" ||
        typeof changeIdPrefix !== "string" ||
        !changeIdPrefix ||
        !changeId.startsWith(changeIdPrefix)
      )
        throw new Error("Unrecognized revision identity.");
      if (requireVisible) {
        if (
          visibility.length !== 2 ||
          visibility.some((value) => typeof value !== "boolean")
        )
          throw new Error("Unrecognized revision visibility.");
        if (visibility.some(Boolean))
          throw new ApiError(
            400,
            "INVALID_REVISION",
            "The requested change is hidden, abandoned, or divergent. Choose exactly one visible, non-divergent change.",
          );
      }
      return { changeId, commitId, description, author, changeIdPrefix };
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
          file.additions = parsed.hunks
            .flatMap((hunk) => hunk.rows)
            .filter((row) => row.raw[0] === "+").length;
          file.deletions = parsed.hunks
            .flatMap((hunk) => hunk.rows)
            .filter((row) => row.raw[0] === "-").length;
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
        revisionTemplate.replace(' ++ "\\n"', "") +
          revsets.flat().map(contained).join("") +
          ' ++ "\\t" ++ json(self.contained_in("conflicts()"))' +
          ' ++ "\\t" ++ json(self.contained_in("mutable()")) ++ "\\n"',
      ])
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [
          changeId,
          commitId,
          description,
          author,
          changeIdPrefix,
          ...flags
        ] = line.split("\t").map((value) => JSON.parse(value));
        if (
          !/^[k-z]+$/.test(changeId) ||
          !/^[0-9a-f]{40,64}$/.test(commitId) ||
          typeof description !== "string" ||
          typeof author !== "string" ||
          typeof changeIdPrefix !== "string" ||
          !changeIdPrefix ||
          !changeId.startsWith(changeIdPrefix) ||
          flags.length !== selections.length * 3 + 2 ||
          flags.some((flag) => typeof flag !== "boolean")
        )
          throw new Error("Unrecognized revision metadata.");
        return {
          revision: {
            changeId,
            commitId,
            description,
            author,
            changeIdPrefix,
          } as Revision,
          flags,
        };
      });
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
        !this.journal.pending &&
        this.journal.undo?.operation === operation &&
        this.journal.undo.afterVersion === version,
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
    return this.serial(() => this.readState());
  }
  selectRevision(input: RevisionSelection): Promise<{ state: State }> {
    return this.serial(async () => {
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
      // Keep the repository-scoped journal. canUndo is only true when its exact
      // attributed operation AND selected-source state version still match.
      return { state };
    });
  }
  getLog(
    options: { includeOutput?: boolean } = {},
  ): Promise<{ version: string; output: string; rows: LogRow[] }> {
    return this.serial(async () => {
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
        revisionTemplate.replace(' ++ "\\n"', "") +
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
        const [
          changeId,
          commitId,
          description,
          author,
          changeIdPrefix,
          mutable,
          isWorkingCopy,
        ] = line
          .slice(index + marker.length)
          .split("\t")
          .map((value) => JSON.parse(value));
        if (
          !/^[k-z]+$/.test(changeId) ||
          !/^[0-9a-f]{40,64}$/.test(commitId) ||
          typeof description !== "string" ||
          typeof author !== "string" ||
          typeof changeIdPrefix !== "string" ||
          !changeIdPrefix ||
          !changeId.startsWith(changeIdPrefix) ||
          typeof mutable !== "boolean" ||
          typeof isWorkingCopy !== "boolean"
        )
          throw new Error("Unrecognized revision in jj graph.");
        return {
          graph: line.slice(0, index),
          revision: { changeId, commitId, description, author, changeIdPrefix },
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
    return this.serial(async () => {
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
      await this.editorPath(input.path);
      this.requireVersion(await this.readState(false, false), before.version);
      const absolute = await this.editorPath(input.path);
      // Only data enters the expression: Vim single-quoted strings escape an
      // apostrophe by doubling it; backslashes are literal. Never use :edit,
      // --remote-send, shell interpolation, or filename/key expansion.
      const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
      const lua =
        "(function(a) local b = vim.fn.bufadd(a[1]); vim.fn.bufload(b); vim.bo[b].buflisted = true; vim.api.nvim_set_current_buf(b); vim.api.nvim_win_set_cursor(0, {math.min(a[2], vim.api.nvim_buf_line_count(b)), 0}); return 1 end)(_A)";
      try {
        const result = await this.editorRunner(
          "nvim",
          [
            "--server",
            "127.0.0.1:4242",
            "--remote-expr",
            `luaeval(${literal(lua)}, [${literal(absolute)}, ${input.line}])`,
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
  private async editorPath(relative: string): Promise<string> {
    const absolute = path.resolve(this.root, relative);
    const contained = path.relative(this.root, absolute);
    if (
      !contained ||
      contained === ".." ||
      contained.startsWith(`..${path.sep}`) ||
      path.isAbsolute(contained)
    )
      throw new ApiError(
        400,
        "INVALID_PATH",
        "The editor file must be inside the workspace.",
      );
    try {
      // Reject all symlinks, including directory links and links back inside the
      // workspace. The editor must open this exact regular workspace file.
      if ((await realpath(this.root)) !== this.root)
        throw new ApiError(
          422,
          "EDITOR_FILE_UNAVAILABLE",
          "The workspace path is now a symlink; restart jj-stamp.",
        );
      let current = this.root;
      for (const part of contained.split(path.sep)) {
        current = path.join(current, part);
        const entry = await lstat(current);
        if (
          entry.isSymbolicLink() ||
          (current === absolute ? !entry.isFile() : !entry.isDirectory())
        )
          throw new ApiError(
            422,
            "EDITOR_FILE_UNAVAILABLE",
            "The editor requires a regular workspace file without symlinks.",
          );
      }
      if ((await realpath(absolute)) !== absolute)
        throw new ApiError(
          422,
          "EDITOR_FILE_UNAVAILABLE",
          "The editor file resolves outside its workspace path.",
        );
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(
        422,
        "EDITOR_FILE_UNAVAILABLE",
        "The file is missing or inaccessible in the current workspace; historical files cannot be opened.",
      );
    }
    return absolute;
  }
  getFile(input: { version: string; path: string }): Promise<FileContents> {
    return this.serial(async () => {
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
      this.requireVersion(await this.readState(), before.version);
      return { oldFile, newFile };
    });
  }
  squashLines(
    input: SquashLinesInput,
  ): Promise<{ state: State; output: string; warning?: string }> {
    return this.serial(async () => {
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
      // the exact pinned preview once, then snapshot/recheck before journaling.
      this.requireVersion(await this.readState(), state.version);
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
  private requireVersion(state: State, version: string) {
    if (!version || version !== state.version) stale();
  }
  private assertNotPending() {
    if (this.journal.pending)
      throw new ApiError(
        409,
        "RECOVERY_REQUIRED",
        "A previous history operation did not finish cleanly. Inspect jj op log before doing more work. No automatic retry or rollback was attempted.",
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
        if (lines.some((index) => !changed.some((row) => row.index === index)))
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
    const args = [
      "squash",
      ...specs,
      "--from",
      state.source.commitId,
      "--into",
      target.commitId,
      "--use-destination-message",
      "--keep-emptied",
    ];
    return {
      patch,
      specs,
      command: ["jj-hunk-tool", ...args].join(" "),
      selectedLines,
    };
  }
  preview(input: PreviewInput): Promise<Preview> {
    return this.serial(async () =>
      this.previewInternal(input, await this.readState()),
    );
  }
  private async previewInternal(
    input: PreviewInput,
    state: State,
  ): Promise<Preview> {
    const preview = await this.prepare(state, input);
    this.requireVersion(await this.readState(), state.version);
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
    return this.serial(() => this.squashInternal(token));
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
    this.requireVersion(await this.readState(), before.version);
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
    this.journal = {
      pending: {
        beforeOperation: before.operation,
        sourceCommit: plan.source.commitId,
        kind: "squash",
      },
    };
    await this.saveJournal();
    this.plans.clear();
    let result;
    try {
      result = await this.toolRunner(
        "jj-hunk-tool",
        [
          "squash",
          ...plan.specs,
          "--from",
          plan.source.commitId,
          "--into",
          plan.target.commitId,
          "--use-destination-message",
          "--keep-emptied",
        ],
        this.root,
      );
    } catch (error) {
      return this.failedMutation(error, before.operation);
    }
    const afterOp = await this.operation();
    if (
      !this.isSquashOperation(
        afterOp,
        before.operation,
        plan.source.commitId,
        plan.target.commitId,
      )
    ) {
      throw new ApiError(
        409,
        "HISTORY_CHANGED",
        "The tool completed, but operation history changed unexpectedly. Inspect jj op log. Automatic undo is disabled; do not retry the squash.",
        { output: result.stdout + result.stderr },
      );
    }
    const after = await this.readState(true);
    if (after.operation !== afterOp.id)
      throw new ApiError(
        409,
        "HISTORY_CHANGED",
        "Another operation followed the squash. Inspect jj op log; automatic undo is disabled.",
      );
    this.journal = {
      undo: {
        operation: afterOp.id,
        beforeOperation: before.operation,
        afterVersion: after.version,
        sourceCommit: plan.source.commitId,
        targetCommit: plan.target.commitId,
      },
    };
    await this.saveJournal();
    after.canUndo = true;
    let warning: string | undefined;
    if (
      (await this.revisions("conflicts()")).some(
        (revision) => !existingConflicts.has(revision.changeId),
      )
    )
      warning =
        "The squash created a conflict. Undo this operation or resolve the affected revision with jj before editing it.";
    return {
      state: after,
      output: (result.stdout + result.stderr).trim(),
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
      this.journal = {};
      await this.saveJournal();
    }
    const output =
      error instanceof ProcessError
        ? error.result.stdout + error.result.stderr
        : String(error);
    const dependencyHint = /failed to run patch/.test(output)
      ? "jj-hunk-tool could not start its required patch executable. Install GNU patch or repair the packaged runtime. "
      : "";
    throw new ApiError(
      500,
      current === beforeOperation ? "TOOL_FAILED" : "PARTIAL_FAILURE",
      dependencyHint +
        (current === beforeOperation
          ? "The tool failed without a recorded history change. Nothing was automatically retried. Refresh before trying again."
          : "The tool failed and history may have changed. Inspect jj op log before doing anything else. No retry or rollback was attempted."),
      { output },
    );
  }
  undo(version: string): Promise<{ state: State; output: string }> {
    return this.serial(async () => {
      const state = await this.readState(true);
      this.requireVersion(state, version);
      this.assertNotPending();
      const undo = this.journal.undo;
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
      this.journal = {
        pending: {
          beforeOperation: undo.operation,
          sourceCommit: undo.sourceCommit,
          kind: "undo",
        },
      };
      await this.saveJournal();
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
        throw new ApiError(
          409,
          "HISTORY_CHANGED",
          "History changed during undo. Inspect jj op log; no further action was attempted.",
        );
      this.journal = {};
      await this.saveJournal();
      return {
        state: await this.readState(),
        output: (result.stdout + result.stderr).trim(),
      };
    });
  }
}
