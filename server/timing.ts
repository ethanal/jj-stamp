import { performance } from "node:perf_hooks";

export type OperationName =
  | "state"
  | "revision"
  | "graph"
  | "log"
  | "editor"
  | "file"
  | "squash-lines"
  | "preview"
  | "squash"
  | "undo";

export interface SubprocessTiming {
  name: string;
  /** Milliseconds from the serialized task's start, not from enqueue time. */
  startMs: number;
  durationMs: number;
  ok: boolean;
}
export interface OperationTiming {
  /** Monotonically increasing, local to this service instance. */
  id: number;
  name: OperationName;
  queueMs: number;
  /** Execution time only; excludes queue wait and observer execution. */
  durationMs: number;
  ok: boolean;
  /** In invocation order, which may differ from completion order. */
  subprocesses: SubprocessTiming[];
}
export type TimingObserver = (record: OperationTiming) => void;

// Only fixed, allowlisted labels leave the service. Never include arbitrary
// command names, arguments, repository paths, output, or exception messages.
export function jjTimingName(args: string[]): string {
  if (args[0] === "op") {
    if (args[1] === "log") return "jj op log";
    if (args[1] === "revert") return "jj op revert";
  }
  if (args[0] === "file" && args[1] === "show") return "jj file show";
  switch (args[0]) {
    case "root":
      return "jj root";
    case "log": {
      const mode = args.includes("--at-operation")
        ? "pinned"
        : args.includes("--ignore-working-copy")
          ? "recorded"
          : "snapshot";
      const revsetIndex = args.indexOf("-r");
      const kind =
        revsetIndex >= 0 && args[revsetIndex + 1] === "conflicts()"
          ? "conflicts"
          : args.includes("--no-graph")
            ? "metadata"
            : "graph";
      return `jj log ${kind} (${mode})`;
    }
    case "diff":
      return "jj diff";
    case "status":
      return "jj status";
    default:
      return "jj";
  }
}
export function toolTimingName(args: string[]): string {
  // The only separately instrumented tool is jj's history-writing squash.
  return args[0] === "squash" ? "jj squash (native editor)" : "jj";
}

/** Opt-in instrumentation, not a scheduler. The service must drain every
 * subprocess (including failed parallel reads) before advancing its queue. */
export class ServiceTiming {
  private nextId = 0;
  private current?: { start: number; record: OperationTiming };

  constructor(
    private readonly observer: TimingObserver,
    private readonly now: () => number = () => performance.now(),
  ) {}

  task<T>(name: OperationName, task: () => Promise<T>): () => Promise<T> {
    const id = ++this.nextId;
    const enqueued = this.now();
    return async () => {
      const start = this.now();
      const record: OperationTiming = {
        id,
        name,
        queueMs: start - enqueued,
        durationMs: 0,
        ok: false,
        subprocesses: [],
      };
      this.current = { start, record };
      try {
        const result = await task();
        record.ok = true;
        return result;
      } finally {
        record.durationMs = this.now() - start;
        this.current = undefined;
        // Diagnostics must never turn an attributed mutation into a failure.
        // Also absorb async observer failures without delaying the queue.
        try {
          void Promise.resolve(this.observer(record)).catch(() => undefined);
        } catch {
          // Deliberately do not log observer errors (which may contain data).
        }
      }
    };
  }

  wrap<Args extends unknown[], Result>(
    runner: (...args: Args) => Promise<Result>,
    name: (...args: Args) => string,
  ): (...args: Args) => Promise<Result> {
    const timing = this;
    return function (this: unknown, ...args: Args): Promise<Result> {
      const current = timing.current;
      if (!current) return runner.apply(this, args);
      const start = timing.now();
      const record: SubprocessTiming = {
        name: name(...args),
        startMs: start - current.start,
        durationMs: 0,
        ok: false,
      };
      current.record.subprocesses.push(record);
      const finish = (ok: boolean) => {
        record.durationMs = timing.now() - start;
        record.ok = ok;
      };
      try {
        return runner.apply(this, args).then(
          (result) => {
            finish(true);
            return result;
          },
          (error: unknown) => {
            finish(false);
            throw error;
          },
        );
      } catch (error) {
        finish(false);
        throw error;
      }
    };
  }
}
