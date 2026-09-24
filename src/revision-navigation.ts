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
  private disposed = false;
  private inFlight: string | null = null;
  private pending: string | null = null;

  constructor(private readonly options: RevisionNavigationOptions) {}

  /**
   * initialVersion starts an idle drain only. While busy, even an undisplayed
   * intermediate response supplies the next POST's authoritative version.
   * onIntent is synchronous; callers must guard their own async preview reads.
   */
  request(changeId: string, initialVersion: string): void {
    if (this.disposed) return;
    // Reselecting the in-flight revision also cancels a different queued intent.
    this.pending = changeId === this.inFlight ? null : changeId;
    const starting = !this.busy;
    this.busy = true;
    this.options.onIntent?.(changeId);
    if (!starting || this.disposed) return;
    this.options.onBusy(true);
    void this.drain(initialVersion);
  }

  /** Suppress future publications/dispatches, without aborting a stateful POST. */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
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
      this.busy = false;
      if (!this.disposed) this.options.onBusy(false);
    }
  }
}
