import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createDemo } from "./demo.ts";
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
  repo: { name: string; path: string; demo: boolean };
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
  demo: boolean;
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
  dataDir?: string;
  repoPath?: string;
  toolRunner?: typeof run;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
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
  readonly dataDir: string;
  private repoPath?: string;
  private toolRunner: typeof run;
  constructor(options: ServiceOptions = {}) {
    this.toolRunner = options.toolRunner ?? run;
    this.dataDir = options.dataDir ?? path.join(projectRoot, ".data");
    this.repoPath = options.repoPath ?? process.env.JJ_REPO;
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
  private async init(): Promise<void> {
    if (this.active) return;
    await mkdir(this.dataDir, { recursive: true });
    const manifestPath = path.join(this.dataDir, "active-repo.json");
    const manifest = await readJSON<Active>(manifestPath);
    const active: Active = this.repoPath
      ? { path: path.resolve(this.repoPath), demo: false }
      : (manifest ?? { path: await createDemo(this.dataDir), demo: true });
    if (typeof active.path !== "string" || typeof active.demo !== "boolean")
      throw new Error("Invalid active repository manifest.");
    const root = (await jj(active.path, ["root"])).stdout.trim();
    active.path = await realpath(root);
    // A demo claim must be within our dedicated data directory, never a user repo.
    if (
      active.demo &&
      (!path.basename(active.path).startsWith("demo-") ||
        path.dirname(active.path) !== (await realpath(this.dataDir)))
    ) {
      throw new Error(
        "Demo repository manifest points outside the demo directory.",
      );
    }
    await atomicJSON(manifestPath, active);
    this.active = active;
    this.journal = (await readJSON<Journal>(this.journalPath)) ?? {};
  }
  private async operation(): Promise<Operation> {
    const output = (
      await jj(this.root, [
        "op",
        "log",
        "--no-graph",
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
  private async revisions(revset: string): Promise<Revision[]> {
    const output = (
      await jj(this.root, [
        "log",
        "--no-graph",
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
  private async assertNoConflicts(): Promise<void> {
    if ((await this.revisions("conflicts()")).length)
      throw new ApiError(
        409,
        "CONFLICTED_REPO",
        "This repository contains conflicted revisions. Resolve them with jj before reviewing or squashing.",
      );
  }
  private async files(source: string): Promise<ReviewFile[]> {
    const diff = (await jj(this.root, ["diff", "--git", "-r", source])).stdout;
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
    return files;
  }
  private async readState(allowConflicts = false): Promise<State> {
    await this.init();
    await jj(this.root, ["status"]); // Snapshot BEFORE acquiring the operation token.
    const operation = await this.operation();
    if (!allowConflicts) await this.assertNoConflicts();
    const sources = await this.revisions("@");
    if (sources.length !== 1)
      throw new Error("Current workspace must resolve to one source revision.");
    const source = sources[0];
    const mutableSource = await this.revisions(
      `mutable() & ${source.commitId}`,
    );
    const targets = mutableSource.length
      ? await this.revisions(
          `mutable() & ::${source.commitId} ~ ${source.commitId}`,
        )
      : [];
    const parents = await this.revisions(`${source.commitId}-`);
    const parent =
      parents.length === 1
        ? (targets.find((target) => target.commitId === parents[0].commitId) ??
          null)
        : null;
    const squashUnavailable = !mutableSource.length
      ? "The current revision is immutable."
      : parents.length !== 1
        ? "Squashing requires exactly one immediate parent; merges are not supported."
        : !parent
          ? "The immediate parent is immutable; squashing into an older ancestor is not allowed."
          : undefined;
    const files = await this.files(source.commitId);
    await jj(this.root, ["status"]);
    if (
      (await this.operation()).id !== operation.id ||
      !same(await this.revisions("@"), sources)
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
        name: this.active!.demo ? "orbit" : path.basename(this.root),
        path: this.root,
        demo: this.active!.demo,
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
  getLog(): Promise<{ version: string; output: string }> {
    return this.serial(async () => {
      const before = await this.readState();
      // Deliberately use jj's configured, real graph output, not an app template.
      const output = (await jj(this.root, ["log", "--limit", "100"])).stdout;
      this.requireVersion(await this.readState(), before.version);
      return { version: before.version, output };
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
          await jj(this.root, [
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
      const preview = await this.previewInternal(
        { ...input, target: state.parent.changeId },
        state,
      );
      return this.squashInternal(preview.token);
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
        "A previous history operation did not finish cleanly. Inspect jj op log before doing more work. No automatic retry or rollback was attempted. Demo repositories can be reset.",
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
        "Choose a mutable ancestor of the current revision.",
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
    if ((await this.revisions("conflicts()")).length)
      warning =
        "The squash created a conflict. Undo this operation now, or resolve the conflict with jj before continuing.";
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
      await jj(this.root, ["status"]);
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
        result = await jj(this.root, ["op", "revert", undo.operation]);
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
  reset(version: string): Promise<{ state: State }> {
    return this.serial(async () => {
      const state = await this.readState(true);
      this.requireVersion(state, version);
      if (!this.active!.demo)
        throw new ApiError(
          403,
          "NOT_DEMO",
          "Reset is available only for the generated demo. Your repository was not modified.",
        );
      const root = await createDemo(this.dataDir);
      this.active = { path: root, demo: true };
      this.journal = {};
      this.plans.clear();
      await atomicJSON(
        path.join(this.dataDir, "active-repo.json"),
        this.active,
      );
      return { state: await this.readState() };
    });
  }
}
