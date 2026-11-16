import test from "node:test";
import assert from "node:assert/strict";
import {
  TerminalInputQueue,
  type TerminalInputMessage,
} from "../src/terminal-input.ts";

class Clock {
  time = 0;
  private id = 0;
  private timers = new Map<number, { at: number; callback: () => void }>();
  now = () => this.time;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.id;
    this.timers.set(id, { at: this.time + delay, callback });
    return () => this.timers.delete(id);
  };
  get pending() {
    return this.timers.size;
  }
  advance(milliseconds: number) {
    const target = this.time + milliseconds;
    let iterations = 0;
    while (true) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next || next[1].at > target) break;
      assert.ok(++iterations < 100000, "timer queue did not settle");
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].callback();
    }
    this.time = target;
  }
}

function fixture() {
  const clock = new Clock();
  const sent: Array<{ time: number; message: TerminalInputMessage }> = [];
  const errors: string[] = [];
  const queue = new TerminalInputQueue(
    (message) => sent.push({ time: clock.time, message }),
    (message) => errors.push(message),
    clock,
  );
  return {
    clock,
    sent,
    errors,
    queue,
    output: () => sent.map(({ message }) => message.data).join(""),
  };
}

const bytes = (message: TerminalInputMessage) =>
  new TextEncoder().encode(JSON.stringify(message)).byteLength;

test("small keyboard input is immediate, ordered and connection local", () => {
  const f = fixture();
  assert.equal(f.queue.enqueue("a"), true);
  assert.equal(f.queue.enqueue("\x03"), true);
  assert.equal(f.queue.enqueue("\r"), true);
  assert.equal(f.queue.enqueue(""), true);
  assert.equal(f.output(), "a\x03\r");
  assert.equal(f.clock.pending, 0);
  assert.deepEqual(f.errors, []);
  assert.ok(f.sent.every(({ time }) => time === 0));
});

test("large paste is paced, Unicode-safe, frame bounded, lossless and ordered", () => {
  const f = fixture();
  const input = `${"a".repeat(4095)}😀${"中😀\r\n\x1b".repeat(40000)}`;
  assert.equal(f.queue.enqueue(input), true);
  assert.equal(f.queue.enqueue("AFTER_PASTE"), true);
  assert.ok(f.output().length < input.length);
  assert.equal(f.clock.pending, 1);
  f.clock.advance(60000);
  assert.equal(f.output(), input + "AFTER_PASTE");
  assert.equal(f.clock.pending, 0);
  assert.deepEqual(f.errors, []);
  for (const { message } of f.sent) {
    assert.ok(message.data.length <= 4096);
    assert.ok(new TextEncoder().encode(message.data).byteLength <= 16384);
    assert.doesNotMatch(message.data, /^[\uDC00-\uDFFF]/);
    assert.doesNotMatch(message.data, /[\uD800-\uDBFF]$/);
    assert.equal(message.type, "input");
  }
});

test("serialized JSON bytes, including control-character escapes, obey the rate bound", () => {
  const f = fixture();
  assert.equal(f.queue.enqueue("\x01".repeat(100000)), true);
  f.clock.advance(30000);
  assert.equal(f.output(), "\x01".repeat(100000));
  assert.ok(
    f.sent
      .filter(({ time }) => time === 0)
      .reduce((total, { message }) => total + bytes(message), 0) <=
      32 * 1024,
  );
  // A 32 KiB burst plus 32 KiB/s refill is at most 64 KiB in any
  // one-second window, below the backend's 256 KiB/s budget.
  for (const start of f.sent) {
    const window = f.sent.filter(
      ({ time }) => time >= start.time && time < start.time + 1000,
    );
    assert.ok(
      window.reduce((total, { message }) => total + bytes(message), 0) <=
        64 * 1024,
    );
  }
});

test("many tiny input events also stay below the backend message-rate limit", () => {
  const f = fixture();
  for (let i = 0; i < 2000; i++) assert.equal(f.queue.enqueue("x"), true);
  assert.ok(f.sent.length <= 128);
  f.clock.advance(20000);
  assert.equal(f.output(), "x".repeat(2000));
  for (const start of f.sent) {
    const count = f.sent.filter(
      ({ time }) => time >= start.time && time < start.time + 1000,
    ).length;
    assert.ok(count <= 384);
  }
  assert.deepEqual(f.errors, []);
});

test("overflow rejects a whole paste before any bytes are sent and retains accepted input", () => {
  const f = fixture();
  assert.equal(f.queue.enqueue("x".repeat(900000)), true);
  const before = f.output();
  assert.equal(f.queue.enqueue("REJECTED".repeat(50000)), false);
  assert.equal(f.output(), before);
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /not sent/);
  f.clock.advance(60000);
  assert.equal(f.output(), "x".repeat(900000));
  assert.equal(f.queue.enqueue("RECOVERED"), true);
  assert.ok(f.output().endsWith("RECOVERED"));
});

test("preflight accounts for JSON expansion rather than raw string size", () => {
  const f = fixture();
  assert.equal(f.queue.enqueue("\x01".repeat(200000)), false);
  assert.equal(f.sent.length, 0);
  assert.equal(f.clock.pending, 0);
  assert.equal(f.errors.length, 1);
  assert.equal(f.queue.enqueue("still usable"), true);
  assert.equal(f.output(), "still usable");
});

test("dispose cancels queued input and cannot replay it into a restarted shell", () => {
  const f = fixture();
  assert.equal(f.queue.enqueue("x".repeat(100000)), true);
  const before = f.output();
  f.queue.dispose();
  f.queue.dispose();
  assert.equal(f.clock.pending, 0);
  f.clock.advance(60000);
  assert.equal(f.output(), before);
  assert.equal(f.queue.enqueue("new input"), false);
  assert.deepEqual(f.errors, []);
});

test("failed send disposes queued input and never retries a potentially partial command", () => {
  const clock = new Clock();
  const errors: string[] = [];
  let attempts = 0;
  const queue = new TerminalInputQueue(
    () => {
      attempts++;
      throw new Error("socket closed");
    },
    (message) => errors.push(message),
    clock,
  );
  assert.equal(queue.enqueue("x".repeat(100000)), true);
  clock.advance(60000);
  assert.equal(attempts, 1);
  assert.equal(clock.pending, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /not retried/);
  assert.equal(queue.enqueue("do not replay"), false);
});

test("disposal from inside send does not schedule more work", () => {
  const clock = new Clock();
  let attempts = 0;
  const queue = new TerminalInputQueue(
    () => {
      attempts++;
      queue.dispose();
    },
    assert.fail,
    clock,
  );
  queue.enqueue("x".repeat(100000));
  clock.advance(60000);
  assert.equal(attempts, 1);
  assert.equal(clock.pending, 0);
});

test("idle time cannot accumulate an unbounded input burst", () => {
  const f = fixture();
  f.clock.advance(600000);
  f.queue.enqueue("x".repeat(100000));
  assert.ok(
    f.sent.reduce((total, { message }) => total + bytes(message), 0) <=
      32 * 1024,
  );
});
