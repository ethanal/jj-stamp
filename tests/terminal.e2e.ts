// Production browser assets, real Ghostty WASM, WebSocket, native PTY, shell and jj.
// Run npm run build first, then npx tsx tests/terminal.e2e.ts.
import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";
import { createDemo } from "./fixtures.ts";
import { colorSchemes } from "../src/preference-values.ts";

await using resources = new AsyncDisposableStack();
const directory = await mkdtemp(
  path.join(tmpdir(), "jj-stamp-terminal-browser-"),
);
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await realpath(await createDemo(directory));
const launchPath = path.join(directory, "linked-subdirectory");
await symlink(path.join(repoPath, "src"), launchPath);
const configPath = path.join(directory, "config.json");
await writeFile(configPath, JSON.stringify({ shell: "/bin/sh" }));
const queryProbe = path.join(directory, "terminal query probe.mjs");
await writeFile(
  queryProbe,
  String.raw`
process.stdin.setRawMode(true);
process.stdin.resume();
let input = "";
const timeout = setTimeout(() => finish(false), 1800);
function finish(ok) {
  clearTimeout(timeout);
  process.stdin.pause();
  process.stdin.setRawMode(false);
  process.stdout.write("\n" + (ok ? "QUERY_ROUNDTRIP_OK" : "QUERY_TIMEOUT:" + JSON.stringify(input)) + "\n", () => process.exit(ok ? 0 : 1));
}
process.stdin.on("data", (data) => {
  input += data.toString("utf8");
  if (/\x1b\[\?[0-9;]+c/.test(input) && /\x1b\[>[0-9;]+c/.test(input) && /\x1b\[[0-9]+;[0-9]+R/.test(input))
    finish(true);
});
process.stdout.write("\x1b[0c\x1b[>0c\x1b[6n");
`,
);
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
// Keep native WebSocket handles solely to exercise a genuine transport close and
// server protocol error later. No frames, shell output, PTYs or WASM are mocked.
await page.addInitScript(`
  window.__terminalSockets = [];
  const NativeWebSocket = window.WebSocket;
  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(Target, args) {
      const socket = new Target(...args);
      if (String(args[0]).includes('/api/terminal?'))
        window.__terminalSockets.push(socket);
      return socket;
    }
  });
`);
// Hold only Ghostty's actual WASM fetch, not diff/tree-sitter assets. This lets
// a user move into the log while native terminal initialization is in flight.
let releaseGhostty!: () => void;
const ghosttyGate = new Promise<void>((resolve) => {
  releaseGhostty = resolve;
});
let ghosttyRequested = false;
await page.route("**/ghostty-vt-*.wasm", async (route) => {
  ghosttyRequested = true;
  await ghosttyGate;
  await route.continue();
});
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const reviewActions: string[] = [];
page.on("request", (request) => {
  if (/\/api\/(revision|squash-lines|undo|editor)$/.test(request.url()))
    reviewActions.push(request.url());
});
let connections = 0;
const sent: Array<Record<string, unknown>> = [];
const received: Array<Record<string, unknown>> = [];
let output = "";
let sessionOutput = "";
page.on("websocket", (socket) => {
  if (!socket.url().includes("/api/terminal?")) return;
  connections++;
  sessionOutput = "";
  socket.on("framesent", ({ payload }) =>
    sent.push(JSON.parse(String(payload))),
  );
  socket.on("framereceived", ({ payload }) => {
    const value = JSON.parse(String(payload));
    received.push(value);
    if (value.type === "data") {
      output += value.data;
      sessionOutput += value.data;
    }
  });
});
const panel = page.getByRole("region", { name: "Terminal", exact: true });
const settings = page.getByRole("dialog", { name: "Settings", exact: true });
const input = panel.getByRole("textbox", { name: "Shell input", exact: true });
const phase = page.locator(".terminal-surface");
const resize = page.getByRole("separator", {
  name: "Resize terminal",
  exact: true,
});
const selected = page.locator("[data-line][data-fold-selected]");
const currentChange = page.locator(".log-row.is-current .log-change");
const patchConfig = async (patch: object) => {
  const response = await page.request.post(`${local.url}api/config`, {
    headers: { "X-Fold-Request": "1" },
    data: patch,
  });
  assert.equal(response.status(), 200);
};
async function command(text: string, expected: string) {
  const start = output.length;
  await input.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect.poll(() => output.slice(start)).toContain(expected);
}
async function capture(name: string) {
  if (!process.env.TERMINAL_SCREENSHOTS) return;
  const artifacts = path.resolve(".planka-artifacts");
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, name), caret: "initial" });
}
async function expectNativeCursorOnly() {
  // Do not let screenshot's default caret hiding mask the browser's extra
  // contenteditable caret. Ghostty's own blinking canvas cursor must survive.
  await expect(input).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
  await expect(input.locator("textarea")).toHaveCSS(
    "caret-color",
    "rgba(0, 0, 0, 0)",
  );
  const bounds = await input.evaluate((surface) => {
    const body = surface.getBoundingClientRect();
    const sink = surface.querySelector("textarea")!.getBoundingClientRect();
    return {
      contained:
        sink.x >= body.x &&
        sink.y >= body.y &&
        sink.right <= body.right &&
        sink.bottom <= body.bottom,
    };
  });
  assert.ok(
    bounds.contained,
    "hidden input is anchored in the body, not the header",
  );
  const heading = panel.locator(".terminal-heading");
  const before = await heading.screenshot({ caret: "initial" });
  const fingerprint = () =>
    input.locator("canvas").evaluate((element) => {
      const canvas = element as HTMLCanvasElement;
      const pixels = canvas
        .getContext("2d")!
        .getImageData(
          0,
          0,
          Math.min(128, canvas.width),
          Math.min(32, canvas.height),
        ).data;
      let hash = 0;
      for (const value of pixels) hash = (Math.imul(hash, 31) + value) | 0;
      return hash;
    });
  const initial = await fingerprint();
  await expect.poll(fingerprint, { timeout: 3000 }).not.toBe(initial);
  assert.deepEqual(
    await heading.screenshot({ caret: "initial" }),
    before,
    "terminal header stays still while the native canvas cursor blinks",
  );
}
async function expectCleanCanvas() {
  // A new Ghostty instance must not reuse cells/WASM memory from its predecessor.
  // The native shell's prompt/cursor occupies only the first row.
  await expect
    .poll(() =>
      page.locator(".terminal-surface canvas").evaluate((canvas) => {
        const element = canvas as HTMLCanvasElement;
        const context = element.getContext("2d")!;
        const pixels = context.getImageData(
          0,
          40,
          element.width,
          Math.max(1, element.height - 40),
        ).data;
        const bg = getComputedStyle(document.documentElement)
          .getPropertyValue("--bg")
          .trim();
        const rgb = [1, 3, 5].map((offset) =>
          parseInt(bg.slice(offset, offset + 2), 16),
        );
        const unexpected: Array<{
          x: number;
          y: number;
          actual: number[];
          expected: number[];
        }> = [];
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] !== rgb[0] ||
            pixels[i + 1] !== rgb[1] ||
            pixels[i + 2] !== rgb[2]
          ) {
            unexpected.push({
              x: (i / 4) % element.width,
              y: 40 + Math.floor(i / 4 / element.width),
              actual: [...pixels.slice(i, i + 4)],
              expected: rgb,
            });
            if (unexpected.length === 5) break;
          }
        return unexpected;
      }),
    )
    .toEqual([]);
}
async function expectBarePrompt() {
  await expect.poll(() => sessionOutput.trim()).toMatch(/^[$#]$/);
  await expectCleanCanvas();
}
async function expectNoReconnect(count: number) {
  // Deliberately observe a quiet interval: an eventual equality assertion alone
  // would pass before an accidental reconnect timer could fire.
  await page.waitForTimeout(800);
  assert.equal(connections, count, "errors must never auto-reconnect");
}
async function settleLayout() {
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
}
async function dimensionsReachPty() {
  await input.focus();
  await settleLayout();
  const start = output.length;
  await page.keyboard.type("stty size");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => {
      const size = sent.filter((value) => value.type === "resize").at(-1);
      return (
        size &&
        output.slice(start).includes(`\r\n${size.rows} ${size.cols}\r\n`)
      );
    })
    .toBe(true);
}
async function expectDesktopLayout() {
  const terminal = (await panel.boundingBox())!;
  const log = (await page.locator(".log-panel").boundingBox())!;
  const files = (await page.locator(".sidebar").boundingBox())!;
  const diff = (await page.locator(".viewer-scroll").boundingBox())!;
  assert.ok(diff.height > 0, "diff remains usable above the terminal");
  assert.ok(
    terminal.x >= files.x + files.width - 1,
    "files remain alongside panel",
  );
  assert.ok(
    files.y < terminal.y &&
      files.y + files.height >= terminal.y + terminal.height - 1,
    "files remain full height",
  );
  assert.ok(terminal.x + terminal.width <= log.x + 1, "panel never covers log");
  assert.ok(diff.y + diff.height <= terminal.y + 1, "panel never covers diff");
  assert.ok(
    log.y < terminal.y &&
      log.y + log.height >= terminal.y + terminal.height - 1,
    "log remains full height",
  );
  for (const selector of [
    ".workspace",
    ".log-panel",
    ".sidebar",
    ".viewer-scroll",
  ]) {
    assert.equal(
      await page
        .locator(selector)
        .evaluate((node) => getComputedStyle(node).filter),
      "none",
    );
  }
}

// Preserve the previous, actual floating implementation as comparison evidence.
// This is the only legacy screenshot used; all new captures are bare prompts.
if (process.env.TERMINAL_SCREENSHOTS) {
  await copyFile(
    path.resolve(".planka-artifacts/terminal-dark.png"),
    path.resolve(".planka-artifacts/terminal-panel-before.png"),
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
await page.goto(local.url);
await expect(
  page.locator('[data-line-type="change-addition"]').first(),
).toBeVisible();
await expect(page.locator(".log-row.is-current")).toBeVisible();
assert.equal(connections, 0, "a shell must not start until opened");
await expect(
  page.getByRole("button", { name: "Terminal", exact: true }),
).toHaveAttribute("title", "Open terminal (t)");
await expect(
  page.getByRole("button", { name: "Terminal", exact: true }),
).toHaveText("");
await expect(page.locator(".terminal-trigger svg")).toBeVisible();
await page.keyboard.press("x");
await expect(panel).not.toBeVisible();
assert.equal(connections, 0);
await page.keyboard.press("?");
const shortcuts = page.getByRole("dialog", {
  name: "Keyboard shortcuts",
  exact: true,
});
await expect(shortcuts).toBeVisible();
await expect(
  shortcuts
    .locator(".shortcut-entry")
    .filter({ hasText: "Open terminal panel" })
    .locator("kbd"),
).toHaveText("t");
await page.keyboard.press("Escape");

// Shortcut ignored in settings and typing fields.
await page.getByRole("button", { name: "Settings", exact: true }).click();
await settings
  .getByRole("textbox", { name: "Terminal shell", exact: true })
  .fill("t");
await page.keyboard.press("t");
await expect(
  settings.getByRole("textbox", { name: "Terminal shell", exact: true }),
).toHaveValue("tt");
await expect(panel).not.toBeVisible();
assert.equal(connections, 0);
await page.keyboard.press("Escape");

// A docked, nonmodal region starts only the configured native shell: no welcome
// printf, demo text, app banners, Restart control, dialog or blurred backdrop.
const added = page.locator('[data-line-type="change-addition"]').first();
await added.click();
let selectionCount = await selected.count();
assert.ok(selectionCount > 0);
await page.keyboard.press("t");
await expect(panel).toBeVisible();
await expect(panel).toHaveClass(/terminal-panel/);
await expect(phase).toHaveAttribute("data-phase", "loading");
await expect.poll(() => ghosttyRequested).toBe(true);
assert.equal(connections, 0, "no PTY before the real Ghostty runtime is ready");
await expect(input).toBeFocused();
const loadingWorkspace = await page.locator(".workspace").getAttribute("class");
await page.keyboard.type("l?c");
await expect(page.locator(".workspace")).toHaveAttribute(
  "class",
  loadingWorkspace!,
);
await expect(shortcuts).not.toBeVisible();
await expect(
  page.getByRole("textbox", { name: "ID or revset" }),
).not.toBeVisible();
assert.deepEqual(reviewActions, []);
assert.equal(sent.filter((frame) => frame.type === "input").length, 0);
await currentChange.focus();
await expect(currentChange).toBeFocused();
releaseGhostty();
await expect(phase).toHaveAttribute("data-phase", "running");
await settleLayout();
await expect(currentChange).toBeFocused();
await page.unroute("**/ghostty-vt-*.wasm");
await page.keyboard.press("t");
await expect(input).toBeFocused();
assert.equal(connections, 1);
await expectBarePrompt();
await expect(
  panel.getByRole("heading", { name: "Terminal", exact: true }),
).toHaveText("");
await expect(panel.locator(".terminal-heading svg")).toBeVisible();
await expectNativeCursorOnly();
await expect(
  page.getByRole("dialog", { name: "Terminal", exact: true }),
).toHaveCount(0);
await expect(page.locator(".terminal-overlay")).toHaveCount(0);
await expect(panel.getByRole("button", { name: /Restart/i })).toHaveCount(0);
await expect(
  panel.getByRole("button", { name: "Retry", exact: true }),
).toHaveCount(0);
await expect(
  panel.locator("footer, .terminal-footer, .terminal-dimensions"),
).toHaveCount(0);
await expect(panel).not.toContainText(/Ghostty|Session running|Esc|\/bin\/sh/);
await expectDesktopLayout();
const defaultHeight = (await panel.boundingBox())!.height;
assert.ok(
  Math.abs(defaultHeight - 240) <= 2,
  `default panel height: ${defaultHeight}`,
);
await capture("terminal-panel-dark.png");
await patchConfig({ "color-scheme": "light" });
await expect(page.locator("html")).toHaveAttribute(
  "data-color-scheme",
  "light",
);
await expectCleanCanvas();
await capture("terminal-panel-light.png");
await patchConfig({ "color-scheme": "dark" });
await expect(page.locator("html")).toHaveAttribute("data-color-scheme", "dark");

// Pointer and keyboard resizing must leave the review's selected lines alone.
await expect(resize).toHaveAttribute("aria-orientation", "horizontal");
const handle = (await resize.boundingBox())!;
await page.mouse.move(
  handle.x + handle.width / 2,
  handle.y + handle.height / 2,
);
await page.mouse.down();
await page.mouse.move(
  handle.x + handle.width / 2,
  handle.y + handle.height / 2 - 90,
  { steps: 8 },
);
await page.mouse.up();
await expect
  .poll(async () => (await panel.boundingBox())!.height)
  .toBeGreaterThan(defaultHeight + 60);
await expectDesktopLayout();
assert.equal(await selected.count(), selectionCount);
await capture("terminal-panel-resized.png");
await resize.focus();
let height = (await panel.boundingBox())!.height;
await page.keyboard.press("ArrowUp");
await expect
  .poll(async () => (await panel.boundingBox())!.height)
  .toBeGreaterThan(height);
height = (await panel.boundingBox())!.height;
await page.keyboard.press("ArrowDown");
await expect
  .poll(async () => (await panel.boundingBox())!.height)
  .toBeLessThan(height);
await page.keyboard.press("Home");
await expect.poll(async () => (await panel.boundingBox())!.height).toBe(96);
await page.keyboard.press("End");
await expect
  .poll(async () => (await panel.boundingBox())!.height)
  .toBe(Number(await resize.getAttribute("aria-valuemax")));
await expectDesktopLayout();
await page.keyboard.press("Home");
await expect.poll(async () => (await panel.boundingBox())!.height).toBe(96);
// Check after restoring the diff viewport: virtualized selected rows can leave
// the DOM at maximum panel height without losing the underlying selection.
await expect.poll(() => selected.count()).toBe(selectionCount);

// Return to the normal small height before capturing the narrow-screen layout.
const minimumHandle = (await resize.boundingBox())!;
const toDefault = 240 - (await panel.boundingBox())!.height;
await page.mouse.move(
  minimumHandle.x + minimumHandle.width / 2,
  minimumHandle.y + minimumHandle.height / 2,
);
await page.mouse.down();
await page.mouse.move(
  minimumHandle.x + minimumHandle.width / 2,
  minimumHandle.y + minimumHandle.height / 2 - toDefault,
  { steps: 8 },
);
await page.mouse.up();

// Narrow screens place the full-width panel between workspace and log, not over
// either. Screenshot still contains only untouched native prompt output.
await page.setViewportSize({ width: 390, height: 844 });
await capture("terminal-panel-mobile.png");
const mobilePanel = (await panel.boundingBox())!;
const mobileLog = (await page.locator(".log-panel").boundingBox())!;
const mobileDiff = (await page.locator(".viewer-scroll").boundingBox())!;
assert.ok(mobilePanel.x >= 0 && mobilePanel.x + mobilePanel.width <= 390);
assert.ok(mobilePanel.width >= 388);
assert.ok(
  mobileDiff.y + mobileDiff.height <= mobilePanel.y + 1,
  JSON.stringify({ mobileDiff, mobilePanel, mobileLog }),
);
assert.ok(mobilePanel.y + mobilePanel.height <= mobileLog.y + 1);
await expect(
  panel.getByRole("button", { name: "Hide terminal" }),
).toBeVisible();
await patchConfig({ "font-size": 24 });
await expect(page.locator("html")).toHaveCSS("--font-size", "24px");
await resize.focus();
await page.keyboard.press("End");
await settleLayout();
const maxMobileDiff = (await page.locator(".viewer-scroll").boundingBox())!;
const maxMobilePanel = (await panel.boundingBox())!;
const maxMobileLog = (await page.locator(".log-panel").boundingBox())!;
assert.ok(
  maxMobileDiff.height > 0,
  "maximum mobile panel leaves a usable diff",
);
assert.ok(maxMobileDiff.y + maxMobileDiff.height <= maxMobilePanel.y + 1);
assert.ok(maxMobilePanel.y + maxMobilePanel.height <= maxMobileLog.y + 1);
await patchConfig({ "font-size": 13 });
await expect(page.locator("html")).toHaveCSS("--font-size", "13px");
await page.setViewportSize({ width: 1440, height: 960 });
await input.focus();

// Click/focus review and log while terminal remains open, and t refocuses it.
await page.locator(".code-surface").first().focus();
await expect(input).not.toBeFocused();
await expect(panel).toBeVisible();
await page.keyboard.press("t");
await expect(input).toBeFocused();
await currentChange.click();
await expect(currentChange).toBeFocused();
await expect(panel).toBeVisible();
await page.getByRole("button", { name: "Settings", exact: true }).click();
await expect(settings).toBeVisible();
// Native Settings is modal; the dock remains rendered behind its inert layer.
await expect(page.locator(".terminal-panel")).toBeVisible();
await page.keyboard.press("Escape");
await expect(settings).not.toBeVisible();
await expect(panel).toBeVisible();
await added.click();
selectionCount = await selected.count();
assert.ok(selectionCount > 0);
await page.keyboard.press("t");
await expect(input).toBeFocused();
assert.equal(connections, 1);

await command(
  "test -t 0 && test -t 1 && printf '\\nTTY_OK\\n'",
  "\r\nTTY_OK\r\n",
);
assert.ok(output.includes("TTY_OK"));
await command(
  'printf \'\\nREPO_ROOT:%s:%s:END\\n\' "$(pwd -P)" "$PWD"',
  `\r\nREPO_ROOT:${repoPath}:${repoPath}:END\r\n`,
);
// The standard suite needs no fish installation: a real raw-mode foreground
// program must receive DA1, DA2 and native cursor replies before fish's deadline.
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
await command(
  `${shellQuote(process.execPath)} ${shellQuote(queryProbe)}`,
  "\r\nQUERY_ROUNDTRIP_OK\r\n",
);
await command(
  "export STAMP_PERSIST=kept; printf '\\nREADY_%s\\n' \"$STAMP_PERSIST\"",
  "READY_kept",
);
// Terminal typing, including literal t, must never invoke review actions.
reviewActions.length = 0;
await command("printf '\\nsurlf?cxt\\n'", "surlf?cxt");
await page.keyboard.press("Control+f");
await expect(page.getByRole("searchbox")).not.toBeVisible();
await page.keyboard.press("Control+c");
assert.deepEqual(reviewActions, []);
const escapeStart = sent.length;
await page.keyboard.press("Escape");
await expect(panel).not.toBeVisible();
assert.equal(await selected.count(), selectionCount);
assert.ok(!sent.slice(escapeStart).some((frame) => frame.data === "\x1b"));
await page.keyboard.press("t");
await expect(input).toBeFocused();
assert.equal(connections, 1, "hide/show reuses same PTY");
await command("printf '\\nPERSIST_%s\\n' \"$STAMP_PERSIST\"", "PERSIST_kept");

// Actual dock, viewport and font-size dimensions reach the native PTY.
await dimensionsReachPty();
const initialCols = Number(
  sent.filter((value) => value.type === "resize").at(-1)!.cols,
);
await page.setViewportSize({ width: 1100, height: 760 });
await expect
  .poll(() =>
    Number(sent.filter((value) => value.type === "resize").at(-1)?.cols),
  )
  .toBeLessThan(initialCols);
const resizedCols = Number(
  sent.filter((value) => value.type === "resize").at(-1)!.cols,
);
await patchConfig({ "font-size": 18 });
await expect(page.locator("html")).toHaveCSS("--font-size", "18px");
await expect
  .poll(() =>
    Number(sent.filter((value) => value.type === "resize").at(-1)?.cols),
  )
  .toBeLessThan(resizedCols);
await dimensionsReachPty();
await resize.focus();
const shortRows = Number(
  sent.filter((value) => value.type === "resize").at(-1)!.rows,
);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
await page.keyboard.press("ArrowUp");
await expect
  .poll(() =>
    Number(sent.filter((value) => value.type === "resize").at(-1)?.rows),
  )
  .toBeGreaterThan(shortRows);
await dimensionsReachPty();
await page.keyboard.press("Escape");
await page.setViewportSize({ width: 1440, height: 960 });
await patchConfig({ "font-size": 13 });

// All 14 palettes repaint the real Ghostty canvas to the selected UI background.
for (const scheme of Object.keys(colorSchemes)) {
  await patchConfig({ "color-scheme": scheme });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    scheme,
  );
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const expectedBackground = await page
    .locator("html")
    .evaluate((root) =>
      getComputedStyle(root).getPropertyValue("--bg").trim().replace("#", ""),
    );
  await expect
    .poll(() =>
      page.locator(".terminal-surface canvas").evaluate((canvas) => {
        const pixel = (canvas as HTMLCanvasElement)
          .getContext("2d")!
          .getImageData(0, 0, 1, 1).data;
        return [...pixel.slice(0, 3)]
          .map((n) => n.toString(16).padStart(2, "0"))
          .join("");
      }),
    )
    .toBe(expectedBackground);
  await page.keyboard.press("Escape");
}
// Real paste > the backend's per-second budget must be paced, not disconnect.
await page.keyboard.press("t");
const pastedFile = path.join(directory, "pasted.txt");
let pasteOutputStart = output.length;
await page.keyboard.type(
  `stty -icanon -echo; printf '\\nPASTE_START\\n'; head -c 280000 > '${pastedFile}'; stty icanon echo; printf '\\nPASTE_DONE\\n'`,
);
await page.keyboard.press("Enter");
await expect
  .poll(() => output.slice(pasteOutputStart))
  .toContain("\r\nPASTE_START\r\n");
await input.evaluate((element) => {
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "p".repeat(280000));
  element.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }),
  );
});
await expect
  .poll(() => output.slice(pasteOutputStart), { timeout: 20_000 })
  .toContain("\r\nPASTE_DONE\r\n");
assert.equal((await readFile(pastedFile)).length, 280000);
await expect(phase).toHaveAttribute("data-phase", "running");
const sentBeforeOverflow = sent.filter(
  (frame) => frame.type === "input",
).length;
await input.evaluate((element) => {
  const transfer = new DataTransfer();
  transfer.setData("text/plain", "p".repeat(1024 * 1024 + 1));
  element.dispatchEvent(
    new ClipboardEvent("paste", {
      clipboardData: transfer,
      bubbles: true,
      cancelable: true,
    }),
  );
});
await expect(panel.getByRole("status")).toContainText(
  "This input was not sent",
);
assert.equal(
  sent.filter((frame) => frame.type === "input").length,
  sentBeforeOverflow,
);
await page.keyboard.press("Escape");

// Shell settings apply only to the next session, without a Restart control.
const customShell = path.join(directory, "custom shell");
await writeFile(
  customShell,
  "#!/bin/sh\nexport STAMP_CUSTOM=customized\nexec /bin/sh -i\n",
);
await chmod(customShell, 0o755);
await page.getByRole("button", { name: "Settings", exact: true }).click();
await settings
  .getByRole("textbox", { name: "Terminal shell", exact: true })
  .fill(customShell);
await settings
  .locator(".shell-settings")
  .getByRole("button", { name: "Save", exact: true })
  .click();
await expect
  .poll(async () => JSON.parse(await readFile(configPath, "utf8")).shell)
  .toBe(customShell);
await page.keyboard.press("Escape");
await page.keyboard.press("t");
assert.equal(connections, 1);
await command("printf '\\nSTILL_%s\\n' \"$STAMP_PERSIST\"", "STILL_kept");
await command(
  "cd src; printf '\\nNESTED:%s:END\\n' \"$(pwd -P)\"",
  `\r\nNESTED:${path.join(repoPath, "src")}:END\r\n`,
);

// Even a nonzero clean shell exit automatically starts exactly one fresh native
// session, clears old emulator memory, and adopts the saved executable.
let nextConnection = connections + 1;
await command("exit 7", "exit 7");
// Moving focus out during the respawn delay must win over Ghostty.open's own
// immediate/deferred focus and the new transport's ready callback.
await currentChange.focus();
await expect(currentChange).toBeFocused();
await expect.poll(() => connections).toBe(nextConnection);
await expect(phase).toHaveAttribute("data-phase", "running");
await settleLayout();
await expect(currentChange).toBeFocused();
await expectBarePrompt();
await expect(
  panel.getByRole("button", { name: "Retry", exact: true }),
).toHaveCount(0);
await page.waitForTimeout(800);
assert.equal(
  connections,
  nextConnection,
  "one clean exit respawns exactly once",
);
await command(
  "printf '\\nCUSTOM_%s\\n' \"$STAMP_CUSTOM\"",
  "CUSTOM_customized",
);
await command(
  "printf '\\nRESET_%s\\n' \"${STAMP_PERSIST-unset}\"",
  "RESET_unset",
);
await command(
  'printf \'\\nREPO_ROOT:%s:%s:END\\n\' "$(pwd -P)" "$PWD"',
  `\r\nREPO_ROOT:${repoPath}:${repoPath}:END\r\n`,
);

// A failed executable starts no retry loop. Saving a valid setting alone must
// not reconnect either; only the error-only Retry button may do that.
await patchConfig({ shell: "/definitely/missing/shell" });
nextConnection = connections + 1;
await command("exit", "exit");
await expect.poll(() => connections).toBe(nextConnection);
await expect(phase).toHaveAttribute("data-phase", "ended");
await expect(panel.getByRole("status")).toContainText(
  "Could not start terminal",
);
await expect(
  panel.getByRole("button", { name: "Retry", exact: true }),
).toBeVisible();
await expectNoReconnect(nextConnection);
await patchConfig({ shell: "/bin/sh" });
await expectNoReconnect(nextConnection);
await panel.getByRole("button", { name: "Retry", exact: true }).click();
await expect.poll(() => connections).toBe(++nextConnection);
await expect(phase).toHaveAttribute("data-phase", "running");
await expectBarePrompt();

// Real server protocol errors do not become clean-exit respawns.
await command(
  "printf '\\nOLD_PROTOCOL_SESSION\\n'",
  "\r\nOLD_PROTOCOL_SESSION\r\n",
);
await page.evaluate(
  "window.__terminalSockets.at(-1).send(JSON.stringify({type: 'invalid'}))",
);
await expect(phase).toHaveAttribute("data-phase", "ended");
await expect(panel.getByRole("status")).toContainText(
  "Invalid terminal message",
);
await expectNoReconnect(nextConnection);
await panel.getByRole("button", { name: "Retry", exact: true }).click();
await expect.poll(() => connections).toBe(++nextConnection);
await expect(phase).toHaveAttribute("data-phase", "running");
await expectBarePrompt();

// Close the genuine browser socket, preserving the application's own native
// close/error handling and the server's PTY cleanup. No transport is replaced.
await command(
  "printf '\\nOLD_DISCONNECTED_SESSION\\n'",
  "\r\nOLD_DISCONNECTED_SESSION\r\n",
);
await page.evaluate("window.__terminalSockets.at(-1).close()");
await expect(phase).toHaveAttribute("data-phase", "ended");
await expect(panel.getByRole("status")).toContainText(/disconnect/i);
await expectNoReconnect(nextConnection);
await input.focus();
await page.keyboard.press("Escape");
await expect(panel).not.toBeVisible();
await page.keyboard.press("t");
await expect(phase).toHaveAttribute("data-phase", "ended");
await expectNoReconnect(nextConnection);
await panel.getByRole("button", { name: "Retry", exact: true }).click();
await expect.poll(() => connections).toBe(++nextConnection);
await expect(phase).toHaveAttribute("data-phase", "running");
await expectBarePrompt();

// A valid executable which immediately exits is not an unbounded fork loop:
// at most three automatic respawns occur without intervening user input.
const quickShell = path.join(directory, "rapid exit shell");
const quickStarts = path.join(directory, "rapid-starts.txt");
await writeFile(
  quickShell,
  `#!/bin/sh\nprintf 'start\\n' >> '${quickStarts}'\nexit 0\n`,
);
await chmod(quickShell, 0o755);
await patchConfig({ shell: quickShell });
const beforeRapid = connections;
await command("exit", "exit");
await expect(phase).toHaveAttribute("data-phase", "ended");
await expect(
  panel.getByRole("button", { name: "Retry", exact: true }),
).toBeVisible();
await expect.poll(() => connections).toBe(beforeRapid + 3);
const starts = (await readFile(quickStarts, "utf8")).trim().split("\n");
assert.equal(
  starts.length,
  3,
  "rapid-exit budget includes the respawn after the user's exit",
);
await expectNoReconnect(beforeRapid + 3);
await patchConfig({ shell: "/bin/sh" });
await panel.getByRole("button", { name: "Retry", exact: true }).click();
await expect.poll(() => connections).toBe(beforeRapid + 4);
await expect(phase).toHaveAttribute("data-phase", "running");
await expectBarePrompt();
await page.keyboard.press("Escape");

// Regression: equal colors in the first theme must retain distinct native ANSI
// identities. Inverse foreground spaces and background spaces give exact canvas
// pixels without font antialiasing, covering both existing and freshly written
// output (the old RGB-only map failed Solarized blue/cyan and red/bright-red).
await page.setViewportSize({ width: 1440, height: 960 });
const drawAnsi =
  "printf '\\033[2J\\033[H" +
  "\\033[34;7m   \\033[0m\\033[36;7m   \\033[0m" +
  "\\033[31;7m   \\033[0m\\033[91;7m   \\033[0m" +
  "\\033[44m   \\033[46m   \\033[41m   \\033[101m   \\033[0m" +
  "\\nANSI: blue / cyan / red / bright red" +
  "\\nFirst four: inverse foreground. Next four: background." +
  "\\nANSI_PALETTE_DONE\\n'";
async function assertAnsiCanvas() {
  const expected = await page
    .locator("html")
    .evaluate((root) =>
      ["accent", "diff-selection-border", "red", "removed"].map((role) =>
        getComputedStyle(root).getPropertyValue(`--${role}`).trim().slice(1),
      ),
    );
  const cols = Number(
    sent.filter((value) => value.type === "resize").at(-1)!.cols,
  );
  await expect
    .poll(() =>
      page.locator(".terminal-surface canvas").evaluate((canvas, cols) => {
        const context = (canvas as HTMLCanvasElement).getContext("2d")!;
        return Array.from({ length: 8 }, (_, i) => {
          const pixel = context.getImageData(
            Math.floor(
              ((i * 3 + 1.5) * (canvas as HTMLCanvasElement).width) / cols,
            ),
            1,
            1,
            1,
          ).data;
          return [...pixel.slice(0, 3)]
            .map((n) => n.toString(16).padStart(2, "0"))
            .join("");
        });
      }, cols),
    )
    .toEqual([...expected, ...expected]);
}
for (const initialTheme of ["solarized-dark", "catppuccin-mocha"]) {
  await patchConfig({ "color-scheme": initialTheme });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    initialTheme,
  );
  await page.keyboard.press("t");
  await resize.focus();
  await page.keyboard.press("End");
  const nextConnection: number = connections + 1;
  await command("exit", "exit");
  await expect.poll(() => connections).toBe(nextConnection);
  await expect(phase).toHaveAttribute("data-phase", "running");
  await expectCleanCanvas();
  await command(drawAnsi, "\r\nANSI_PALETTE_DONE\r\n");
  await assertAnsiCanvas();
  for (const scheme of ["dark", "light", "solarized-light", initialTheme]) {
    await patchConfig({ "color-scheme": scheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      scheme,
    );
    await assertAnsiCanvas();
    await command(drawAnsi, "\r\nANSI_PALETTE_DONE\r\n");
    await assertAnsiCanvas();
    assert.equal(connections, nextConnection);
  }
  await page.keyboard.press("Escape");
}
assert.deepEqual(errors, []);
assert.ok(received.some((frame) => frame.type === "ready"));
console.log(
  "Terminal panel browser checks passed: bare native shell, docked/nonmodal desktop/mobile layout, pointer/keyboard/native PTY resize, lazy sessions, typing isolation, native DA1/DA2/cursor roundtrip, Escape persistence, large paste, 14 themes, ANSI identity and memory isolation, customization, clean-exit respawn, bounded rapid exits, explicit error/disconnect Retry.",
);
