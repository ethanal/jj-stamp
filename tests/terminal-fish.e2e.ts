// Optional real-fish regression fixture; not part of the default browser suite.
// npm run build
// FISH_BINARY=/absolute/path/to/fish npx tsx tests/terminal-fish.e2e.ts
// Requires fish >=4.1, Chromium, jj and the native PTY dependencies. No shell,
// terminal queries, WASM, WebSocket frames or browser responses are mocked.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";
import { createDemo } from "./fixtures.ts";

const fishBinary = process.env.FISH_BINARY;
assert.ok(
  fishBinary && path.isAbsolute(fishBinary),
  "Set FISH_BINARY to an absolute executable path for real fish >=4.1; this optional test never silently skips.",
);
const { stdout: version } = await promisify(execFile)(fishBinary, [
  "--version",
]);
const match = /fish, version (\d+)\.(\d+)/.exec(version);
assert.ok(
  match &&
    (Number(match[1]) > 4 || (Number(match[1]) === 4 && Number(match[2]) >= 1)),
  `Real fish >=4.1 is required; got ${JSON.stringify(version.trim())}`,
);

await using resources = new AsyncDisposableStack();
const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-fish-browser-"));
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await realpath(await createDemo(directory));
const launchPath = path.join(directory, "linked-subdirectory");
await symlink(path.join(repoPath, "src"), launchPath);
const commandsPath = path.join(directory, "fish-commands");
const shellPath = path.join(directory, "real fish fixture");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
// A native fish prompt and preexec observer make readiness and actual parsed
// commands observable without injecting an app banner. --no-config isolates
// user customizations, not terminal feature detection: DA1 must still occur.
const initialize =
  "set -g fish_greeting; " +
  "function fish_prompt; printf 'fish> '; end; " +
  "function __terminal_test_preexec --on-event fish_preexec; " +
  `printf '%s\\n' "$argv" >> ${quote(commandsPath)}; end`;
await writeFile(
  shellPath,
  `#!/bin/sh\nexec ${quote(fishBinary)} --no-config --interactive --init-command ${quote(initialize)}\n`,
);
await chmod(shellPath, 0o755);
const configPath = path.join(directory, "config.json");
await writeFile(configPath, JSON.stringify({ shell: shellPath }));
const local = await startLocalServer({
  service: new ReviewService({ repoPath: launchPath }),
  configPath,
  assetsDir: path.resolve("dist/client"),
  port: 0,
});
resources.defer(() => local.close());
const browser = await chromium.launch({ args: ["--no-sandbox"] });
resources.defer(() => browser.close());
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
type Session = {
  output: string;
  input: string;
  queryAt?: number;
  promptAt?: number;
};
const sessions: Session[] = [];
page.on("websocket", (socket) => {
  if (!socket.url().includes("/api/terminal?")) return;
  const session: Session = { output: "", input: "" };
  sessions.push(session);
  socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "input") session.input += frame.data;
  });
  socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type !== "data") return;
    session.output += frame.data;
    if (session.queryAt === undefined && /\x1b\[(?:0)?c/.test(session.output))
      session.queryAt = Date.now();
    if (session.promptAt === undefined && session.output.includes("fish> "))
      session.promptAt = Date.now();
  });
});
const panel = page.getByRole("region", { name: "Terminal", exact: true });
const input = panel.getByRole("textbox", { name: "Shell input", exact: true });
const commands: string[] = [];
async function command(text: string, expected: string) {
  const session = sessions.at(-1)!;
  const start = session.output.length;
  commands.push(text);
  await input.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect.poll(() => session.output.slice(start)).toContain(expected);
}
async function verifyStartup(session: Session) {
  await expect.poll(() => session.promptAt, { timeout: 15_000 }).toBeDefined();
  // Keep the readiness probe short: keyboard.type dispatches each character
  // through the real browser, so a long printf would time the test driver's
  // dozens of CDP round trips rather than fish's startup/command latency.
  await command("pwd", `${repoPath}\r\n`);
  const usableAt = Date.now();
  console.log(
    `${version.trim()}: ${JSON.stringify({
      queryObserved: session.queryAt !== undefined,
      responseObserved: /\x1b\[\?[0-9;]+c/.test(session.input),
      promptMs:
        session.queryAt === undefined
          ? null
          : session.promptAt! - session.queryAt,
      commandMs:
        session.queryAt === undefined ? null : usableAt - session.queryAt,
    })}`,
  );
  // Observe beyond the reported 2-second timeout, not merely until the first
  // prompt/response (newer fish releases may have a longer failure timeout).
  // This also catches a late or duplicated response becoming
  // editable command text; preexec below verifies exactly what fish executed.
  if (session.queryAt !== undefined) {
    const remaining = session.queryAt + 2_300 - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
  }
  assert.ok(
    !/could not read response to primary device attribute query/i.test(
      session.output,
    ),
    `fish startup warning must not occur: ${JSON.stringify(session.output)}`,
  );
  assert.ok(session.queryAt !== undefined, "real fish must issue a DA1 query");
  assert.match(
    session.input,
    /\x1b\[\?[0-9;]+c/,
    "real browser must return a primary device attributes response to the PTY",
  );
  assert.ok(
    session.promptAt! - session.queryAt < 2_000,
    "fish prompt must be ready before its DA1 timeout",
  );
  assert.ok(
    usableAt - session.queryAt < 2_000,
    "a typed command must finish before fish's DA1 timeout",
  );
  console.log(
    `${version.trim()}: DA1 response observed, prompt ${session.promptAt! - session.queryAt}ms, typed command ${usableAt - session.queryAt}ms, no warning after 2300ms`,
  );
}

await page.goto(local.url);
await expect(page.locator(".log-row.is-current")).toBeVisible();
assert.equal(sessions.length, 0, "fish starts lazily");
await page.getByRole("button", { name: "Terminal", exact: true }).click();
await expect(input).toBeFocused();
await expect.poll(() => sessions.length).toBe(1);
await verifyStartup(sessions[0]);
await command(
  "printf '\\nFISH_ROOT:%s:%s:END\\n' (pwd -P) \"$PWD\"",
  `\r\nFISH_ROOT:${repoPath}:${repoPath}:END\r\n`,
);
await command(
  "set -g FISH_PERSIST kept; printf '\\nFISH_PERSIST:%s\\n' $FISH_PERSIST",
  "\r\nFISH_PERSIST:kept\r\n",
);
await page.keyboard.press("Escape");
await expect(panel).not.toBeVisible();
await page.keyboard.press("t");
await expect(input).toBeFocused();
assert.equal(sessions.length, 1, "hide/reopen preserves the real fish PTY");
await command(
  "printf '\\nFISH_REOPEN:%s\\n' $FISH_PERSIST",
  "\r\nFISH_REOPEN:kept\r\n",
);

commands.push("exit");
await page.keyboard.type("exit");
await page.keyboard.press("Enter");
await expect.poll(() => sessions.length).toBe(2);
await verifyStartup(sessions[1]);
await command(
  "printf '\\nFISH_ROOT_AGAIN:%s:%s:END\\n' (pwd -P) \"$PWD\"",
  `\r\nFISH_ROOT_AGAIN:${repoPath}:${repoPath}:END\r\n`,
);
assert.deepEqual(
  (await readFile(commandsPath, "utf8")).trimEnd().split("\n"),
  commands,
  "terminal query responses must never leak into fish's actual command input",
);
assert.deepEqual(errors, []);
console.log(
  "Real fish browser checks passed: DA1 startup, no timeout, canonical root, typed commands, no query garbage, hide/reopen and clean-exit respawn.",
);
