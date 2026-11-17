// Production UI, real Ghostty WASM and PTY. Build first.
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
const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-background-"));
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const configPath = path.join(directory, "config.json");
await writeFile(configPath, JSON.stringify({ shell: "/bin/sh" }));
// Blank colored cells expose every background pixel, not just cell centers.
// Alternate narrow/wide spaces and inverse colors, as used by terminal pagers.
let swatches =
  "\x1b[?25l\x1b[2J\x1b[HSGR background regression: contiguous cells";
for (let row = 1; row <= 6; row++) {
  const spaces = row % 2 ? " ".repeat(20) : "\u3000".repeat(10);
  const color = row > 3 ? "38" : "48";
  const inverse = row > 3 ? ";7" : "";
  swatches += `\x1b[${row + 1};3H\x1b[0;${color};2;96;48;64${inverse}m${spaces}`;
  swatches += `\x1b[0;${color};2;40;88;56${inverse}m${spaces}\x1b[0m`;
}
swatches +=
  "\x1b[9;1HTruecolor backgrounds / inverse / wide spaces\nSWATCH_DONE\n";
const swatchPath = path.join(directory, "swatches.txt");
await writeFile(swatchPath, swatches);
const local = await startLocalServer({
  service: new ReviewService({ repoPath }),
  configPath,
  assetsDir: path.resolve("dist/client"),
  port: 0,
});
resources.defer(() => local.close());
const browser = await chromium.launch({ args: ["--no-sandbox"] });
resources.defer(() => browser.close());
const errors: string[] = [];
for (const dpr of before ? [1.25] : [1, 1.25, 1.5, 1.75, 2]) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 960 },
    deviceScaleFactor: dpr,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  let output = "";
  let geometry = { cols: 0, rows: 0 };
  page.on("websocket", (socket) => {
    if (!socket.url().includes("/api/terminal?")) return;
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
  await expect(input).toHaveAttribute("data-phase", "running");
  await expect.poll(() => output).toContain("$ ");
  await page.getByRole("separator", { name: "Resize terminal" }).focus();
  await page.keyboard.press("End");
  const canvas = input.locator("canvas");

  async function draw() {
    const start = output.length;
    await input.focus();
    await page.keyboard.type(`cat '${swatchPath}'`);
    await page.keyboard.press("Enter");
    await expect.poll(() => output.slice(start)).toContain("SWATCH_DONE\r\n");
  }
  async function mismatches() {
    assert.ok(geometry.cols >= 42 && geometry.rows >= 12);
    return canvas.evaluate((element, { cols, rows }) => {
      const canvas = element as HTMLCanvasElement;
      const context = canvas.getContext("2d")!;
      const scale = context.getTransform();
      // Use logical dimensions, not the truncated backing-store dimensions.
      const width = (parseFloat(canvas.style.width) / cols) * scale.a;
      const height = (parseFloat(canvas.style.height) / rows) * scale.d;
      const pixels = context.getImageData(
        0,
        0,
        canvas.width,
        canvas.height,
      ).data;
      let bad = 0;
      for (let y = Math.round(height); y < Math.round(height * 7); y++) {
        for (let x = Math.round(width * 2); x < Math.round(width * 42); x++) {
          const rgb = x < Math.round(width * 22) ? [96, 48, 64] : [40, 88, 56];
          const i = (y * canvas.width + x) * 4;
          if (
            rgb.some((value, channel) => pixels[i + channel] !== value) ||
            pixels[i + 3] !== 255
          )
            bad++;
        }
      }
      return bad;
    }, geometry);
  }
  for (const fontSize of before ? [17] : [10, 13, 17, 24]) {
    const response = await page.request.post(`${local.url}api/config`, {
      headers: { "X-Fold-Request": "1" },
      data: { "font-size": fontSize },
    });
    assert.equal(response.status(), 200);
    await expect(input).toHaveCSS("font-size", `${fontSize}px`);
    await draw();
    if (before) {
      await expect.poll(mismatches).toBeGreaterThan(0);
      console.log(`Before: ${await mismatches()} mismatched background pixels`);
    } else {
      await expect
        .poll(mismatches, { message: `DPR ${dpr}, font ${fontSize}` })
        .toBe(0);
      // Update a row, then resize the canvas, retaining the swatches.
      const start = output.length;
      await page.keyboard.type(
        "printf '\\033[2;3H\\033[48;2;96;48;64m \\033[0m\\033[11;1HREPAINT_DONE\\n'",
      );
      await page.keyboard.press("Enter");
      await expect
        .poll(() => output.slice(start))
        .toContain("REPAINT_DONE\r\n");
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect.poll(mismatches).toBe(0);
      const oldCols = geometry.cols;
      await page.setViewportSize({ width: 1390, height: 940 });
      await expect.poll(() => geometry.cols).not.toBe(oldCols);
      await expect.poll(mismatches).toBe(0);
      await page.setViewportSize({ width: 1440, height: 960 });
      await expect.poll(() => geometry.cols).toBe(oldCols);
      await expect.poll(mismatches).toBe(0);
    }
    if (dpr === 1.25 && fontSize === 17) {
      // Keep the comparison focused on the swatches, not echoed update commands.
      if (!before) {
        await draw();
        await expect.poll(mismatches).toBe(0);
      }
      await mkdir(".planka-artifacts", { recursive: true });
      const bounds = await page
        .getByRole("region", { name: "Terminal", exact: true })
        .boundingBox();
      assert.ok(bounds);
      await page.screenshot({
        path: `.planka-artifacts/terminal-background-${before ? "before" : "after"}.png`,
        clip: { ...bounds, height: Math.min(bounds.height, 320) },
      });
    }
  }
  await context.close();
}
assert.deepEqual(errors, []);
console.log("Terminal background pixel checks passed");
