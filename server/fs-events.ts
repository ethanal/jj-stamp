import { constants, watch, type FSWatcher } from "node:fs";
import { lstat, open, opendir, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import type { RepositoryChange } from "../src/types.ts";
import { WatchError } from "./watch-errors.ts";

export type FilesystemChange = RepositoryChange;

export interface FilesystemEventHandlers {
  change(change: FilesystemChange): void;
  unavailable(error?: unknown): void;
}

export interface FilesystemEventWatcher {
  close(): void;
}

export type FilesystemEventBackend = (
  workspaceRoot: string,
  handlers: FilesystemEventHandlers,
  signal: AbortSignal,
) => Promise<FilesystemEventWatcher>;

const DEFAULT_MAX_DIRECTORIES = 4096;
const MAX_TOPOLOGY_CHANGES = 4096;
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

class NativeFilesystemWatcher implements FilesystemEventWatcher {
  private readonly workspaceWatchers = new Map<string, WatchedDirectory>();
  private readonly metadataWatchers = new Map<string, FSWatcher>();
  private readonly headsPath: string;
  private readonly opHeadsPath: string;
  private readonly pendingTopology = new Map<string, boolean>();
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
    repoDirectory: string,
    private readonly handlers: FilesystemEventHandlers,
    private readonly options: FilesystemWatcherOptions,
  ) {
    this.opHeadsPath = path.join(repoDirectory, "op_heads");
    this.headsPath = path.join(this.opHeadsPath, "heads");
  }

  static async create(
    workspaceRoot: string,
    handlers: FilesystemEventHandlers,
    signal: AbortSignal,
    options: FilesystemWatcherOptions,
  ): Promise<NativeFilesystemWatcher> {
    if (signal.aborted) throw abortError();
    const canonicalRoot = await realpath(workspaceRoot);
    if (signal.aborted) throw abortError();
    const repoDirectory = await resolveRepoDirectory(canonicalRoot);
    if (signal.aborted) throw abortError();
    const instance = new NativeFilesystemWatcher(
      repoDirectory,
      handlers,
      options,
    );
    const aborted = () => instance.close();
    signal.addEventListener("abort", aborted, { once: true });
    try {
      instance.lastHeads = await options.readHeads(instance.headsPath);
      if (signal.aborted || instance.closed) throw abortError();
      await instance.installMetadataWatchers();
      if (signal.aborted || instance.closed) throw abortError();
      await instance.addWorkspaceTree(canonicalRoot);
      if (signal.aborted || instance.closed) throw abortError();
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

  private async addWorkspaceTree(start: string) {
    const pending = [start];
    while (pending.length > 0) {
      if (this.closed) throw abortError();
      const directory = pending.shift()!;
      if (this.workspaceWatchers.has(directory)) continue;
      const before = await lstat(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        },
      );
      if (this.closed) throw abortError();
      if (before === null || !before.isDirectory() || before.isSymbolicLink())
        continue;
      const resolvedBefore = await realpath(directory).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        },
      );
      if (this.closed) throw abortError();
      // Every queued path is rooted at the already-canonical workspace. A
      // different real path means a component became a symlink.
      if (resolvedBefore !== directory) continue;
      if (this.workspaceWatchers.size >= this.options.maxDirectories)
        throw new WatchError(
          "WATCH_DIRECTORY_LIMIT",
          `Workspace has too many directories to watch safely (limit ${this.options.maxDirectories}). Ignored/generated directories are included.`,
        );
      const watcher = this.watchDirectory(directory, (eventType, filename) => {
        if (filename !== null && ignoredMetadata(filename)) return;
        this.queueChange(true, false);
        if (eventType === "rename") {
          if (filename === null) this.requestTopology(directory, true);
          else this.requestTopology(path.join(directory, filename), false);
        }
      });
      let registered = false;
      try {
        await this.options.afterDirectoryWatch?.(directory);
        if (this.closed) throw abortError();
        const after = await lstat(directory).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR")
              return null;
            throw error;
          },
        );
        if (this.closed) throw abortError();
        const resolvedAfter = await realpath(directory).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT" || error.code === "ENOTDIR")
              return null;
            throw error;
          },
        );
        if (this.closed) throw abortError();
        if (
          after === null ||
          !after.isDirectory() ||
          after.isSymbolicLink() ||
          resolvedAfter !== directory ||
          before.dev !== after.dev ||
          before.ino !== after.ino
        )
          continue;
        this.workspaceWatchers.set(directory, {
          watcher,
          dev: after.dev,
          ino: after.ino,
        });
        registered = true;
        const entries = await readdir(directory, {
          withFileTypes: true,
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
          throw error;
        });
        if (this.closed) {
          this.removeWorkspaceTree(directory);
          throw abortError();
        }
        if (entries === null) {
          this.removeWorkspaceTree(directory);
          continue;
        }
        for (const entry of entries) {
          if (ignoredMetadata(entry.name) || !entry.isDirectory()) continue;
          pending.push(path.join(directory, entry.name));
        }
      } finally {
        if (!registered) watcher.close();
      }
    }
  }

  private async reconcileDirectory(directory: string) {
    // A missing filename means the platform cannot identify which child was
    // renamed. Renew this subtree rather than retaining a watcher on a replaced
    // inode or scanning it into an unbounded queue of child tasks.
    await this.reconcilePath(directory, true);
  }

  private async reconcilePath(candidate: string, forceRenew: boolean) {
    if (this.closed) return;
    const info = await lstat(candidate).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );
    if (this.closed) return;
    if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
      this.removeWorkspaceTree(candidate);
      return;
    }
    const resolved = await realpath(candidate).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
        throw error;
      },
    );
    if (this.closed) return;
    if (resolved !== candidate) {
      this.removeWorkspaceTree(candidate);
      return;
    }
    const existing = this.workspaceWatchers.get(candidate);
    if (
      existing &&
      !forceRenew &&
      existing.dev === info.dev &&
      existing.ino === info.ino
    )
      return;
    if (existing) this.removeWorkspaceTree(candidate);
    await this.addWorkspaceTree(candidate);
  }

  private removeWorkspaceTree(root: string) {
    const prefix = `${root}${path.sep}`;
    for (const [directory, watched] of this.workspaceWatchers) {
      if (directory !== root && !directory.startsWith(prefix)) continue;
      watched.watcher.close();
      this.workspaceWatchers.delete(directory);
    }
  }

  private requestTopology(candidate: string, rescan: boolean) {
    if (this.closed) return;
    const existing = this.pendingTopology.get(candidate) ?? false;
    if (
      !this.pendingTopology.has(candidate) &&
      this.pendingTopology.size >= MAX_TOPOLOGY_CHANGES
    ) {
      this.fail(
        new WatchError(
          "WATCH_EVENT_OVERFLOW",
          `Too many filesystem directory changes are queued (limit ${MAX_TOPOLOGY_CHANGES}).`,
        ),
      );
      return;
    }
    this.pendingTopology.set(candidate, existing || rescan);
    this.runTopology();
  }

  private runTopology() {
    if (
      !this.initialized ||
      this.closed ||
      this.topologyRunning ||
      (!this.headsTopologyPending && this.pendingTopology.size === 0)
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
          const next = this.pendingTopology.entries().next();
          if (next.done) break;
          const [candidate, rescan] = next.value;
          this.pendingTopology.delete(candidate);
          if (rescan) await this.reconcileDirectory(candidate);
          else await this.reconcilePath(candidate, true);
        }
      } catch (error) {
        if (!this.closed) this.fail(error);
      } finally {
        this.topologyRunning = false;
        if (
          !this.closed &&
          (this.headsTopologyPending || this.pendingTopology.size > 0)
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
    this.pendingTopology.clear();
    this.headsTopologyPending = false;
    for (const watched of this.workspaceWatchers.values())
      watched.watcher.close();
    for (const watcher of this.metadataWatchers.values()) watcher.close();
    this.workspaceWatchers.clear();
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
) =>
  NativeFilesystemWatcher.create(
    workspaceRoot,
    handlers,
    signal,
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
  return (workspaceRoot, handlers, signal) =>
    NativeFilesystemWatcher.create(workspaceRoot, handlers, signal, {
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
