import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import type { RepositoryChange } from "../src/types.ts";
import { WatchError } from "./watch-errors.ts";

export type FilesystemChange = RepositoryChange;

export interface FilesystemEventHandlers {
  change(change: FilesystemChange): void;
  unavailable(error?: unknown): void;
}

export interface FilesystemEventWatcher {
  setPaths(paths: readonly string[]): void;
  close(): void;
}

export type FilesystemEventBackend = (
  workspaceRoot: string,
  handlers: FilesystemEventHandlers,
  signal: AbortSignal,
  paths: readonly string[],
) => Promise<FilesystemEventWatcher>;

const DEFAULT_MAX_DIRECTORIES = 4096;
const MAX_HEADS = 64;
const COALESCE_MS = 25;
const HEAD_ID = /^[0-9a-f]{32,128}$/;

interface FilesystemWatcherOptions {
  maxDirectories: number;
  readHeads: (headsPath: string) => Promise<string[] | null>;
  afterDirectoryWatch?: (directory: string) => Promise<void>;
}

function abortError() {
  const error = new Error("Filesystem event setup was cancelled.");
  error.name = "AbortError";
  return error;
}

function ignoredMetadata(name: string) {
  return name === ".jj" || name === ".git";
}

function sameHeads(left: string[] | null, right: string[] | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.length === right.length &&
      left.every((value, index) => value === right[index]))
  );
}

async function readBoundedRegularFile(file: string, maxBytes: number) {
  const handle = await open(
    file,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new WatchError(
        "WATCH_UNSUPPORTED_METADATA",
        "Repository metadata must be a regular file.",
      );
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let bytes = 0;
    while (bytes < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytes,
        buffer.byteLength - bytes,
        null,
      );
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    if (bytes > maxBytes)
      throw new WatchError(
        "WATCH_METADATA_TOO_LARGE",
        `Repository metadata exceeds its ${maxBytes}-byte read limit.`,
      );
    return buffer.subarray(0, bytes);
  } finally {
    await handle.close();
  }
}

async function requireDirectoryWithoutSymlinks(directory: string) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep)) {
    if (!component) continue;
    current = path.join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink())
      throw new WatchError(
        "WATCH_UNSAFE_METADATA",
        "Repository metadata contains a symbolic link or an unexpected file type.",
      );
  }
  const final = await lstat(absolute);
  if (!final.isDirectory() || final.isSymbolicLink())
    throw new WatchError(
      "WATCH_UNSUPPORTED_METADATA",
      "The repository metadata layout is not supported by the filesystem watcher.",
    );
  return absolute;
}

async function resolveRepoDirectory(workspaceRoot: string): Promise<string> {
  const jjDirectory = path.join(workspaceRoot, ".jj");
  const jjEntry = await lstat(jjDirectory);
  if (!jjEntry.isDirectory() || jjEntry.isSymbolicLink())
    throw new WatchError(
      "WATCH_UNSAFE_METADATA",
      "Repository metadata contains a symbolic link or an unexpected file type.",
    );
  const repoEntry = path.join(jjDirectory, "repo");
  const entry = await lstat(repoEntry);
  if (entry.isSymbolicLink())
    throw new WatchError(
      "WATCH_UNSAFE_METADATA",
      "Repository metadata contains a symbolic link or an unexpected file type.",
    );
  if (entry.isDirectory()) return requireDirectoryWithoutSymlinks(repoEntry);
  if (!entry.isFile())
    throw new WatchError(
      "WATCH_UNSUPPORTED_METADATA",
      "The repository metadata layout is not supported by the filesystem watcher.",
    );
  const contents = await readBoundedRegularFile(repoEntry, 4096);
  if (contents.byteLength === 0)
    throw new WatchError(
      "WATCH_INVALID_REPOSITORY_LINK",
      "The linked workspace repository pointer is empty or invalid.",
    );
  const relative = contents.toString("utf8").trim();
  if (!relative || relative.includes("\0"))
    throw new WatchError(
      "WATCH_INVALID_REPOSITORY_LINK",
      "The linked workspace repository pointer is empty or invalid.",
    );
  return requireDirectoryWithoutSymlinks(
    path.resolve(path.dirname(repoEntry), relative),
  );
}

async function readHeadsFile(headsPath: string): Promise<string[] | null> {
  try {
    const before = await lstat(headsPath);
    if (before.isSymbolicLink()) return null;
    if (before.isDirectory()) {
      const directory = await opendir(headsPath);
      const heads: string[] = [];
      try {
        while (true) {
          const entry = await directory.read();
          if (entry === null) break;
          if (entry.name === "lock") continue;
          if (!HEAD_ID.test(entry.name) || heads.length >= MAX_HEADS)
            return null;
          const info = await lstat(path.join(headsPath, entry.name));
          if (!info.isFile() || info.isSymbolicLink()) return null;
          heads.push(entry.name);
        }
      } finally {
        await directory.close();
      }
      return heads.sort();
    }
    if (!before.isFile()) return null;
    const contents = await readBoundedRegularFile(headsPath, 64 * 1024);
    const values = contents.toString("utf8").split(/\s+/).filter(Boolean);
    const heads = new Set<string>();
    for (const value of values) {
      if (!HEAD_ID.test(value)) return null;
      heads.add(value);
      if (heads.size > MAX_HEADS) return null;
    }
    return [...heads].sort();
  } catch {
    return null;
  }
}

interface WatchedDirectory {
  watcher: FSWatcher;
  dev: number;
  ino: number;
}

interface DesiredDirectory {
  primary: boolean;
  guards: Set<string>;
  dev: number;
  ino: number;
}

function unsafeWorkspacePath() {
  return new WatchError(
    "WATCH_UNSAFE_WORKSPACE",
    "A selected workspace path is absolute, traverses metadata, or is otherwise unsafe to watch.",
  );
}

/** Convert selected file paths to their root-relative containing directories. */
function directoryScopes(paths: readonly string[]) {
  const scopes = new Set<string>();
  for (const selectedPath of paths) {
    if (
      !selectedPath ||
      selectedPath.includes("\0") ||
      selectedPath.includes("\\") ||
      path.posix.isAbsolute(selectedPath) ||
      path.win32.isAbsolute(selectedPath) ||
      path.posix.normalize(selectedPath) !== selectedPath
    )
      throw unsafeWorkspacePath();
    const components = selectedPath.split("/");
    if (
      components.some(
        (component) =>
          !component ||
          component === "." ||
          component === ".." ||
          ignoredMetadata(component),
      )
    )
      throw unsafeWorkspacePath();
    const directory = path.posix.dirname(selectedPath);
    scopes.add(directory === "." ? "" : directory);
  }
  return scopes;
}

function sameSet(left: Set<string>, right: Set<string>) {
  return (
    left.size === right.size && [...left].every((value) => right.has(value))
  );
}

class NativeFilesystemWatcher implements FilesystemEventWatcher {
  private readonly workspaceWatchers = new Map<string, WatchedDirectory>();
  private workspaceSpecs = new Map<string, DesiredDirectory>();
  private readonly metadataWatchers = new Map<string, FSWatcher>();
  private readonly headsPath: string;
  private readonly opHeadsPath: string;
  private desiredScopes: Set<string>;
  private appliedScopes = new Set<string>();
  private readonly forcedRenewals = new Map<string, number>();
  private forceGeneration = 0;
  private scopeGeneration = 0;
  private workspaceReconcilePending = false;
  private headsTopologyPending = false;
  private topologyRunning = false;
  private initialized = false;
  private closed = false;
  private failed = false;
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private pendingWorkspace = false;
  private pendingHeads = false;
  private lastHeads: string[] | null = null;
  private notifiedUnreadableHeads = false;

  private constructor(
    private readonly workspaceRoot: string,
    repoDirectory: string,
    private readonly handlers: FilesystemEventHandlers,
    private readonly options: FilesystemWatcherOptions,
    paths: readonly string[],
  ) {
    this.opHeadsPath = path.join(repoDirectory, "op_heads");
    this.headsPath = path.join(this.opHeadsPath, "heads");
    this.desiredScopes = directoryScopes(paths);
  }

  static async create(
    workspaceRoot: string,
    handlers: FilesystemEventHandlers,
    signal: AbortSignal,
    paths: readonly string[],
    options: FilesystemWatcherOptions,
  ): Promise<NativeFilesystemWatcher> {
    if (signal.aborted) throw abortError();
    const canonicalRoot = await realpath(workspaceRoot);
    if (signal.aborted) throw abortError();
    const repoDirectory = await resolveRepoDirectory(canonicalRoot);
    if (signal.aborted) throw abortError();
    const instance = new NativeFilesystemWatcher(
      canonicalRoot,
      repoDirectory,
      handlers,
      options,
      paths,
    );
    const aborted = () => instance.close();
    signal.addEventListener("abort", aborted, { once: true });
    try {
      instance.lastHeads = await options.readHeads(instance.headsPath);
      if (signal.aborted || instance.closed) throw abortError();
      await instance.installMetadataWatchers();
      if (signal.aborted || instance.closed) throw abortError();
      while (true) {
        instance.workspaceReconcilePending = false;
        const applied = await instance.reconcileWorkspace(
          instance.scopeGeneration,
        );
        if (signal.aborted || instance.closed) throw abortError();
        if (applied && !instance.workspaceReconcilePending) break;
      }
      if (signal.aborted || instance.closed) throw abortError();
      instance.appliedScopes = new Set(instance.desiredScopes);
      instance.initialized = true;
      instance.runTopology();
      return instance;
    } catch (error) {
      instance.close();
      throw error;
    } finally {
      signal.removeEventListener("abort", aborted);
    }
  }

  setPaths(paths: readonly string[]) {
    if (this.closed) return;
    let scopes: Set<string>;
    try {
      scopes = directoryScopes(paths);
    } catch (error) {
      this.fail(error);
      return;
    }
    if (sameSet(scopes, this.desiredScopes)) return;
    this.desiredScopes = scopes;
    this.scopeGeneration++;
    this.requestWorkspaceReconcile();
  }

  private watchDirectory(
    directory: string,
    callback: (eventType: string, filename: string | null) => void,
  ): FSWatcher {
    const watcher = watch(directory, { encoding: "utf8" }, callback);
    watcher.on("error", (error) => this.fail(error));
    return watcher;
  }

  private async installMetadataWatchers() {
    const opHeads = await lstat(this.opHeadsPath);
    if (this.closed) throw abortError();
    if (!opHeads.isDirectory() || opHeads.isSymbolicLink())
      throw new WatchError(
        "WATCH_HEADS_UNAVAILABLE",
        "The jj operation-head storage is missing or is not a regular file/directory.",
      );
    const watcher = this.watchDirectory(
      this.opHeadsPath,
      (_eventType, filename) => {
        if (filename === "lock") return;
        if (filename !== null && filename !== "heads") return;
        this.headsTopologyPending = true;
        this.runTopology();
        this.queueChange(false, true);
      },
    );
    let registered = false;
    try {
      if (this.closed) throw abortError();
      this.metadataWatchers.set(this.opHeadsPath, watcher);
      registered = true;
      await this.replaceHeadsWatcher(true);
      if (this.closed) throw abortError();
    } finally {
      if (!registered) watcher.close();
    }
  }

  private async replaceHeadsWatcher(required = false) {
    if (this.closed) {
      if (required) throw abortError();
      return;
    }
    const info = await lstat(this.headsPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );
    if (this.closed) {
      if (required) throw abortError();
      return;
    }
    const existing = this.metadataWatchers.get(this.headsPath);
    if (info === null) {
      existing?.close();
      this.metadataWatchers.delete(this.headsPath);
      if (required)
        throw new WatchError(
          "WATCH_HEADS_UNAVAILABLE",
          "The jj operation-head storage is missing or is not a regular file/directory.",
        );
      return;
    }
    if (info.isSymbolicLink())
      throw new WatchError(
        "WATCH_UNSAFE_METADATA",
        "The jj operation-head storage is a symbolic link.",
      );
    if (!info.isDirectory() && !info.isFile())
      throw new WatchError(
        "WATCH_UNSUPPORTED_METADATA",
        "The jj operation-head storage is not a regular file or directory.",
      );
    existing?.close();
    this.metadataWatchers.delete(this.headsPath);
    if (!info.isDirectory()) return;
    const watcher = this.watchDirectory(
      this.headsPath,
      (_eventType, filename) => {
        if (filename === "lock") return;
        this.queueChange(false, true);
      },
    );
    if (this.closed) {
      watcher.close();
      if (required) throw abortError();
      return;
    }
    this.metadataWatchers.set(this.headsPath, watcher);
  }

  private async safeDirectory(directory: string) {
    const info = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );
    if (this.closed) throw abortError();
    if (info === null || !info.isDirectory() || info.isSymbolicLink())
      return null;
    const resolved = await realpath(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );
    if (this.closed) throw abortError();
    if (resolved !== directory) return null;
    return info;
  }

  private async desiredDirectories(scopes: Set<string>) {
    const desired = new Map<string, DesiredDirectory>();
    const identities = new Map<
      string,
      Awaited<ReturnType<NativeFilesystemWatcher["safeDirectory"]>>
    >();
    const identity = async (directory: string) => {
      if (identities.has(directory)) return identities.get(directory)!;
      const info = await this.safeDirectory(directory);
      identities.set(directory, info);
      return info;
    };
    const add = async (directory: string) => {
      let spec = desired.get(directory);
      if (spec) return spec;
      const info = await identity(directory);
      if (info === null) return null;
      spec = {
        primary: false,
        guards: new Set(),
        dev: info.dev,
        ino: info.ino,
      };
      desired.set(directory, spec);
      return spec;
    };

    for (const scope of scopes) {
      let current = this.workspaceRoot;
      if (scope === "") {
        const spec = await add(current);
        if (spec) spec.primary = true;
        continue;
      }
      let complete = true;
      for (const component of scope.split("/")) {
        const parent = await add(current);
        if (parent === null) {
          complete = false;
          break;
        }
        parent.guards.add(component);
        const candidate = path.join(current, component);
        if ((await identity(candidate)) === null) {
          complete = false;
          break;
        }
        current = candidate;
      }
      if (complete) {
        const spec = await add(current);
        if (spec) spec.primary = true;
      }
    }
    return desired;
  }

  private workspaceEvent(
    directory: string,
    eventType: string,
    filename: string | null,
    installing?: DesiredDirectory,
  ) {
    if (this.closed) return;
    const spec = this.workspaceSpecs.get(directory) ?? installing;
    if (!spec) return;
    const primary =
      spec.primary && (filename === null || !ignoredMetadata(filename));
    const guarded = filename === null || spec.guards.has(filename);
    if (!primary && !guarded) return;
    this.queueChange(true, false);
    if (eventType === "rename") {
      if (filename === null) this.forceRenew(directory);
      else if (spec.guards.has(filename))
        this.forceRenew(path.join(directory, filename));
    }
    if (eventType === "rename" || guarded) this.requestWorkspaceReconcile();
  }

  private forceRenew(directory: string) {
    this.forcedRenewals.set(directory, ++this.forceGeneration);
  }

  private async addWorkspaceWatcher(
    directory: string,
    expected: DesiredDirectory,
    generation: number,
  ) {
    let watcher: FSWatcher;
    try {
      watcher = this.watchDirectory(directory, (eventType, filename) =>
        this.workspaceEvent(directory, eventType, filename, expected),
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        this.requestWorkspaceReconcile();
        return false;
      }
      throw error;
    }
    let registered = false;
    try {
      await this.options.afterDirectoryWatch?.(directory);
      if (this.closed) throw abortError();
      if (generation !== this.scopeGeneration) return false;
      const after = await this.safeDirectory(directory);
      if (
        after === null ||
        after.dev !== expected.dev ||
        after.ino !== expected.ino
      ) {
        this.requestWorkspaceReconcile();
        return false;
      }
      this.workspaceWatchers.set(directory, {
        watcher,
        dev: after.dev,
        ino: after.ino,
      });
      registered = true;
      return true;
    } finally {
      if (!registered) watcher.close();
    }
  }

  private async reconcileWorkspace(generation: number) {
    const scopes = new Set(this.desiredScopes);
    const forcedRenewals = new Map(this.forcedRenewals);
    const desired = await this.desiredDirectories(scopes);
    if (this.closed) throw abortError();
    if (generation !== this.scopeGeneration) return false;
    if (desired.size > this.options.maxDirectories)
      throw new WatchError(
        "WATCH_DIRECTORY_LIMIT",
        `Selected workspace scopes and their ancestors require too many directory watches (limit ${this.options.maxDirectories}).`,
      );

    for (const [directory, watched] of this.workspaceWatchers) {
      const expected = desired.get(directory);
      const forced = [...forcedRenewals].some(
        ([renew]) =>
          directory === renew || directory.startsWith(`${renew}${path.sep}`),
      );
      if (
        !forced &&
        expected &&
        expected.dev === watched.dev &&
        expected.ino === watched.ino
      )
        continue;
      watched.watcher.close();
      this.workspaceWatchers.delete(directory);
    }
    for (const [directory, expected] of desired) {
      if (generation !== this.scopeGeneration || this.closed) return false;
      if (this.workspaceWatchers.has(directory)) continue;
      if (!(await this.addWorkspaceWatcher(directory, expected, generation)))
        return false;
    }
    if (generation !== this.scopeGeneration || this.closed) return false;
    this.workspaceSpecs = desired;
    for (const [directory, force] of forcedRenewals) {
      if (this.forcedRenewals.get(directory) === force)
        this.forcedRenewals.delete(directory);
    }
    const added = [...scopes].some((scope) => !this.appliedScopes.has(scope));
    this.appliedScopes = scopes;
    if (this.initialized && added) this.queueChange(true, false);
    return true;
  }

  private requestWorkspaceReconcile() {
    if (this.closed) return;
    this.workspaceReconcilePending = true;
    this.runTopology();
  }

  private runTopology() {
    if (
      !this.initialized ||
      this.closed ||
      this.topologyRunning ||
      (!this.headsTopologyPending && !this.workspaceReconcilePending)
    )
      return;
    this.topologyRunning = true;
    void (async () => {
      try {
        while (!this.closed) {
          if (this.headsTopologyPending) {
            this.headsTopologyPending = false;
            await this.replaceHeadsWatcher();
            continue;
          }
          if (!this.workspaceReconcilePending) break;
          this.workspaceReconcilePending = false;
          const generation = this.scopeGeneration;
          const applied = await this.reconcileWorkspace(generation);
          if (!applied && !this.closed) this.workspaceReconcilePending = true;
        }
      } catch (error) {
        if (!this.closed) this.fail(error);
      } finally {
        this.topologyRunning = false;
        if (
          !this.closed &&
          (this.headsTopologyPending || this.workspaceReconcilePending)
        )
          this.runTopology();
      }
    })();
  }

  private queueChange(workspace: boolean, heads: boolean) {
    if (this.closed) return;
    this.pendingWorkspace ||= workspace;
    this.pendingHeads ||= heads;
    if (this.flushing || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      this.flushing = true;
      void this.flush()
        .catch((error) => this.fail(error))
        .finally(() => {
          this.flushing = false;
          if (!this.closed && (this.pendingWorkspace || this.pendingHeads))
            this.queueChange(false, false);
        });
    }, COALESCE_MS);
    this.timer.unref?.();
  }

  private async flush() {
    while (!this.closed && (this.pendingWorkspace || this.pendingHeads)) {
      const workspace = this.pendingWorkspace;
      const inspectHeads = this.pendingHeads;
      this.pendingWorkspace = false;
      this.pendingHeads = false;
      let headsChanged = false;
      if (inspectHeads) {
        const next = await this.options.readHeads(this.headsPath);
        if (this.closed) return;
        headsChanged =
          next === null
            ? this.lastHeads !== null || !this.notifiedUnreadableHeads
            : !sameHeads(this.lastHeads, next);
        this.lastHeads = next;
        this.notifiedUnreadableHeads = next === null;
      }
      if (workspace || headsChanged)
        this.handlers.change({ workspace, heads: this.lastHeads });
    }
  }

  private fail(error: unknown) {
    if (this.closed || this.failed) return;
    this.failed = true;
    this.close();
    this.handlers.unavailable(error);
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.workspaceReconcilePending = false;
    this.headsTopologyPending = false;
    for (const watched of this.workspaceWatchers.values())
      watched.watcher.close();
    for (const watcher of this.metadataWatchers.values()) watcher.close();
    this.workspaceWatchers.clear();
    this.workspaceSpecs.clear();
    this.forcedRenewals.clear();
    this.metadataWatchers.clear();
  }
}

const defaultOptions: FilesystemWatcherOptions = {
  maxDirectories: DEFAULT_MAX_DIRECTORIES,
  readHeads: readHeadsFile,
};

export const watchFilesystemEvents: FilesystemEventBackend = (
  workspaceRoot,
  handlers,
  signal,
  paths,
) =>
  NativeFilesystemWatcher.create(
    workspaceRoot,
    handlers,
    signal,
    paths,
    defaultOptions,
  );

export interface FilesystemEventTestOptions {
  maxDirectories?: number;
  readHeads?: (headsPath: string) => Promise<string[] | null>;
  afterDirectoryWatch?: (directory: string) => Promise<void>;
}

/** Test hook for deterministic resource, cancellation, and read-order checks. */
export function watchFilesystemEventsForTest(
  options: FilesystemEventTestOptions,
): FilesystemEventBackend {
  return (workspaceRoot, handlers, signal, paths) =>
    NativeFilesystemWatcher.create(workspaceRoot, handlers, signal, paths, {
      maxDirectories: options.maxDirectories ?? DEFAULT_MAX_DIRECTORIES,
      readHeads: options.readHeads ?? readHeadsFile,
      afterDirectoryWatch: options.afterDirectoryWatch,
    });
}

export function watchFilesystemEventsWithLimit(
  maxDirectories: number,
): FilesystemEventBackend {
  return watchFilesystemEventsForTest({ maxDirectories });
}
