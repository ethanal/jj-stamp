import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { Ghostty } from "ghostty-web";
import {
  detectTerminalQuerySupport,
  TerminalQueryResponder,
  type TerminalQuerySupport,
} from "../src/terminal-queries.ts";

const primary = "\x1b[?62;22c";
const secondary = "\x1b[>1;10;0c";
const missing = { primary: false, secondary: false };
function respond(chunks: string[], native: TerminalQuerySupport = missing) {
  const responder = new TerminalQueryResponder(native);
  let output = "";
  for (const chunk of chunks)
    responder.write(chunk, (response) => {
      output += response;
      return true;
    });
  return output;
}

test("DA1 and DA2 queries get conservative upstream-compatible replies", () => {
  for (const query of ["\x1b[c", "\x1b[0c", "\x1b[000c"])
    assert.equal(respond([query]), primary, JSON.stringify(query));
  for (const query of ["\x1b[>c", "\x1b[>0c", "\x1b[>000c"])
    assert.equal(respond([query]), secondary, JSON.stringify(query));
});

test("queries survive every PTY chunk split, including one character per frame", () => {
  const data = "prompt\x1b[0c\x1b[>000c\x1b[6n\x1b[c";
  const expected = primary + secondary + primary;
  for (let split = 0; split <= data.length; split++)
    assert.equal(respond([data.slice(0, split), data.slice(split)]), expected);
  assert.equal(respond([...data]), expected);
});

test("replies, unsupported queries, and printed lookalikes never get replies", () => {
  for (const data of [
    "\\x1b[0c",
    "[c",
    "\u009b0c",
    "\x1b[?62;22c",
    "\x1b[>1;10;0c",
    "\x1b[1c",
    "\x1b[0;0c",
    "\x1b[=c",
    "\x1b[?c",
    "\x1b[0>c",
    "\x1b[>>c",
    "\x1b[ 0c",
    "\x1b[0 c",
    "\x1b[\u0098c",
    "\x1b[0éc",
    "\x1b( [c",
    "\x1b(\x00[c",
    "\x1bc",
    "\x1b[5n",
    "\x1b[6n",
    "\x1b]0;[0c\x07",
    "\x1bPq[>0c\x1b\\",
    "\x1b_[c\x1b\\",
  ])
    assert.equal(respond([...data]), "", JSON.stringify(data));
});

test("C0/DEL preserve CSI, while CAN/SUB and ESC abort pending candidates", () => {
  assert.equal(respond(["\x1b[\x00\x01\t\n\r\x7f0\x07c"]), primary);
  assert.equal(respond(["\x1b[>\x00\x7f0c"]), secondary);
  for (const cancel of ["\x18", "\x1a"])
    assert.equal(respond([`\x1b[0${cancel}c\x1b[c`]), primary);
  assert.equal(respond(["\x1b[>0\x1b\x1b[c"]), primary);
  assert.equal(respond(["\x1b[>0\x1bc"]), "");
});

test("control strings ignore payload but ESC can interrupt them, like Ghostty", () => {
  for (const introducer of ["]", "P", "_", "^", "X"]) {
    const payload = `\x1b${introducer}0;[c\x07[>c`;
    assert.equal(respond([...payload]), "");
    assert.equal(respond([...`${payload}\x1b[0c`]), primary);
    assert.equal(respond([...`${payload}\x18\x1b[>c`]), secondary);
    assert.equal(respond([...`${payload}\x1b\x1b\\\x1b[c`]), primary);
  }
});

test("native support independently disables each fallback family", () => {
  const data = "\x1b[c\x1b[>c";
  assert.equal(respond([data], missing), primary + secondary);
  assert.equal(respond([data], { primary: true, secondary: false }), secondary);
  assert.equal(respond([data], { primary: false, secondary: true }), primary);
  assert.equal(respond([data], { primary: true, secondary: true }), "");
});

test("long parameters and control strings do not accumulate parser payload", () => {
  const responder = new TerminalQueryResponder(missing);
  const replies: string[] = [];
  const send = (value: string) => {
    replies.push(value);
    return true;
  };
  responder.write("\x1b[", send);
  for (let i = 0; i < 100; i++) responder.write("0".repeat(1000), send);
  responder.write("c\x1b]0;", send);
  for (let i = 0; i < 100; i++) responder.write("[c".repeat(1000), send);
  assert.deepEqual(replies, [primary]);
  assert.ok(
    Object.values(responder).every(
      (value) => typeof value !== "string" || value.length < 32,
    ),
    "only finite parser state, never a retained parameter/string buffer",
  );
  responder.write("\x07\x1b[>c", send);
  assert.deepEqual(replies, [primary, secondary]);
});

test("query floods use bounded batches through the caller's input queue", () => {
  const responder = new TerminalQueryResponder(missing);
  const batches: string[] = [];
  responder.write("\x1b[c".repeat(10_000), (value) => {
    batches.push(value);
    return true;
  });
  assert.ok(batches.length > 1);
  assert.ok(batches.every((batch) => batch.length > 0 && batch.length <= 4096));
  assert.equal(batches.join(""), primary.repeat(10_000));
});

test("rejected replies stop enqueue attempts but keep parsing remaining bytes", () => {
  const responder = new TerminalQueryResponder(missing);
  let attempts = 0;
  responder.write("\x1b[c".repeat(10_000) + "\x1b[>", () => {
    attempts++;
    return false;
  });
  assert.equal(attempts, 1);
  const replies: string[] = [];
  responder.write("0c", (value) => {
    replies.push(value);
    return true;
  });
  assert.deepEqual(replies, [secondary]);
  assert.equal(
    respond(["0c"]),
    "",
    "another connection cannot inherit a partial query",
  );
});

test("capability detection checks reply families and always frees the scratch terminal", () => {
  const queries: string[] = [];
  let freed = 0;
  const responses = ["\x1b[0n", secondary];
  assert.deepEqual(
    detectTerminalQuerySupport({
      write(data) {
        queries.push(String(data));
      },
      readResponse() {
        return responses.shift() ?? null;
      },
      free() {
        freed++;
      },
    }),
    { primary: false, secondary: true },
  );
  assert.deepEqual(queries, ["\x1b[c", "\x1b[>c"]);
  assert.equal(freed, 1);
  assert.throws(
    () =>
      detectTerminalQuerySupport({
        write() {
          throw new Error("native failure");
        },
        readResponse() {
          return null;
        },
        free() {
          freed++;
        },
      }),
    /native failure/,
  );
  assert.equal(freed, 2);
});

test("real WASM plus the adapter replies exactly once to DA and preserves native DSR", async () => {
  const wasm = await readFile(
    createRequire(import.meta.url).resolve("ghostty-web/ghostty-vt.wasm"),
  );
  const url = `data:application/wasm;base64,${wasm.toString("base64")}`;
  const scratch = await Ghostty.load(url);
  const support = detectTerminalQuerySupport(scratch.createTerminal(1, 1));
  // The real session has separate memory, including after capability detection.
  const ghostty = await Ghostty.load(url);
  const terminal = ghostty.createTerminal(80, 24);
  try {
    const data = "\x1b[5n\x1b[6n\x1b[c\x1b[>c";
    terminal.write(data);
    let output = terminal.readResponse() ?? "";
    new TerminalQueryResponder(support).write(data, (value) => {
      output += value;
      return true;
    });
    for (const response of [
      /\x1b\[\?[0-9;]+c/g,
      /\x1b\[>[0-9;]+c/g,
      /\x1b\[0n/g,
      /\x1b\[1;1R/g,
    ])
      assert.equal([...output.matchAll(response)].length, 1, String(response));
  } finally {
    terminal.free();
  }
});
