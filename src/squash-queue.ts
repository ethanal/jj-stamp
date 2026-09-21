import {
  changeSignature,
  projectSquash,
  specsForRefs,
  type RowRef,
  type SquashSpec,
} from "./optimistic";
import type { RepoState } from "./types";

export interface SquashTransport {
  squash(input: {
    version: string;
    selections: SquashSpec[];
  }): Promise<{ state: RepoState; warning?: string }>;
  readState(): Promise<RepoState>;
}
export interface Snapshot {
  confirmed: RepoState | null;
  view: RepoState | null;
  pending: number;
  recovering: boolean;
  halted: boolean;
  error: string;
  notice: string;
  epoch: number;
}
interface Job {
  refs: RowRef[];
  beforeSignature: string;
  count: number;
}
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** In-memory FIFO. Each mutation is sent at most once, against an acknowledged version. */
export class SquashQueue {
  private snapshot: Snapshot = {
    confirmed: null,
    view: null,
    pending: 0,
    recovering: false,
    halted: false,
    error: "",
    notice: "",
    epoch: 0,
  };
  private jobs: Job[] = [];
  private listeners = new Set<() => void>();
  private draining = false;

  constructor(private readonly transport: SquashTransport) {}

  getSnapshot = (): Snapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private publish(update: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...update };
    // Snapshot the listener set: subscriptions added during notification wait until
    // the next update. A broken observer must never interrupt an in-flight mutation.
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("Squash queue subscriber failed", error);
      }
    }
  }

  replace(state: RepoState): void {
    if (this.jobs.length || this.snapshot.recovering)
      throw new Error(
        "Wait for pending squashes and recovery before replacing repository state.",
      );
    this.publish({
      confirmed: state,
      view: state,
      pending: 0,
      recovering: false,
      halted: false,
      error: "",
      notice: "",
      epoch: this.snapshot.epoch + 1,
    });
  }

  clearError(): void {
    // Dismissing a message is not permission to resume or retry a failed mutation.
    this.publish({ error: "" });
  }

  enqueue(refs: RowRef[]): void {
    const { view, halted, recovering } = this.snapshot;
    if (halted || recovering)
      throw new Error(
        "Squashing is paused. Refresh or undo before continuing; failed squashes are never retried.",
      );
    if (!view) throw new Error("Load repository state before squashing.");
    if (!refs.length)
      throw new Error("Select at least one changed line to squash.");
    // Validate and finish projection before changing any queue state.
    const saved = refs.map((ref) => ({ ...ref }));
    const beforeSignature = changeSignature(view);
    const projected = projectSquash(view, saved);
    this.jobs.push({ refs: saved, beforeSignature, count: saved.length });
    this.publish({
      view: projected,
      pending: this.jobs.length,
      error: "",
      notice: "",
      epoch: this.snapshot.epoch + 1,
    });
    // No global dispatch lock: subsequent selections can enqueue while squash awaits.
    if (!this.draining) void this.drain();
  }

  private stopAtKnownState(state: RepoState, error: string): void {
    this.jobs = [];
    this.publish({
      confirmed: state,
      view: state,
      pending: 0,
      recovering: false,
      halted: true,
      error,
      notice: "",
      epoch: this.snapshot.epoch + 1,
    });
  }

  private async recover(error: unknown): Promise<void> {
    this.jobs = [];
    const explanation = `Squash stopped: ${message(error)} No queued squashes were retried. Refresh or undo before continuing.`;
    // Do not leave speculative edits visible while a potentially slow GET runs.
    this.publish({
      view: this.snapshot.confirmed,
      pending: 0,
      recovering: true,
      halted: true,
      error: explanation,
      notice: "",
      epoch: this.snapshot.epoch + 1,
    });
    try {
      // Serialized after the failed POST; this GET is attempted exactly once.
      const fresh = await this.transport.readState();
      this.publish({
        confirmed: fresh,
        view: fresh,
        recovering: false,
        epoch: this.snapshot.epoch + 1,
      });
    } catch (refreshError) {
      this.publish({
        view: this.snapshot.confirmed,
        recovering: false,
        error: `${explanation} Reload also failed: ${message(refreshError)} Showing the last confirmed state; repository state is uncertain.`,
      });
    }
  }

  private async drain(): Promise<void> {
    this.draining = true;
    try {
      while (this.jobs.length) {
        const job = this.jobs[0];
        const confirmed = this.snapshot.confirmed;
        if (!confirmed || changeSignature(confirmed) !== job.beforeSignature)
          throw new Error(
            "Queued selection no longer matches the confirmed changes.",
          );
        const selections = specsForRefs(confirmed, job.refs);
        const expected = projectSquash(confirmed, job.refs);
        const result = await this.transport.squash({
          version: confirmed.version,
          selections,
        });
        if (
          result.warning ||
          changeSignature(result.state) !== changeSignature(expected)
        ) {
          this.stopAtKnownState(
            result.state,
            result.warning
              ? `Squash completed with a warning: ${result.warning} Queued squashes were canceled. Refresh or undo before continuing.`
              : "Squash result differed from the projected changes. Queued squashes were canceled. Refresh or undo before continuing.",
          );
          return;
        }
        this.jobs.shift();
        const idle = this.jobs.length === 0;
        // Keep the rendered files AND epoch stable across acknowledgements. The
        // user may be dragging a new range against these original projected IDs.
        const view = idle
          ? { ...result.state, files: this.snapshot.view!.files }
          : this.snapshot.view;
        this.publish({
          confirmed: result.state,
          view,
          pending: this.jobs.length,
          notice: idle
            ? `${job.count} ${job.count === 1 ? "line" : "lines"} squashed.`
            : "",
        });
      }
    } catch (error) {
      await this.recover(error);
    } finally {
      this.draining = false;
      // A subscriber can explicitly replace/re-enqueue when recovery completes.
      if (this.jobs.length && !this.snapshot.halted) void this.drain();
    }
  }
}
