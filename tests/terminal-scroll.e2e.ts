// Production assets, real Ghostty WASM and native PTY. Build first.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";
import { createDemo } from "./fixtures.ts";

const before = process.argv.includes("--before");
await using resources = new AsyncDisposableStack();
const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-scroll-"));
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const configPath = path.join(directory, "config.json");
await writeFile(configPath, JSON.stringify({ shell: "/bin/sh" }));
const local = await startLocalServer({
  service: new ReviewService({ repoPath }),
  configPath,
  assetsDir: path.resolve("dist/client"),
  port: 0,
});
resources.defer(() => local.close());
const browser = await chromium.launch({
  args: ["--no-sandbox"],
  ignoreDefaultArgs: ["--hide-scrollbars"],
});
resources.defer(() => browser.close());
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let output = "";
let connections = 0;
let geometry = { cols: 0, rows: 0 };
page.on("websocket", (socket) => {
  if (!socket.url().includes("/api/terminal?")) return;
  connections++;
  socket.on("framesent", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "resize") geometry = frame;
  });
  socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "data") output += frame.data;
  });
});
await page.goto(local.url);
await page.getByRole("button", { name: "Terminal", exact: true }).click();
const input = page.getByRole("textbox", { name: "Shell input", exact: true });
const canvas = input.locator("canvas");
const viewport = page.locator(".terminal-viewport");
await expect(input).toHaveAttribute("data-phase", "running");
await expect.poll(() => output).toContain("$ ");
await command(
  `i=1; while [ "$i" -le 120 ]; do printf 'scrollback line %03d — native terminal output\\n' "$i"; i=$((i+1)); done; printf 'SCROLL_READY\\n'`,
  "SCROLL_READY\r\n",
);
await canvas.hover();
await page.mouse.wheel(0, -400);
await page.waitForTimeout(300);
await mkdir(".planka-artifacts", { recursive: true });
await page.screenshot({
  path: `.planka-artifacts/terminal-scroll-${before ? "before" : "after"}.png`,
});
if (!before) {
  await expect(viewport).toHaveCSS("overflow-y", "scroll");
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect.poll(distanceFromBottom).toBeGreaterThan(200);
  await expectGeometry();

  // Drag the real browser thumb (not a canvas hit target), then scroll the DOM
  // viewport to both ends and verify that Ghostty actually repaints its pixels.
  const box = (await viewport.boundingBox())!;
  const gutter = await viewport.evaluate(
    (el) => (el as HTMLElement).offsetWidth - el.clientWidth,
  );
  assert.ok(gutter > 0, "test uses classic native scrollbars");
  await viewport.evaluate((el) => {
    el.scrollTop = 0;
  });
  await expect.poll(() => viewport.evaluate((el) => el.scrollTop)).toBe(0);
  await settle();
  const topPixels = await fingerprint();
  await page.mouse.move(box.x + box.width - gutter / 2, box.y + gutter + 8);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width - gutter / 2,
    box.y + box.height / 2,
    { steps: 10 },
  );
  await page.mouse.up();
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(200);
  await expect.poll(fingerprint).not.toBe(topPixels);
  await viewport.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect.poll(distanceFromBottom).toBe(0);

  // Scrolling back during a running command must not jump to the prompt when
  // output arrives. A real background shell writes after we've moved away.
  await command(
    `(sleep 1; printf '\\nASYNC_APPEND\\n') & printf 'ASYNC_STARTED\\n'`,
    "ASYNC_STARTED\r\n",
  );
  await viewport.evaluate((el) => {
    el.scrollTop = 280;
  });
  await settle();
  const readingPixels = await fingerprint();
  await expect.poll(() => output).toContain("\r\nASYNC_APPEND\r\n");
  await settle();
  assert.equal(await viewport.evaluate((el) => el.scrollTop), 280);
  assert.equal(
    await fingerprint(),
    readingPixels,
    "new output preserves the lines being read",
  );

  // Hiding and reopening retains the native scroll position, not just PTY state.
  await page.keyboard.press("Escape");
  await expect(viewport).toBeHidden();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(viewport).toBeVisible();
  await settle();
  assert.equal(await viewport.evaluate((el) => el.scrollTop), 280);
  assert.equal(await fingerprint(), readingPixels);

  for (const width of [1100, 850, 390, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    await settle();
    await expectGeometry();
  }
  for (const font of [10, 17, 24, 13]) {
    const response = await page.request.post(`${local.url}api/config`, {
      headers: { "X-Fold-Request": "1" },
      data: { "font-size": font },
    });
    assert.equal(response.status(), 200);
    await expect(input).toHaveCSS("font-size", `${font}px`);
    await settle();
    await expectGeometry();
  }

  // The old canvas scrollbar's background used to erase the last columns.
  // Paint the last two complete cells and inspect EVERY pixel, with history
  // present and a recently-used scrollbar.
  await command(
    "printf '\\033[?25l\\033[2J\\033[HFILL_READY\\n'",
    "FILL_READY\r\n",
  );
  await command(
    `printf '\\033[1;${geometry.cols - 1}H\\033[48;2;96;48;64m  \\033[0m\\033[3;1HEDGE_DONE\\n'`,
    "EDGE_DONE\r\n",
  );
  await expect
    .poll(async () =>
      canvas.evaluate((el, cols) => {
        const canvas = el as HTMLCanvasElement;
        const width = parseFloat(canvas.style.width) / cols;
        const pixels = canvas
          .getContext("2d")!
          .getImageData(canvas.width - 2 * width, 0, 2 * width, 10).data;
        let bad = 0;
        for (let i = 0; i < pixels.length; i += 4)
          if (
            pixels[i] !== 96 ||
            pixels[i + 1] !== 48 ||
            pixels[i + 2] !== 64 ||
            pixels[i + 3] !== 255
          )
            bad++;
        return bad;
      }, geometry.cols),
    )
    .toBe(0);

  // Selection at the extreme right must not hit Ghostty's now-invisible thumb.
  await command(
    `printf '\\033[5;${geometry.cols - 1}HXY\\033[7;1HSELECT_READY\\n'`,
    "SELECT_READY\r\n",
  );
  await settle();
  const screen = (await canvas.boundingBox())!;
  const cellWidth = screen.width / geometry.cols;
  const cellHeight = screen.height / geometry.rows;
  await page.mouse.move(
    screen.x + screen.width - cellWidth / 2,
    screen.y + 4.5 * cellHeight,
  );
  await page.mouse.down();
  await page.mouse.move(
    screen.x + screen.width - 1.5 * cellWidth,
    screen.y + 4.5 * cellHeight,
    { steps: 3 },
  );
  await page.mouse.up();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("XY");
  await expect.poll(distanceFromBottom).toBe(0);

  // Real full-screen raw-mode program: alternate-screen wheels still reach
  // the PTY as arrows, instead of exposing shell history.
  const probe = path.join(directory, "alternate.mjs");
  await writeFile(
    probe,
    `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write("\\x1b[?1049h\\x1b[2J\\x1b[HALTERNATE_READY\\n");
const timer = setTimeout(() => finish("TIMEOUT"), 10000);
function finish(result) {
  clearTimeout(timer);
  process.stdin.setRawMode(false);
  process.stdin.pause();
  process.stdout.write("\\x1b[?1049l\\nALT_" + result + "\\n");
  process.exit();
}
process.stdin.on("data", data => {
  if (data.toString().includes("\\x1b[A")) finish("WHEEL_OK");
});
`,
  );
  await command(`'${process.execPath}' '${probe}'`, "ALTERNATE_READY\r\n");
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBe(0);
  await canvas.hover();
  await page.mouse.wheel(0, -100);
  await expect.poll(() => output).toContain("\r\nALT_WHEEL_OK\r\n");
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBeGreaterThan(0);
  await expect.poll(distanceFromBottom).toBe(0);

  // Fill past the history cap; native extent stays bounded. Ghostty's retained
  // rows are evicted in chunks, so do not assert an exact retained row count.
  await command(
    `i=1; while [ "$i" -le 5100 ]; do printf 'bounded history %04d\\n' "$i"; i=$((i+1)); done; printf 'CAP_DONE\\n'`,
    "CAP_DONE\r\n",
  );
  await settle();
  const lineHeight = await canvas.evaluate(
    (el, rows) => parseFloat((el as HTMLCanvasElement).style.height) / rows,
    geometry.rows,
  );
  const extent = await viewport.evaluate(
    (el) => el.scrollHeight - el.clientHeight,
  );
  assert.ok(extent > 0 && extent <= 5000 * lineHeight);
  await expect.poll(distanceFromBottom).toBe(0);
  await viewport.evaluate((el) => {
    el.scrollTop = 0;
  });
  await settle();
  await expectGeometry();
  // Starting new input returns to the prompt, even with no echo/output yet.
  await input.focus();
  await page.keyboard.press("Control+c");
  await expect.poll(distanceFromBottom).toBe(0);

  // A new shell owns a clean spacer and listeners, not the old scroll range.
  const start = output.length;
  await input.focus();
  await page.keyboard.type("exit");
  await page.keyboard.press("Enter");
  await expect.poll(() => connections).toBe(2);
  await expect.poll(() => output.slice(start)).toContain("$ ");
  await expect(input).toHaveAttribute("data-phase", "running");
  await expect
    .poll(() => viewport.evaluate((el) => el.scrollHeight - el.clientHeight))
    .toBe(0);
}
assert.deepEqual(errors, []);
console.log(
  `Terminal native scrolling ${before ? "before capture" : "checks"} passed`,
);

async function command(text: string, marker: string) {
  const start = output.length;
  await input.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
  await expect.poll(() => output.slice(start)).toContain(marker);
}

async function distanceFromBottom() {
  return viewport.evaluate(
    (el) => el.scrollHeight - el.clientHeight - el.scrollTop,
  );
}

async function settle() {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}

async function fingerprint() {
  return canvas.evaluate((el) => {
    const canvas = el as HTMLCanvasElement;
    const pixels = canvas.getContext("2d")!.getImageData(0, 0, 400, 60).data;
    let hash = 0;
    for (const value of pixels) hash = (Math.imul(hash, 31) + value) | 0;
    return hash;
  });
}

async function expectGeometry() {
  const [panel, scroll, surface, screen] = await Promise.all([
    page.locator(".terminal-panel").boundingBox(),
    viewport.boundingBox(),
    input.boundingBox(),
    canvas.boundingBox(),
  ]);
  assert.ok(panel && scroll && surface && screen);
  assert.equal(
    scroll.x + scroll.width,
    panel.x + panel.width,
    "scrollbar flush with panel edge",
  );
  const cellWidth = screen.width / geometry.cols;
  assert.ok(surface.width - screen.width >= 0);
  assert.ok(
    surface.width - screen.width < cellWidth,
    "no reserved gap beyond the last whole cell",
  );
  assert.equal(
    screen.y,
    scroll.y,
    "canvas stays pinned while native viewport scrolls",
  );
}
