import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFile, parseListing, ranges, assertExactPreview } from "./diff.ts";
import type { Hunk, Row } from "./diff.ts";
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
  toolRunner?: typeof run;
  jjRunner?: typeof jj;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const revisionTemplate =
  'json(change_id) ++ "\\t" ++ json(commit_id) ++ "\\t" ++ json(description.first_line()) ++ "\\n"';

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
  private toolRunner: typeof run;
  constructor(options: ServiceOptions) {
    if (!options?.repoPath || !options?.dataDir)
      throw new Error("ReviewService requires explicit repoPath and dataDir.");
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
  private init(): Promise<void> {
    // Memoize even failures: retrying initialization must never reinterpret @ or
    // a moving bookmark after an error (including a corrupt recovery journal).
    return (this.initialization ??= this.initialize());
  }
  private async initialize(): Promise<void> {
    const root = await realpath(
      (await this.jjRunner(this.repoPath, ["root"])).stdout.trim(),
    );
    let requested: Revision[];
    try {
      if (!this.requestedRevision.trim()) throw new Error("Empty revision.");
      requested = await this.revisions(this.requestedRevision, root);
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
    // Resolve by change identity, not a symbol that a bookmark could shadow.
    // Also reject a hidden commit or one explicitly selected side of divergence.
    const visible = await this.revisions(
      this.changeRevset(source.changeId),
      root,
    );
    if (visible.length !== 1 || visible[0].commitId !== source.commitId)
      throw new ApiError(
        400,
        "INVALID_REVISION",
        "The requested change is hidden, abandoned, divergent, or changed during initialization.",
      );
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
  private requireSource(sources: Revision[]): Revision {
    if (sources.length !== 1)
      throw new ApiError(
        409,
        "SOURCE_UNAVAILABLE",
        "The selected change is abandoned or divergent. Resolve it with jj or start a new review; the source was not switched to the working copy.",
      );
    return sources[0];
  }
  private async operation(): Promise<Operation> {
    const output = (
      await this.jjRunner(this.root, [
        "op",
        "log",
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
        revisionTemplate,
      ])
    ).stdout.trim();
    if (!output) return [];
    return output.split("\n").map((line) => {
      const [changeId, commitId, description] = line
        .split("\t")
        .map((value) => JSON.parse(value));
      if (!/^[k-z]+$/.test(changeId) || !/^[0-9a-f]{40,64}$/.test(commitId))
        throw new Error("Unrecognized revision identity.");
      return { changeId, commitId, description };
    });
  }
  private async files(source: string): Promise<ReviewFile[]> {
    const key = `${this.root}:${source}`;
    const cached = this.fileCache.get(key);
    if (cached) return structuredClone(cached);
    const diff = (
      await this.jjRunner(this.root, ["diff", "--git", "-r", source])
    ).stdout;
    const sections = diff.split(/(?=^diff --git )/m).filter(Boolean);
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
        const parsed = parseFile(patch, name);
        const listing = parseListing(
          (
            await this.toolRunner(
              "jj-hunk-tool",
              ["hunks", "-r", source, "--file", name],
              this.root,
            )
          ).stdout,
          name,
        );
        if (
          listing.length !== parsed.hunks.length ||
          listing.some(
            (h, i) =>
              !same(
                h.rows,
                parsed.hunks[i].rows.map((r) => r.raw),
              ),
          )
        ) {
          throw new Error(
            "Tool hunks disagree with the source diff. This file cannot be safely selected.",
          );
        }
        file.hunks = parsed.hunks.map((hunk, i) => ({
          ...hunk,
          id: listing[i].id,
        }));
        file.additions = parsed.hunks
          .flatMap((h) => h.rows)
          .filter((r) => r.raw[0] === "+").length;
        file.deletions = parsed.hunks
          .flatMap((h) => h.rows)
          .filter((r) => r.raw[0] === "-").length;
      } catch (error) {
        file.unsupported =
          error instanceof Error ? error.message : String(error);
      }
      files.push(file);
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
  private async readState(
    allowConflicts = false,
    selection: { changeId?: string; requireMutable?: boolean } = {},
  ): Promise<State> {
    await this.init();
    await this.jjRunner(this.root, ["status"]); // Snapshot BEFORE acquiring the operation token.
    const operation = await this.operation();
    // One live revset evaluation replaces five separate jj processes. Evaluate
    // these even on a diff-cache hit: config-only immutable-head changes do not
    // necessarily create a repository operation.
    const sourceRevset = selection.changeId
      ? this.changeRevset(selection.changeId)
      : this.sourceRevset;
    const targetRevset = `mutable() & ::${sourceRevset} ~ ${sourceRevset}`;
    const parentRevset = `${sourceRevset}-`;
    const contained = (revset: string) =>
      ` ++ "\\t" ++ json(self.contained_in(${JSON.stringify(revset)}))`;
    const metadata = (
      await this.jjRunner(this.root, [
        "log",
        "--no-graph",
        "--config",
        "ui.log-word-wrap=false",
        "-r",
        `${sourceRevset} | (${targetRevset}) | ${parentRevset}`,
        "-T",
        revisionTemplate.replace(' ++ "\\n"', "") +
          contained(sourceRevset) +
          contained(targetRevset) +
          contained(parentRevset) +
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
          source,
          target,
          parent,
          conflict,
          mutable,
        ] = line.split("\t").map((value) => JSON.parse(value));
        if (!/^[k-z]+$/.test(changeId) || !/^[0-9a-f]{40,64}$/.test(commitId))
          throw new Error("Unrecognized revision identity.");
        return {
          revision: { changeId, commitId, description } as Revision,
          source,
          target,
          parent,
          conflict,
          mutable,
        };
      });
    const sources = metadata
      .filter((entry) => entry.source)
      .map((entry) => entry.revision);
    const source = this.requireSource(sources);
    if (
      !allowConflicts &&
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
        ? (targets.find((target) => target.commitId === parents[0].commitId) ??
          null)
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
    const files = await this.files(source.commitId);
    await this.jjRunner(this.root, ["status"]);
    if (
      (await this.operation()).id !== operation.id ||
      !same(this.requireSource(await this.revisions(sourceRevset)), source)
    )
      stale();
    const version = hash(
      JSON.stringify([
        this.root,
        operation.id,
        source,
        targets,
        parent,
        squashUnavailable,
        files,
      ]),
    );
    const canUndo =
      !this.journal.pending &&
      this.journal.undo?.operation === operation.id &&
      this.journal.undo.afterVersion === version;
    return {
      repo: {
        name: path.basename(this.root),
        path: this.root,
      },
      source,
      targets,
      parent,
      ...(squashUnavailable ? { squashUnavailable } : {}),
      files,
      version,
      operation: operation.id,
      canUndo,
    };
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
      const before = await this.readState();
      this.requireVersion(before, input.version);
      this.assertNotPending();
      // Unlike the CLI's initial expression, API input is an identity/prefix,
      // never an arbitrary revset or a bookmark that could shadow a change ID.
      const choices = await this.revisions(this.changeRevset(input.changeId));
      if (choices.length !== 1)
        throw new ApiError(
          400,
          "INVALID_REVISION",
          "Choose exactly one visible, non-divergent change.",
        );
      // Read and validate the candidate without publishing it: invalid,
      // immutable, conflicted, or stale choices must not poison this session.
      const state = await this.readState(false, {
        changeId: choices[0].changeId,
        requireMutable: true,
      });
      this.requireVersion(await this.readState(), before.version);
      if (state.operation !== before.operation) stale();
      // A configuration-only immutability change on an unrelated candidate
      // might not affect the old source's version. Recheck the candidate too.
      this.requireVersion(
        await this.readState(false, {
          changeId: state.source.changeId,
          requireMutable: true,
        }),
        state.version,
      );
      this.sourceChangeId = state.source.changeId;
      this.plans.clear();
      // Keep the repository-scoped journal. canUndo is only true when its exact
      // attributed operation AND selected-source state version still match.
      return { state };
    });
  }
  getLog(): Promise<{ version: string; output: string; rows: LogRow[] }> {
    return this.serial(async () => {
      const before = await this.readState();
      // Preserve the original configured graph/template for API compatibility.
      const output = (await this.jjRunner(this.root, ["log", "--limit", "100"]))
        .stdout;
      const configuredRevset = (
        await this.jjRunner(this.root, ["config", "get", "revsets.log"])
      ).stdout.trim();
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
          "--limit",
          "100",
          "--config",
          "ui.log-word-wrap=false",
          "-r",
          `latest((${configuredRevset}), 99) | ${this.sourceRevset}`,
          "-T",
          template,
        ])
      ).stdout;
      const lines = rendered.split("\n");
      if (lines.at(-1) === "") lines.pop();
      const rows = lines.map((line): LogRow => {
        const index = line.indexOf(marker);
        if (index === -1) return { graph: line };
        const [changeId, commitId, description, mutable, isWorkingCopy] = line
          .slice(index + marker.length)
          .split("\t")
          .map((value) => JSON.parse(value));
        if (
          !/^[k-z]+$/.test(changeId) ||
          !/^[0-9a-f]{40,64}$/.test(commitId) ||
          typeof description !== "string" ||
          typeof mutable !== "boolean" ||
          typeof isWorkingCopy !== "boolean"
        )
          throw new Error("Unrecognized revision in jj graph.");
        return {
          graph: line.slice(0, index),
          revision: { changeId, commitId, description },
          mutable,
          isWorkingCopy,
        };
      });
      this.requireVersion(await this.readState(), before.version);
      return { version: before.version, output, rows };
    });
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
    throw new ApiError(
      500,
      current === beforeOperation ? "TOOL_FAILED" : "PARTIAL_FAILURE",
      current === beforeOperation
        ? "The tool failed without a recorded history change. Nothing was automatically retried. Refresh before trying again."
        : "The tool failed and history may have changed. Inspect jj op log before doing anything else. No retry or rollback was attempted.",
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
