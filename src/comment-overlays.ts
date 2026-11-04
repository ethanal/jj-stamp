import type { ReviewCommentOverlay } from "./review-comments";

/** Live overlays never enter the immutable code-content cache. */
export class CommentOverlays {
  private version = "";
  private generation = 0;
  private running = 0;
  private pending = new Map<string, Promise<ReviewCommentOverlay>>();
  private cached = new Map<
    string,
    { value: ReviewCommentOverlay; bytes: number }
  >();
  private bytes = 0;
  private waiting: Array<{
    version: string;
    generation: number;
    path: string;
    resolve(value: ReviewCommentOverlay): void;
    reject(error: unknown): void;
  }> = [];

  constructor(
    private load: (
      path: string,
      version: string,
    ) => Promise<ReviewCommentOverlay>,
  ) {}

  get(path: string, version: string): Promise<ReviewCommentOverlay> {
    if (this.version !== version) {
      this.version = version;
      this.generation++;
      this.cached.clear();
      this.pending.clear();
      this.bytes = 0;
      for (const task of this.waiting)
        task.reject(
          new Error("The comment view changed; refresh its overlays."),
        );
      this.waiting = [];
    }
    const cached = this.cached.get(path);
    if (cached) {
      this.cached.delete(path);
      this.cached.set(path, cached);
      return Promise.resolve(cached.value);
    }
    const pending = this.pending.get(path);
    if (pending) return pending;
    if (this.waiting.length >= 256)
      return Promise.reject(
        new Error("Too many comment files to load at once; use One file view."),
      );
    const promise = new Promise<ReviewCommentOverlay>((resolve, reject) => {
      this.waiting.push({
        path,
        version,
        generation: this.generation,
        resolve,
        reject,
      });
    });
    this.pending.set(path, promise);
    this.drain();
    return promise;
  }

  private drain() {
    while (this.running < 2 && this.waiting.length) {
      const task = this.waiting.shift()!;
      this.running++;
      void Promise.resolve()
        .then(() => this.load(task.path, task.version))
        .then((value) => {
          if (this.generation === task.generation) {
            const bytes = JSON.stringify(value).length * 2;
            if (bytes <= 4 * 1024 * 1024) {
              this.cached.set(task.path, { value, bytes });
              this.bytes += bytes;
              while (this.cached.size > 32 || this.bytes > 4 * 1024 * 1024) {
                const oldest = this.cached.keys().next().value!;
                this.bytes -= this.cached.get(oldest)!.bytes;
                this.cached.delete(oldest);
              }
            }
          }
          task.resolve(value);
        }, task.reject)
        .finally(() => {
          if (this.generation === task.generation)
            this.pending.delete(task.path);
          this.running--;
          this.drain();
        });
    }
  }
}
