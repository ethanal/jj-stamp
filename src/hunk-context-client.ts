import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { Hunk } from "./types";
import { supportsHunkContext } from "./hunk-context-language";
import {
  HUNK_CONTEXT_SCHEMA,
  type HunkContextRequest,
  type HunkContextResponse,
  type HunkContexts,
} from "./hunk-context-protocol";

export { supportsHunkContext } from "./hunk-context-language";
export type { HunkContext } from "./hunk-context";

export interface ScopeWorker {
  onmessage: ((event: MessageEvent<HunkContextResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: HunkContextRequest): void;
  terminate(): void;
}

interface Options {
  createWorker?: () => ScopeWorker;
  schema?: string;
  maxEntries?: number;
  maxBytes?: number;
  maxPending?: number;
  maxPendingBytes?: number;
  timeoutMs?: number;
}
interface Job {
  key: string;
  request?: HunkContextRequest;
  id: number;
  bytes: number;
  promise: Promise<HunkContexts>;
  resolve: (value: HunkContexts) => void;
  reject: (error: Error) => void;
}

export function hunkContextCacheKey(
  identity: string,
  path: string,
  schema = HUNK_CONTEXT_SCHEMA,
): string {
  return JSON.stringify([schema, identity, path]);
}

function nativeWorker(): ScopeWorker {
  if (typeof Worker === "undefined")
    throw new Error("Scope workers are unavailable.");
  return new Worker(new URL("./hunk-context.worker.ts", import.meta.url), {
    type: "module",
  });
}

/** In-memory derived results only; never stores syntax trees or authorization.
 * Identity MUST encode repository, immutable full source/base commit IDs and patch
 * (including hunk representation). Never pass a change ID or live operation token.
 * Rejections are optional-label misses; callers retain independent expansion reads.
 */
export function createHunkContextClient(options: Options = {}) {
  const schema = options.schema ?? HUNK_CONTEXT_SCHEMA;
  const maxEntries = options.maxEntries ?? 200;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  const maxPending = options.maxPending ?? 8;
  const maxPendingBytes = options.maxPendingBytes ?? 16 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const cache = new Map<string, { contexts: HunkContexts; bytes: number }>();
  const pending = new Map<string, Job>();
  const queue: Job[] = [];
  let worker: ScopeWorker | undefined;
  let active: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  let bytes = 0;
  let pendingBytes = 0;
  const counters = {
    hits: 0,
    misses: 0,
    deduplicated: 0,
    parses: 0,
    evictions: 0,
    failures: 0,
  };

  function lookup(key: string): HunkContexts | undefined {
    const hit = cache.get(key);
    if (!hit) return;
    cache.delete(key);
    cache.set(key, hit);
    counters.hits++;
    return hit.contexts;
  }

  function retain(key: string, contexts: HunkContexts) {
    // Conservative UTF-16 serialized size plus object overhead; includes identity
    // (which can contain a large patch), not just the tiny scope labels.
    const size = 2 * (key.length + JSON.stringify(contexts).length) + 128;
    if (maxEntries <= 0 || size > maxBytes) return;
    for (const context of Object.values(contexts)) {
      for (const scope of context.scopes) Object.freeze(scope);
      Object.freeze(context.scopes);
      Object.freeze(context);
    }
    Object.freeze(contexts);
    cache.set(key, { contexts, bytes: size });
    bytes += size;
    while (cache.size > maxEntries || bytes > maxBytes) {
      const oldest = cache.keys().next().value!;
      bytes -= cache.get(oldest)!.bytes;
      cache.delete(oldest);
      counters.evictions++;
    }
  }

  function failWorker(error: Error) {
    clearTimeout(timer);
    if (worker) {
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
    }
    worker = undefined;
    active = undefined;
    queue.length = 0;
    for (const job of pending.values()) {
      counters.failures++;
      job.reject(error);
    }
    pending.clear();
    pendingBytes = 0;
  }

  function pump() {
    if (active || !queue.length) return;
    try {
      if (!worker) {
        const current = (options.createWorker ?? nativeWorker)();
        worker = current;
        current.onmessage = ({ data }) => {
          if (worker !== current || !active || data.id !== active.id) return;
          if (data.schema !== schema) {
            failWorker(new Error("Incompatible scope worker schema."));
            return;
          }
          const job = active;
          clearTimeout(timer);
          active = undefined;
          pending.delete(job.key);
          pendingBytes -= job.bytes;
          if ("error" in data) {
            counters.failures++;
            job.reject(new Error(data.error));
          } else {
            retain(job.key, data.contexts);
            job.resolve(data.contexts);
          }
          pump();
        };
        current.onerror = (event) => {
          event.preventDefault?.();
          if (worker === current)
            failWorker(new Error(event.message || "Scope worker crashed."));
        };
        current.onmessageerror = () => {
          if (worker === current)
            failWorker(new Error("Scope worker message could not be decoded."));
        };
      }
      active = queue.shift()!;
      timer = setTimeout(
        () => failWorker(new Error("Scope worker timed out.")),
        timeoutMs,
      );
      counters.parses++;
      const request = active.request!;
      // postMessage clones the source. Release our queued source references now;
      // only the bounded worker request holds them during parsing.
      active.request = undefined;
      worker.postMessage(request);
    } catch (error) {
      failWorker(error instanceof Error ? error : new Error(String(error)));
    }
  }

  function inferCachedHunkContexts(
    identity: string,
    path: string,
    hunks: Hunk[],
    files: FileDiffLoadedFiles,
  ): Promise<HunkContexts> {
    const key = hunkContextCacheKey(identity, path, schema);
    const cached = lookup(key);
    if (cached !== undefined) return Promise.resolve(cached);
    const existing = pending.get(key);
    if (existing) {
      counters.deduplicated++;
      return existing.promise;
    }
    counters.misses++;
    if (!supportsHunkContext(path) || !hunks.length) {
      const empty = {};
      retain(key, empty);
      return Promise.resolve(empty);
    }
    if (pending.size >= maxPending)
      return Promise.reject(new Error("Scope worker queue is full."));
    // Only row markers and coordinates are needed by the extractor, not patch
    // text, selection metadata, or highlighted HTML. Avoid cloning all of those.
    let size = 2 * (key.length + path.length) + 256;
    for (const file of [files.oldFile, files.newFile])
      if (file) size += 2 * (file.contents.length + file.name.length) + 128;
    for (const hunk of hunks)
      size += hunk.id.length * 2 + hunk.rows.length * 96 + 128;
    if (size + pendingBytes > maxPendingBytes)
      return Promise.reject(new Error("Scope worker input budget exceeded."));
    const request: HunkContextRequest = {
      id: ++sequence,
      schema,
      path,
      hunks: hunks.map((hunk) => ({
        id: hunk.id,
        header: "",
        rows: hunk.rows.map((row) => ({
          index: row.index,
          raw: row.raw.slice(0, 1),
          oldLine: row.oldLine,
          newLine: row.newLine,
        })),
      })),
      files: {
        oldFile: files.oldFile
          ? { name: files.oldFile.name, contents: files.oldFile.contents }
          : null,
        newFile: files.newFile
          ? { name: files.newFile.name, contents: files.newFile.contents }
          : null,
      } as FileDiffLoadedFiles,
    };
    let resolve!: Job["resolve"];
    let reject!: Job["reject"];
    const promise = new Promise<HunkContexts>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const job: Job = {
      key,
      request,
      id: request.id,
      bytes: size,
      promise,
      resolve,
      reject,
    };
    pending.set(key, job);
    pendingBytes += size;
    queue.push(job);
    pump();
    return promise;
  }

  return {
    inferCachedHunkContexts,
    // Check before loading file sides. {} is a successful cached result too.
    peekCachedHunkContexts: (identity: string, path: string) =>
      lookup(hunkContextCacheKey(identity, path, schema)),
    stats: () => ({
      ...counters,
      entries: cache.size,
      bytes,
      pending: pending.size,
      pendingBytes,
      queued: queue.length,
    }),
    dispose: () => {
      failWorker(new Error("Scope client disposed."));
      cache.clear();
      bytes = 0;
    },
  };
}

const client = createHunkContextClient();
export const inferCachedHunkContexts = client.inferCachedHunkContexts;
export const peekCachedHunkContexts = client.peekCachedHunkContexts;
export const hunkContextCacheStats = client.stats;
