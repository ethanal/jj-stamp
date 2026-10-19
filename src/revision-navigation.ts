import type { RepoState } from "./types.ts";

export interface RevisionNavigationOptions {
  select: (version: string, changeId: string) => Promise<{ state: RepoState }>;
  onState: (state: RepoState) => void;
  onBusy: (busy: boolean) => void;
  onError: (error: unknown) => void;
  onIntent?: (changeId: string) => void;
}

/** Serializes stateful revision selections, retaining only the latest unsent intent. */
export class RevisionNavigation {
  private busy = false;
  private draining = false;
  private disposed = false;
  private generation = 0;
  private requestDepth = 0;
  private resumeVersion: string | null = null;
  private inFlight: string | null = null;
  private pending: string | null = null;

  constructor(private readonly options: RevisionNavigationOptions) {}

  /**
   * A null initialVersion defers dispatch until resume supplies an authoritative
   * version. A non-null version starts an idle or deferred drain. Once draining,
   * even an undisplayed response supplies the next POST's authoritative version.
   * onIntent is synchronous; callers must guard their own async preview reads.
   */
  request(changeId: string, initialVersion: string | null): void {
    if (this.disposed) return;
    // Reselecting the in-flight revision also cancels a different queued intent.
    this.pending = changeId === this.inFlight ? null : changeId;
    const starting = !this.busy;
    if (starting) {
      this.busy = true;
      this.generation++;
    }
    const generation = this.generation;
    this.requestDepth++;
    try {
      this.options.onIntent?.(changeId);
      // Callbacks may cancel this intent and create a different deferred drain.
      if (this.disposed || !this.busy || generation !== this.generation) return;
      if (starting) this.options.onBusy(true);
      if (generation === this.generation && initialVersion !== null)
        this.resume(initialVersion);
    } finally {
      this.requestDepth--;
      // A reentrant resume must not dispatch before synchronous intent/busy
      // notifications finish, or start a second drain from the outer request.
      if (this.requestDepth === 0 && this.resumeVersion !== null) {
        const version = this.resumeVersion;
        this.resumeVersion = null;
        if (!this.disposed) void this.drain(version);
      }
    }
  }

  /** Start deferred work once a fresh authoritative version is available. */
  resume(version: string): void {
    if (this.disposed || !this.busy || this.draining) return;
    this.draining = true;
    if (this.requestDepth > 0) this.resumeVersion = version;
    else void this.drain(version);
  }

  /** Cancel only deferred work; a dispatched POST and its chain cannot abort. */
  cancelDeferred(): boolean {
    if (this.disposed || !this.busy || this.draining) return false;
    this.pending = null;
    this.busy = false;
    this.options.onBusy(false);
    return true;
  }

  /** Suppress future publications/dispatches, without aborting a stateful POST. */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.resumeVersion = null;
  }

  private async drain(version: string): Promise<void> {
    let lastSuccessful: RepoState | undefined;
    try {
      while (!this.disposed && this.pending !== null) {
        const changeId = this.pending;
        this.pending = null;
        this.inFlight = changeId;
        let state: RepoState;
        try {
          ({ state } = await this.options.select(version, changeId));
        } catch (error) {
          if (this.disposed) return;
          this.pending = null;
          this.inFlight = null;
          // Earlier selections really happened, even though we skipped rendering
          // them. Restore the last acknowledgement, but still report uncertainty
          // about the failed POST: never retry it or replay the remaining intent.
          if (lastSuccessful) this.options.onState(lastSuccessful);
          if (!this.disposed) this.options.onError(error);
          return;
        }
        if (this.disposed) return;
        lastSuccessful = state;
        version = state.version;
        this.inFlight = null;
        if (this.pending === null) this.options.onState(state);
      }
    } finally {
      this.pending = null;
      this.inFlight = null;
      this.draining = false;
      this.busy = false;
      if (!this.disposed) this.options.onBusy(false);
    }
  }
}
