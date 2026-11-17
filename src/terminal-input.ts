export interface TerminalInputMessage {
  type: "input";
  data: string;
}

export interface TerminalInputQueueOptions {
  /** Monotonic milliseconds. Injectable together with schedule for tests. */
  now?: () => number;
  /** Schedule one callback; return its cancellation function. */
  schedule?: (callback: () => void, milliseconds: number) => () => void;
}

const MAX_PENDING_BYTES = 1024 * 1024;
const FRAME_CHARS = 4096;
const BYTE_BURST = 32 * 1024;
const BYTES_PER_MS = (32 * 1024) / 1000;
// Small key events must also stay below the server's 512-message/second limit.
const MESSAGE_BURST = 128;
const MESSAGES_PER_MS = 256 / 1000;
const encoder = new TextEncoder();

interface Frame {
  message: TerminalInputMessage;
  bytes: number;
}

/** A connection-local, bounded input queue. Enqueues are accepted atomically:
 * overflow rejects that entire paste before sending any of its bytes, leaving
 * already accepted input untouched. dispose() drops pending input, never replays
 * it into a new shell. A throwing send callback also disposes without retry.
 */
export class TerminalInputQueue {
  private readonly now: () => number;
  private readonly schedule: NonNullable<TerminalInputQueueOptions["schedule"]>;
  private frames: Frame[] = [];
  private head = 0;
  private pendingBytes = 0;
  private bytes = BYTE_BURST;
  private messages = MESSAGE_BURST;
  private lastRefill: number;
  private cancelTick?: () => void;
  private disposed = false;

  constructor(
    private readonly send: (message: TerminalInputMessage) => void,
    private readonly fail: (message: string) => void,
    options: TerminalInputQueueOptions = {},
  ) {
    this.now = options.now ?? (() => performance.now());
    this.schedule =
      options.schedule ??
      ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds);
        return () => clearTimeout(timer);
      });
    this.lastRefill = this.now();
  }

  enqueue(data: string): boolean {
    if (this.disposed) return false;
    if (data.length === 0) return true;
    const available = MAX_PENDING_BYTES - this.pendingBytes;
    const overflow = () => {
      this.fail(
        "Terminal input queue is full (1 MiB limit). This input was not sent; wait for pending input before trying again.",
      );
      return false;
    };
    // UTF-8 JSON is never shorter than the UTF-16 input length. Reject enormous
    // strings before allocating/encoding copies just to discover the limit.
    if (data.length > available) return overflow();
    const additions: Frame[] = [];
    let addedBytes = 0;
    for (let start = 0; start < data.length;) {
      let end = Math.min(start + FRAME_CHARS, data.length);
      if (
        end < data.length &&
        /[\uD800-\uDBFF]/.test(data[end - 1]) &&
        /[\uDC00-\uDFFF]/.test(data[end])
      )
        end--;
      const message: TerminalInputMessage = {
        type: "input",
        data: data.slice(start, end),
      };
      const bytes = encoder.encode(JSON.stringify(message)).byteLength;
      addedBytes += bytes;
      if (addedBytes > available) return overflow();
      additions.push({ message, bytes });
      start = end;
    }
    this.frames.push(...additions);
    this.pendingBytes += addedBytes;
    this.flush();
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTick?.();
    this.cancelTick = undefined;
    this.frames = [];
    this.head = this.pendingBytes = 0;
  }

  private flush(): void {
    if (this.disposed) return;
    this.cancelTick?.();
    this.cancelTick = undefined;
    const now = this.now();
    const elapsed = Math.max(0, now - this.lastRefill);
    this.lastRefill = now;
    this.bytes = Math.min(BYTE_BURST, this.bytes + elapsed * BYTES_PER_MS);
    this.messages = Math.min(
      MESSAGE_BURST,
      this.messages + elapsed * MESSAGES_PER_MS,
    );
    while (this.head < this.frames.length) {
      const frame = this.frames[this.head];
      if (frame.bytes > this.bytes || this.messages < 1) break;
      this.bytes -= frame.bytes;
      this.messages--;
      this.pendingBytes -= frame.bytes;
      this.head++;
      try {
        this.send(frame.message);
      } catch {
        this.dispose();
        this.fail(
          "Terminal input could not be sent. Commands were not retried; restart the shell to send more input.",
        );
        return;
      }
      // The callback may dispose its owning session during send().
      if (this.disposed) return;
    }
    if (this.head === this.frames.length) {
      this.frames = [];
      this.head = 0;
      return;
    }
    if (this.head > 1024) {
      this.frames = this.frames.slice(this.head);
      this.head = 0;
    }
    const next = this.frames[this.head];
    const wait = Math.max(
      1,
      Math.ceil((next.bytes - this.bytes) / BYTES_PER_MS),
      Math.ceil((1 - this.messages) / MESSAGES_PER_MS),
    );
    this.cancelTick = this.schedule(() => {
      this.cancelTick = undefined;
      this.flush();
    }, wait);
  }
}
