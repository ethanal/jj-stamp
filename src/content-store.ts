import type { FileContents as FileSide } from "@pierre/diffs";
import type { DiffFile, LogRow, RepoState } from "./types";

export interface PinnedCommit {
  repo: { name: string; path: string };
  commitId: string;
  /** Undefined for seeded live states with no eligible parent descriptor.
   * Null is reserved for a pinned backend response with no single base.
   * This display-only descriptor must never establish mutation eligibility.
   */
  baseCommitId?: string | null;
  files: DiffFile[];
}

/** Null means an absent side; an empty contents string is an existing file. */
export interface FileContents {
  oldFile: FileSide | null;
  newFile: FileSide | null;
}

export interface ContentLoaders {
  loadCommit(commitId: string): Promise<PinnedCommit>;
  loadFile(commitId: string, path: string): Promise<FileContents>;
}

/** Raw diff/file retention only. Derived scope/parser caches have independent
 * budgets owned by their worker/cache layer, not charged or invalidated here.
 */
export interface ContentStoreLimits {
  demandCommits: number;
  speculativeCommits: number;
  demandDiffBytes: number;
  demandFileBytes: number;
  speculativeDiffBytes: number;
  speculativeFileBytes: number;
  /** Reservations before starting an unknown-size background response. */
  diffReservationBytes: number;
  fileReservationBytes: number;
  maxDiffBytes: number;
  maxFileBytes: number;
  /** Bounds path-keyed optional-failure tombstones, independently of file count.
   * Overflow falls back to one suppression marker per eligible commit.
   */
  maxRejectedTasks: number;
  maxRejectedBytes: number;
}

const MiB = 1024 * 1024;
const defaults: ContentStoreLimits = {
  demandCommits: 30,
  speculativeCommits: 10,
  demandDiffBytes: 8 * MiB,
  demandFileBytes: 24 * MiB,
  speculativeDiffBytes: 4 * MiB,
  speculativeFileBytes: 12 * MiB,
  diffReservationBytes: 256 * 1024,
  fileReservationBytes: MiB,
  maxDiffBytes: 8 * MiB,
  maxFileBytes: 8 * MiB,
  maxRejectedTasks: 128,
  maxRejectedBytes: 64 * 1024,
};

type Kind = "diff" | "file";
type Bucket = {
  id: string;
  commit?: PinnedCommit;
  diffBytes: number;
  files: Map<string, { value: FileContents; bytes: number }>;
};
type Task = {
  key: string;
  bucket: Bucket;
  kind: Kind;
  path?: string;
  demand: boolean;
  promise: Promise<PinnedCommit | FileContents>;
};

/** Conservative retained-payload estimate (UTF-16 plus object/array overhead).
 * This is an accounting bound, not a measurement of JS engine heap usage.
 */
export function contentBytes(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length * 2;
  if (typeof value !== "object") return 8;
  if (Array.isArray(value))
    return 24 + value.reduce((sum, item) => sum + 8 + contentBytes(item), 0);
  return (
    32 +
    Object.entries(value).reduce(
      (sum, [key, item]) => sum + key.length * 2 + 8 + contentBytes(item),
      0,
    )
  );
}

/** One instance per server-provided repo.path. Never pass optimistic states to seed.
 * IDs are opaque full commit IDs: change IDs, operation tokens and live state
 * versions deliberately play no role. Consumers may retain returned references
 * independently of cache eviction. No timers, React or browser globals required.
 */
export class ContentStore {
  private readonly limits: ContentStoreLimits;
  private readonly demand = new Map<string, Bucket>();
  private readonly speculative = new Map<string, Bucket>();
  private readonly inflight = new Map<string, Task>();
  private readonly rejected = new Map<
    string,
    { rank: number; headroom: number }
  >();
  private readonly suppressed = new Map<
    string,
    { kind: Kind; rank: number; headroom: number }
  >();
  private ranks = new Map<string, number>();
  private targets: string[] = [];
  private selected = "";
  private signature = "";
  // The owner must explicitly enable speculation after establishing visibility
  // and foreground mutation/refresh state. Demand reads always bypass this gate.
  private paused = true;
  private disposed = false;
  private scheduled = false;
  private background: Task | undefined;
  private demandActive = 0;
  // The confirmed displayed diff can outlive LRU eviction. Do not silently
  // pretend that its bytes disappeared just because it was too large to cache.
  private displayed: PinnedCommit | undefined;
  private displayedBytes = 0;
  private readonly counters = {
    commitFetches: 0,
    fileFetches: 0,
    hits: 0,
    deduplicated: 0,
    demandEvictions: 0,
    speculativeEvictions: 0,
    rejected: 0,
    discarded: 0,
  };

  constructor(
    readonly repoPath: string,
    private readonly loaders: ContentLoaders,
    limits: Partial<ContentStoreLimits> = {},
  ) {
    this.limits = { ...defaults, ...limits };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error(`Invalid content store limit: ${key}`);
    }
  }

  seed(state: RepoState): void {
    this.assertOpen();
    if (state.repo.path !== this.repoPath)
      throw new Error("Cannot seed content from a different repository");
    const id = state.source.commitId;
    const bucket =
      this.displayed?.commitId === id && this.demand.has(id)
        ? this.demand.get(id)!
        : this.touch(id, false);
    // A metadata-only refresh is not an additional user demand touch.
    this.displayed =
      bucket.commit ??
      (this.displayed?.commitId === id
        ? this.displayed
        : {
            repo: state.repo,
            commitId: id,
            baseCommitId: state.parent?.commitId,
            files: state.files,
          });
    this.displayedBytes = contentBytes(this.displayed);
    if (!bucket.commit) this.admit(bucket, "diff", this.displayed, true);
    this.shrinkSpeculation();
    this.schedule();
  }

  /** Synchronous display probe: no I/O, promotion, recency or hit-stat changes. */
  peekCommit(commitId: string): PinnedCommit | undefined {
    this.assertOpen();
    return this.knownCommit(commitId);
  }

  getCommit(commitId: string): Promise<PinnedCommit>;
  getCommit(commitId: string, demand: true): Promise<PinnedCommit>;
  getCommit(commitId: string, demand: false): Promise<PinnedCommit | undefined>;
  getCommit(
    commitId: string,
    demand: boolean,
  ): Promise<PinnedCommit | undefined>;
  getCommit(
    commitId: string,
    demand = true,
  ): Promise<PinnedCommit | undefined> {
    this.assertOpen();
    // A non-demand probe never changes recency or launches I/O.
    const bucket = demand ? this.touch(commitId) : this.lookup(commitId);
    const cached = this.knownCommit(commitId, bucket);
    if (cached) {
      this.counters.hits++;
      return Promise.resolve(cached);
    }
    if (!demand) return Promise.resolve(undefined);
    return this.read(bucket!, "diff", true) as Promise<PinnedCommit>;
  }

  getFile(commitId: string, path: string): Promise<FileContents> {
    this.assertOpen();
    const bucket = this.touch(commitId);
    const known = this.knownCommit(commitId, bucket);
    const file = known?.files.find((file) => file.path === path);
    if (known && (!file || file.unsupported))
      return Promise.reject(
        new Error(file?.unsupported || "Not a changed file"),
      );
    const cached = bucket.files.get(path);
    if (cached) {
      this.counters.hits++;
      return Promise.resolve(cached.value);
    }
    return this.read(bucket, "file", true, path) as Promise<FileContents>;
  }

  setCandidates(log: LogRow[], selectedCommitId: string): void {
    this.assertOpen();
    const ids = [
      ...new Set(
        log.flatMap((row) => (row.revision ? [row.revision.commitId] : [])),
      ),
    ];
    const signature = JSON.stringify([selectedCommitId, ids]);
    if (signature === this.signature) return;
    const selectedIndex = ids.indexOf(selectedCommitId);
    const ranked = ids
      .map((id, index) => ({ id, index }))
      .filter(({ id }) => id !== selectedCommitId)
      .sort((a, b) =>
        selectedIndex < 0
          ? a.index - b.index
          : Math.abs(a.index - selectedIndex) -
              Math.abs(b.index - selectedIndex) ||
            Number(this.speculative.has(b.id)) -
              Number(this.speculative.has(a.id)) ||
            a.index - b.index,
      )
      .map(({ id }) => id);
    this.signature = signature;
    this.selected = selectedCommitId;
    this.ranks = new Map(
      ids.map((id, index) => [
        id,
        selectedIndex < 0 ? index : Math.abs(index - selectedIndex),
      ]),
    );
    this.ranks.set(selectedCommitId, -1);
    // Freeze the target slots for this candidate generation. Promotion must not
    // immediately refill the vacated slot with a farther eleventh candidate.
    this.targets = ranked
      .filter((id) => !this.demand.has(id))
      .slice(0, this.limits.speculativeCommits);
    for (const [id] of this.speculative) {
      if (!this.targets.includes(id)) {
        this.speculative.delete(id);
        this.counters.speculativeEvictions++;
      }
    }
    for (const id of this.ranks.keys()) {
      if (!this.backgroundCandidate(id)) this.ranks.delete(id);
    }
    this.pruneRejections(true);
    this.schedule();
  }

  setPaused(paused: boolean): void {
    if (this.disposed || paused === this.paused) return;
    this.paused = paused;
    // Pause gates new work only. Already-running immutable reads remain useful
    // while their commit bucket is still retained and eligible.
    this.schedule();
  }

  dispose(): void {
    this.disposed = true;
    this.demand.clear();
    this.speculative.clear();
    this.targets = [];
    this.ranks.clear();
    this.displayed = undefined;
    this.displayedBytes = 0;
    this.rejected.clear();
    this.suppressed.clear();
    // Loaders need not support cancellation. Existing callers still resolve,
    // but completions cannot repopulate a disposed store.
  }

  snapshot() {
    const pool = (map: Map<string, Bucket>) => ({
      entries: map.size,
      commits: [...map.keys()],
      diffBytes: this.bytes(map, "diff"),
      fileBytes: this.bytes(map, "file"),
      files: [...map.values()].reduce((n, bucket) => n + bucket.files.size, 0),
    });
    return {
      ...this.counters,
      demand: pool(this.demand),
      speculative: pool(this.speculative),
      inflight: this.inflight.size,
      demandActive: this.demandActive,
      backgroundActive: this.background ? 1 : 0,
      reservedBytes: this.background
        ? this.reservation(this.background.kind)
        : 0,
      externalDisplayedBytes: this.externalDisplayedBytes(),
      targets: [...this.targets],
      rejectedTasks: this.rejected.size + this.suppressed.size,
      rejectedTaskEntries: this.rejected.size,
      rejectedTaskBytes: this.rejectionTaskBytes(),
      suppressedCommits: this.suppressed.size,
      rejectionMetadataBytes:
        this.rejectionTaskBytes() +
        [...this.suppressed.keys()].reduce(
          (bytes, id) => bytes + this.rejectionBytes(id),
          0,
        ),
      paused: this.paused,
      disposed: this.disposed,
    };
  }

  private assertOpen() {
    if (this.disposed) throw new Error("ContentStore is disposed");
  }

  private lookup(id: string) {
    return this.demand.get(id) ?? this.speculative.get(id);
  }

  private create(id: string): Bucket {
    return { id, diffBytes: 0, files: new Map() };
  }

  private touch(id: string, shrink = true): Bucket {
    const bucket = this.lookup(id) ?? this.create(id);
    this.speculative.delete(id);
    this.demand.delete(id);
    this.demand.set(id, bucket);
    while (this.demand.size > this.limits.demandCommits) {
      const oldest = this.demand.keys().next().value!;
      this.demand.delete(oldest);
      this.counters.demandEvictions++;
    }
    // Promotion transfers the same bucket, not its contents. A large speculative
    // bucket can exceed smaller custom demand limits; trim without a new fetch.
    this.trimDemand("diff", bucket);
    this.trimDemand("file", bucket);
    if (shrink) this.shrinkSpeculation();
    this.pruneRejections(false);
    return bucket;
  }

  private bytes(pool: Map<string, Bucket>, kind: Kind): number {
    let bytes = 0;
    for (const bucket of pool.values()) {
      bytes +=
        kind === "diff"
          ? bucket.diffBytes
          : [...bucket.files.values()].reduce(
              (sum, file) => sum + file.bytes,
              0,
            );
    }
    return bytes;
  }

  private knownCommit(id: string, bucket = this.lookup(id)) {
    return (
      bucket?.commit ??
      (this.displayed?.commitId === id ? this.displayed : undefined)
    );
  }

  private externalDisplayedBytes() {
    return this.displayed && !this.lookup(this.displayed.commitId)?.commit
      ? this.displayedBytes
      : 0;
  }

  private totalHeadroom() {
    return (
      this.limits.demandDiffBytes +
      this.limits.demandFileBytes +
      this.limits.speculativeDiffBytes +
      this.limits.speculativeFileBytes -
      this.bytes(this.demand, "diff") -
      this.bytes(this.demand, "file") -
      this.bytes(this.speculative, "diff") -
      this.bytes(this.speculative, "file") -
      this.externalDisplayedBytes()
    );
  }

  private shrinkSpeculation() {
    // Only explicit demand/confirmed display can displace speculative capacity.
    // Remember removals so the scheduler doesn't refill them on its next turn.
    for (const id of [...this.targets].reverse()) {
      if (this.totalHeadroom() >= 0) break;
      if (this.speculative.delete(id)) {
        this.counters.speculativeEvictions++;
        this.reject(this.key(id, "diff"));
      }
    }
  }

  private budget(demand: boolean, kind: Kind) {
    return demand
      ? kind === "diff"
        ? this.limits.demandDiffBytes
        : this.limits.demandFileBytes
      : kind === "diff"
        ? this.limits.speculativeDiffBytes
        : this.limits.speculativeFileBytes;
  }

  private reservation(kind: Kind) {
    return kind === "diff"
      ? this.limits.diffReservationBytes
      : this.limits.fileReservationBytes;
  }

  private maximum(kind: Kind) {
    return kind === "diff"
      ? this.limits.maxDiffBytes
      : this.limits.maxFileBytes;
  }

  private clearKind(bucket: Bucket, kind: Kind) {
    if (kind === "diff") {
      bucket.commit = undefined;
      bucket.diffBytes = 0;
    } else bucket.files.clear();
  }

  private trimDemand(kind: Kind, protect: Bucket) {
    for (const bucket of this.demand.values()) {
      if (this.bytes(this.demand, kind) <= this.budget(true, kind)) break;
      if (bucket !== protect) this.clearKind(bucket, kind);
    }
    if (this.bytes(this.demand, kind) > this.budget(true, kind))
      this.clearKind(protect, kind);
  }

  private key(id: string, kind: Kind, path?: string) {
    return JSON.stringify([id, kind, path]);
  }

  private rank(id: string) {
    return id === this.selected ? -1 : (this.ranks.get(id) ?? Infinity);
  }

  private headroom(id: string, kind: Kind) {
    const demanded = this.demand.has(id);
    return Math.min(
      this.budget(demanded, kind) -
        this.bytes(demanded ? this.demand : this.speculative, kind),
      this.totalHeadroom(),
    );
  }

  private backgroundCandidate(id: string) {
    return (
      this.targets.includes(id) || (id === this.selected && this.demand.has(id))
    );
  }

  private rejectionBytes(key: string) {
    return key.length * 2 + 64;
  }

  private rejectionTaskBytes() {
    let bytes = 0;
    for (const key of this.rejected.keys()) bytes += this.rejectionBytes(key);
    return bytes;
  }

  private pruneRejections(retryImproved: boolean) {
    const obsolete = (
      id: string,
      kind: Kind,
      condition: { rank: number; headroom: number },
    ) =>
      !this.backgroundCandidate(id) ||
      (retryImproved &&
        (this.rank(id) < condition.rank ||
          this.headroom(id, kind) > condition.headroom));
    for (const [key, condition] of this.rejected) {
      const [id, kind] = JSON.parse(key) as [string, Kind];
      if (obsolete(id, kind, condition)) this.rejected.delete(key);
    }
    for (const [id, condition] of this.suppressed) {
      if (obsolete(id, condition.kind, condition)) this.suppressed.delete(id);
    }
  }

  private suppress(id: string, kind: Kind) {
    if (
      this.disposed ||
      !this.backgroundCandidate(id) ||
      this.suppressed.has(id)
    )
      return;
    this.counters.rejected++;
    this.suppressed.set(id, {
      kind,
      rank: this.rank(id),
      headroom: this.headroom(id, kind),
    });
    // One bounded commit marker replaces path tombstones, without forgetting
    // failures and accidentally restarting the same fetch/rejection sequence.
    for (const key of this.rejected.keys()) {
      if ((JSON.parse(key) as [string])[0] === id) this.rejected.delete(key);
    }
  }

  private reject(key: string) {
    const [id, kind] = JSON.parse(key) as [string, Kind];
    if (
      this.disposed ||
      !this.backgroundCandidate(id) ||
      this.suppressed.has(id)
    )
      return;
    if (!this.rejected.has(key)) {
      if (
        this.rejected.size >= this.limits.maxRejectedTasks ||
        this.rejectionTaskBytes() + this.rejectionBytes(key) >
          this.limits.maxRejectedBytes
      ) {
        this.suppress(id, kind);
        return;
      }
      this.counters.rejected++;
    }
    this.rejected.set(key, {
      rank: this.rank(id),
      headroom: this.headroom(id, kind),
    });
    if (
      this.rejected.size >= this.limits.maxRejectedTasks ||
      this.rejectionTaskBytes() >= this.limits.maxRejectedBytes
    )
      this.suppress(id, kind);
  }

  private eligible(bucket: Bucket) {
    return (
      this.lookup(bucket.id) === bucket &&
      (this.targets.includes(bucket.id) || this.demand.has(bucket.id))
    );
  }

  private admit(
    bucket: Bucket,
    kind: Kind,
    value: PinnedCommit | FileContents,
    evict: boolean,
    path?: string,
  ) {
    if (this.disposed || this.lookup(bucket.id) !== bucket) return false;
    const demanded = this.demand.has(bucket.id);
    const bytes = contentBytes(value);
    const pool = demanded ? this.demand : this.speculative;
    const previous =
      kind === "diff"
        ? bucket.diffBytes
        : (bucket.files.get(path!)?.bytes ?? 0);
    if (bytes > this.maximum(kind) || bytes > this.budget(demanded, kind))
      return false;
    // Background admission may use free demand capacity (selected commit), but
    // may NEVER evict/touch the browsing LRU, including after task promotion.
    if (
      (!demanded || !evict) &&
      this.bytes(pool, kind) - previous + bytes > this.budget(demanded, kind)
    )
      return false;
    if (!evict && bytes - previous > this.totalHeadroom()) return false;
    if (kind === "diff") {
      bucket.commit ??= value as PinnedCommit;
      bucket.diffBytes = contentBytes(bucket.commit);
    } else bucket.files.set(path!, { value: value as FileContents, bytes });
    if (demanded && evict) {
      this.trimDemand(kind, bucket);
      this.shrinkSpeculation();
    }
    return true;
  }

  private read(
    bucket: Bucket,
    kind: Kind,
    demand: boolean,
    path?: string,
  ): Promise<PinnedCommit | FileContents> {
    const key = this.key(bucket.id, kind, path);
    const existing = this.inflight.get(key);
    if (existing) {
      this.counters.deduplicated++;
      if (demand && !existing.demand) {
        existing.demand = true;
        this.demandActive++;
      }
      // An earlier demand bucket may have been evicted while its read ran.
      if (demand) existing.bucket = bucket;
      return existing.promise;
    }
    const task: Task = {
      key,
      bucket,
      kind,
      path,
      demand,
      promise: undefined!,
    };
    if (demand) this.demandActive++;
    else this.background = task;
    this.inflight.set(key, task);
    if (kind === "diff") this.counters.commitFetches++;
    else this.counters.fileFetches++;
    // Deferring invocation catches synchronous loader throws and installs the
    // in-flight entry before any user-supplied loader executes.
    task.promise = Promise.resolve()
      .then<PinnedCommit | FileContents>(() =>
        kind === "diff"
          ? this.loaders.loadCommit(bucket.id)
          : this.loaders.loadFile(bucket.id, path!),
      )
      .then((value) => {
        if (kind === "diff" && (value as PinnedCommit).commitId !== bucket.id)
          throw new Error("Pinned commit response identity mismatch");
        const current = task.bucket;
        const valid = task.demand || this.eligible(current);
        if (this.disposed || !valid) this.counters.discarded++;
        else if (!this.admit(current, kind, value, task.demand, path))
          this.reject(key);
        return value;
      })
      .catch((error: unknown) => {
        if (!task.demand) this.reject(key);
        throw error;
      })
      .finally(() => {
        this.inflight.delete(key);
        if (task.demand) this.demandActive--;
        if (this.background === task) this.background = undefined;
        this.schedule();
      });
    return task.promise;
  }

  private schedule() {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.pump();
    });
  }

  private pump() {
    if (this.disposed || this.paused || this.background || this.demandActive)
      return;
    this.pruneRejections(false);
    const ids = [
      ...(this.demand.has(this.selected) ? [this.selected] : []),
      ...this.targets,
    ];
    for (const id of ids) {
      if (this.suppressed.has(id)) continue;
      let bucket = this.lookup(id);
      if (!bucket) {
        if (this.speculative.size >= this.limits.speculativeCommits) return;
        bucket = this.create(id);
      }
      const known = this.knownCommit(id, bucket);
      for (const file of known ? known.files : [undefined]) {
        if (file && (file.unsupported || bucket.files.has(file.path))) continue;
        const kind: Kind = file ? "file" : "diff";
        const path = file?.path;
        const key = this.key(id, kind, path);
        if (this.rejected.has(key) || this.inflight.has(key)) continue;
        const demanded = this.demand.has(id);
        const pool = demanded ? this.demand : this.speculative;
        if (
          this.bytes(pool, kind) + this.reservation(kind) >
            this.budget(demanded, kind) ||
          this.reservation(kind) > this.totalHeadroom()
        ) {
          // All remaining files share this exhausted budget/reservation. Do
          // not allocate one rejected path string for every file in the diff.
          this.suppress(id, kind);
          break;
        }
        if (!this.lookup(id)) this.speculative.set(id, bucket);
        void this.read(bucket, kind, false, path).catch(() => {
          // Prefetch failures are optional misses, never global review errors.
        });
        return;
      }
    }
  }
}
