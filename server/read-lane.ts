import { ApiError } from "./errors.ts";

/** Separate, deliberately small admission budget for speculative display work. */
export class ReadLane {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly pending = new Set<Promise<unknown>>();

  run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= 2 && this.waiting.length >= 16)
      return Promise.reject(
        new ApiError(
          503,
          "BUSY",
          "The display read queue is full. Try again later.",
        ),
      );
    const admitted = new Promise<void>((resolve) => {
      if (this.active < 2) {
        this.active++;
        resolve();
      } else this.waiting.push(resolve);
    });
    const result = admitted.then(task).finally(() => {
      this.pending.delete(result);
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    });
    this.pending.add(result);
    return result;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
