import type { IPty } from "node-pty";
import nodePtyPackage from "node-pty/package.json" with { type: "json" };

export const MAX_PTY_INPUT_BACKLOG = 256 * 1024;
export const MAX_PTY_INPUT_TASKS = 1024;

export class PtyInputCompatibilityError extends Error {
  constructor() {
    super("Terminal input requires the audited node-pty 1.1.0 POSIX writer.");
  }
}

export class PtyInputBacklogError extends Error {
  constructor(taskLimit = false) {
    super(
      taskLimit
        ? "Terminal input backlog exceeded 1024 pending writes; session closed."
        : "Terminal input backlog exceeded 256 KiB; session closed.",
    );
  }
}

interface WriteTask {
  buffer: Buffer;
  offset: number;
}

interface NativeWriter {
  _writeQueue: WriteTask[];
  _processWriteQueue(): void;
  write(data: string | Buffer): void;
  dispose(): void;
}

function writerOf(terminal: IPty): NativeWriter {
  const writer = (terminal as unknown as { _writeStream?: NativeWriter })
    ._writeStream;
  if (
    !writer ||
    !Array.isArray(writer._writeQueue) ||
    typeof writer._processWriteQueue !== "function" ||
    typeof writer.write !== "function" ||
    typeof writer.dispose !== "function"
  )
    throw new PtyInputCompatibilityError();
  return writer;
}

/**
 * Audited against node-pty 1.1.0 lib/unixTerminal.js CustomWriteStream.
 *
 * IPty.write() returns void and has no drain/backlog API. Its POSIX writer
 * keeps every fs.write task (including the in-flight one) in _writeQueue,
 * advancing offset only after the write callback reports bytes accepted by
 * the kernel. Inspecting those actual offsets gives a conservative bound;
 * elapsed time, terminal output and the WebSocket rate limit do not.
 *
 * The private contract is deliberately isolated and exact-version/shape
 * guarded. Dependency upgrades need a new audit; unsupported writers fail
 * closed rather than silently reintroducing an unbounded queue.
 */
export class BoundedPtyInput {
  private readonly writer: NativeWriter;
  private disposed = false;

  constructor(private readonly terminal: IPty) {
    if (nodePtyPackage.version !== "1.1.0" || process.platform === "win32")
      throw new PtyInputCompatibilityError();
    this.writer = writerOf(terminal);
    void this.pendingBytes;
  }

  get pendingBytes(): number {
    if (this.disposed) return 0;
    if (writerOf(this.terminal) !== this.writer)
      throw new PtyInputCompatibilityError();
    if (this.writer._writeQueue.length > MAX_PTY_INPUT_TASKS)
      throw new PtyInputBacklogError(true);
    let pending = 0;
    for (const task of this.writer._writeQueue) {
      if (
        !task ||
        !Buffer.isBuffer(task.buffer) ||
        !Number.isSafeInteger(task.offset) ||
        task.offset < 0 ||
        task.offset > task.buffer.byteLength
      )
        throw new PtyInputCompatibilityError();
      pending += task.buffer.byteLength - task.offset;
      if (pending > MAX_PTY_INPUT_BACKLOG) throw new PtyInputBacklogError();
    }
    return pending;
  }

  write(data: string): void {
    if (this.disposed) return;
    const pending = this.pendingBytes;
    if (
      data.length > 0 &&
      this.writer._writeQueue.length >= MAX_PTY_INPUT_TASKS
    ) {
      this.dispose();
      throw new PtyInputBacklogError(true);
    }
    if (pending + Buffer.byteLength(data, "utf8") > MAX_PTY_INPUT_BACKLOG) {
      this.dispose();
      throw new PtyInputBacklogError();
    }
    this.terminal.write(data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Stock dispose cancels a scheduled EAGAIN retry but leaves its buffers.
    // Empty the SAME queue synchronously as well. An already-issued fs.write
    // cannot be recalled, but its callback will find no further tasks; even
    // a late EAGAIN retry observes the empty queue and writes nothing.
    this.writer._writeQueue.length = 0;
    this.writer.dispose();
  }
}
