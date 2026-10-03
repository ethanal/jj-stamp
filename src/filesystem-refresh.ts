import type { RepositoryChange } from "./types";

interface Options {
  eligible(): boolean;
  operation(): string | undefined;
  /** False means foreground work overtook the read; retain the invalidation. */
  refresh(): Promise<boolean>;
}

/** One trailing-edge check per filesystem burst; no timers or reads while idle. */
export class FilesystemRefresh {
  private pending: RepositoryChange | undefined;
  private due = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private disposed = false;

  constructor(private readonly options: Options) {}

  changed(change: RepositoryChange): void {
    if (this.disposed) return;
    this.pending = {
      workspace: change.workspace || !!this.pending?.workspace,
      heads: change.heads,
    };
    this.due = Date.now() + 1_000;
    this.wake();
  }

  /** Call when focus, dragging, or operation/queue eligibility changes. */
  wake(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (
      this.disposed ||
      !this.pending ||
      this.inFlight ||
      !this.options.eligible()
    )
      return;
    this.timer = setTimeout(
      () => void this.flush(),
      Math.max(0, this.due - Date.now()),
    );
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    if (this.disposed || !this.pending || !this.options.eligible()) return;
    const change = this.pending;
    this.pending = undefined;
    // Acknowledged app operations (including a refresh's own snapshot) need no
    // second state read. Workspace edits cannot be acknowledged by op ID alone.
    if (
      !change.workspace &&
      change.heads?.length === 1 &&
      change.heads[0] === this.options.operation()
    )
      return;
    this.inFlight = true;
    try {
      if (!(await this.options.refresh()) && !this.disposed) {
        this.retain(change);
        this.due = Math.max(this.due, Date.now() + 1_000);
      }
    } catch {
      // No timer-based retry loop or noisy background alerts. The next change,
      // reconnection, focus, or explicit refresh can revalidate repository state.
    } finally {
      this.inFlight = false;
      this.wake();
    }
  }

  private retain(change: RepositoryChange): void {
    this.pending = {
      workspace: change.workspace || !!this.pending?.workspace,
      heads: this.pending ? this.pending.heads : change.heads,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    clearTimeout(this.timer);
  }
}

export function parseRepositoryChange(data: string): RepositoryChange | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object") return null;
    const change = value as Partial<RepositoryChange>;
    if (
      typeof change.workspace !== "boolean" ||
      (change.heads !== null &&
        (!Array.isArray(change.heads) ||
          change.heads.length > 64 ||
          !change.heads.every(
            (head) =>
              typeof head === "string" && /^[0-9a-f]{32,128}$/.test(head),
          )))
    )
      return null;
    return { workspace: change.workspace, heads: change.heads };
  } catch {
    return null;
  }
}
