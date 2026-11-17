import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { build } from "esbuild";
import {
  BoundedPtyInput,
  MAX_PTY_INPUT_BACKLOG,
  MAX_PTY_INPUT_TASKS,
  PtyInputBacklogError,
  PtyInputCompatibilityError,
} from "../server/terminal-input.ts";

function fixture() {
  let writes = 0;
  let disposed = 0;
  const writer = {
    _writeQueue: [] as Array<{ buffer: Buffer; offset: number }>,
    _processWriteQueue() {},
    write(data: string | Buffer) {
      writes++;
      writer._writeQueue.push({ buffer: Buffer.from(data), offset: 0 });
    },
    dispose() {
      disposed++;
    },
  };
  const terminal = {
    _writeStream: writer,
    write: (data: string) => writer.write(data),
  };
  const input = new BoundedPtyInput(terminal as unknown as IPty);
  return {
    input,
    writer,
    terminal,
    writes: () => writes,
    disposed: () => disposed,
  };
}

test("native backlog is bounded before handing another buffer to node-pty", () => {
  const f = fixture();
  for (let i = 0; i < 16; i++) f.input.write("x".repeat(16 * 1024));
  assert.equal(f.input.pendingBytes, MAX_PTY_INPUT_BACKLOG);
  assert.equal(f.writes(), 16);
  assert.throws(() => f.input.write("x"), PtyInputBacklogError);
  assert.equal(f.writes(), 16, "overflow frame must never reach native write");
  assert.equal(
    f.writer._writeQueue.length,
    0,
    "all accepted pending bytes dropped",
  );
  assert.equal(f.input.pendingBytes, 0);
  f.input.write("do not replay");
  assert.equal(f.writes(), 16);
  assert.equal(f.disposed(), 1);
});

test("capacity is released only by actual native task offsets/removal", () => {
  const f = fixture();
  f.input.write("中".repeat(4000));
  assert.equal(f.input.pendingBytes, 12000);
  f.writer._writeQueue[0].offset = 2345;
  assert.equal(f.input.pendingBytes, 9655);
  f.input.write("😀");
  assert.equal(f.input.pendingBytes, 9659);
  f.writer._writeQueue.shift();
  assert.equal(f.input.pendingBytes, 4);
  f.writer._writeQueue.shift();
  assert.equal(f.input.pendingBytes, 0);
});

test("many tiny pending writes cannot grow unbounded task-object overhead", () => {
  const f = fixture();
  for (let i = 0; i < MAX_PTY_INPUT_TASKS; i++) f.input.write("x");
  assert.equal(f.input.pendingBytes, MAX_PTY_INPUT_TASKS);
  assert.throws(() => f.input.write("x"), /1024 pending writes/);
  assert.equal(f.writes(), MAX_PTY_INPUT_TASKS);
  assert.equal(f.writer._writeQueue.length, 0);
});

test("dispose drops the existing native queue and cancels retries exactly once", () => {
  const f = fixture();
  f.input.write("pending");
  const original = f.writer._writeQueue;
  f.input.dispose();
  f.input.dispose();
  assert.equal(f.writer._writeQueue, original);
  assert.deepEqual(original, []);
  assert.equal(f.disposed(), 1);
  f.input.write("not sent after disconnect");
  assert.equal(f.writes(), 1);
});

test("unknown native writer layouts and malformed offsets fail closed", () => {
  assert.throws(
    () => new BoundedPtyInput({ write() {} } as unknown as IPty),
    PtyInputCompatibilityError,
  );
  for (const offset of [-1, 2, 0.5, NaN]) {
    const f = fixture();
    f.writer._writeQueue.push({ buffer: Buffer.from("x"), offset });
    assert.throws(
      () => f.input.write("do not send"),
      PtyInputCompatibilityError,
    );
    assert.equal(f.writes(), 0);
    f.input.dispose();
  }
  const f = fixture();
  f.terminal._writeStream = { ...f.writer };
  assert.throws(() => f.input.write("do not send"), PtyInputCompatibilityError);
  assert.equal(f.writes(), 0);
});

test("bundled CJS checks the external installed node-pty version, not an inlined build-time version", async (t) => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-pty-contract-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outfile = path.join(directory, "adapter.cjs");
  await build({
    entryPoints: [
      fileURLToPath(new URL("../server/terminal-input.ts", import.meta.url)),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["node-pty"],
  });
  assert.match(
    await readFile(outfile, "utf8"),
    /require\("node-pty\/package\.json"\)/,
  );
  const metadata = path.join(directory, "node_modules/node-pty/package.json");
  await mkdir(path.dirname(metadata), { recursive: true });
  const probe = `
    const {BoundedPtyInput}=require(process.argv[1]);
    const writer={_writeQueue:[],_processWriteQueue(){},write(){},dispose(){}};
    try {
      new BoundedPtyInput({_writeStream:writer,write(){}});
      process.stdout.write("supported");
    } catch(error) { process.stdout.write(error.message); }
  `;
  for (const [version, expected] of [
    ["1.1.0", "supported"],
    ["1.1.1", "requires the audited node-pty 1.1.0"],
  ]) {
    await writeFile(metadata, JSON.stringify({ version }));
    const result = execFileSync(process.execPath, ["-e", probe, outfile], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.ok(result.includes(expected), `${version}: ${result}`);
  }
});
