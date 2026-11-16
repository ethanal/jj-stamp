// Production browser assets, real Ghostty WASM, WebSocket, PTY, shell and jj.
// Run npm run build first, then npx tsx tests/terminal.e2e.ts.
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
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
const browser = await chromium.launch({ args: ["--no-sandbox"] });
resources.defer(() => browser.close());
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let connections = 0;
const sent: Array<Record<string, unknown>> = [];
const received: Array<Record<string, unknown>> = [];
let output = "";
page.on("websocket", (socket) => {
  if (!socket.url().includes("/api/terminal?")) return;
  connections++;
  socket.on("framesent", ({ payload }) =>
    sent.push(JSON.parse(String(payload))),
  );
  socket.on("framereceived", ({ payload }) => {
    const value = JSON.parse(String(payload));
    received.push(value);
    if (value.type === "data") output += value.data;
  });
});
const overlay = page.getByRole("dialog", { name: "Terminal", exact: true });
const settings = page.getByRole("dialog", { name: "Settings", exact: true });
const input = overlay.getByRole("textbox", { name: "Shell input" });
const phase = page.locator(".terminal-surface");
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
  await page.screenshot({ path: path.join(artifacts, name) });
}

await page.goto(local.url);
await expect(
  page.locator('[data-line-type="change-addition"]').first(),
).toBeVisible();
await expect(page.locator(".log-row.is-current")).toBeVisible();
assert.equal(connections, 0, "a shell must not start until opened");
await capture("terminal-before.png");

// Shortcut ignored in settings and typing fields.
await page.getByRole("button", { name: "Settings", exact: true }).click();
await settings
  .getByRole("textbox", { name: "Terminal shell", exact: true })
  .fill("x");
await page.keyboard.press("x");
await expect(overlay).not.toBeVisible();
assert.equal(connections, 0);
await page.keyboard.press("Escape");

// Opening with x preserves review selection/focus; shell runs in repo root.
const added = page.locator('[data-line-type="change-addition"]').first();
await added.click();
const selected = page.locator("[data-line][data-fold-selected]");
const selectionCount = await selected.count();
assert.ok(selectionCount > 0);
await page.keyboard.press("x");
await expect(overlay).toBeVisible();
await expect(phase).toHaveAttribute("data-phase", "running");
await expect(input).toBeFocused();
assert.equal(connections, 1);
await command("test -t 0 && test -t 1 && printf '\\nTTY_OK\\n'; pwd", repoPath);
assert.ok(output.includes("TTY_OK"));
await command(
  "export STAMP_PERSIST=kept; printf '\\nREADY_%s\\n' \"$STAMP_PERSIST\"",
  "READY_kept",
);

// Terminal keys must never trigger review mutations, search or other dialogs.
const reviewActions: string[] = [];
page.on("request", (request) => {
  if (/\/api\/(revision|squash-lines|undo|editor)$/.test(request.url()))
    reviewActions.push(request.url());
});
await command("printf '\\nsurlf?cx\\n'", "surlf?cx");
await page.keyboard.press("Control+f");
await expect(page.getByRole("searchbox")).not.toBeVisible();
await page.keyboard.press("Control+c");
assert.deepEqual(reviewActions, []);
const escapeStart = sent.length;
await page.keyboard.press("Escape");
await expect(overlay).not.toBeVisible();
assert.equal(await selected.count(), selectionCount);
assert.ok(!sent.slice(escapeStart).some((frame) => frame.data === "\x1b"));
await page.keyboard.press("x");
await expect(input).toBeFocused();
assert.equal(connections, 1, "hide/show reuses the same PTY connection");
await command("printf '\\nPERSIST_%s\\n' \"$STAMP_PERSIST\"", "PERSIST_kept");

// Actual geometry reaches stty, including viewport and shared font-size changes.
const initialCols = sent
  .filter((value) => value.type === "resize")
  .at(-1)!.cols;
await page.setViewportSize({ width: 1100, height: 760 });
await expect
  .poll(() =>
    Number(sent.filter((value) => value.type === "resize").at(-1)?.cols),
  )
  .toBeLessThan(Number(initialCols));
const resizedCols = sent
  .filter((value) => value.type === "resize")
  .at(-1)!.cols;
await patchConfig({ "font-size": 18 });
await expect(page.locator("html")).toHaveCSS("--font-size", "18px");
await expect
  .poll(() =>
    Number(sent.filter((value) => value.type === "resize").at(-1)?.cols),
  )
  .toBeLessThan(Number(resizedCols));
// Wait until the terminal dimensions footer agrees with the latest resize frame.
await expect
  .poll(async () => {
    const sizes = sent.filter((value) => value.type === "resize");
    return (
      (await overlay.locator(".terminal-dimensions").textContent()) ===
      `Ghostty · ${sizes.at(-1)?.cols} × ${sizes.at(-1)?.rows}`
    );
  })
  .toBe(true);
const geometry = sent.filter((value) => value.type === "resize").at(-1)!;
await command("stty size", `${geometry.rows} ${geometry.cols}`);

// Verify all 14 palettes repaint the real Ghostty canvas to the selected UI bg.
await page.keyboard.press("Escape");
await page.setViewportSize({ width: 1440, height: 960 });
await patchConfig({ "font-size": 13 });
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
    .poll(async () =>
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

// Real command output for screenshot evidence, not mocked terminal text.
for (const scheme of ["dark", "solarized-light"]) {
  await patchConfig({ "color-scheme": scheme });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    scheme,
  );
  await page.keyboard.press("x");
  await command(
    "clear; printf '\\033[1mjj-stamp workspace\\033[0m\\n\\n'; pwd; printf '\\n\\033[32m\\342\\234\\223\\033[0m Native shell connected to a backend PTY\\n\\033[34m\\342\\206\\222\\033[0m Session preserved while hidden\\n\\n'; printf 'Selected palette: %s\\n' " +
      scheme,
    `Selected palette: ${scheme}`,
  );
  await capture(`terminal-${scheme}.png`);
  await page.keyboard.press("Escape");
}

// Real paste > the backend's per-second budget must be paced, not disconnect.
await page.keyboard.press("x");
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
await expect(overlay.getByRole("status")).toContainText(
  "This input was not sent",
);
assert.equal(
  sent.filter((frame) => frame.type === "input").length,
  sentBeforeOverflow,
);
await page.keyboard.press("Escape");

// Customized executable is saved via Settings; existing shell stays intact.
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
  .getByRole("button", { name: "Apply shell", exact: true })
  .click();
await expect
  .poll(async () => JSON.parse(await readFile(configPath, "utf8")).shell)
  .toBe(customShell);
await page.keyboard.press("Escape");
await page.keyboard.press("x");
assert.equal(connections, 1);
page.once("dialog", (dialog) => dialog.accept());
await overlay
  .getByRole("button", { name: "Restart shell", exact: true })
  .click();
await expect.poll(() => connections).toBe(2);
await expect(phase).toHaveAttribute("data-phase", "running");
await command(
  "printf '\\nCUSTOM_%s\\n' \"$STAMP_CUSTOM\"",
  "CUSTOM_customized",
);
await command("exit 7", "exit 7");
await expect(phase).toHaveAttribute("data-phase", "ended");
await expect(overlay.getByRole("status")).toContainText("Shell exited (7)");
await patchConfig({ shell: "/definitely/missing/shell" });
await overlay
  .getByRole("button", { name: "Restart shell", exact: true })
  .click();
await expect(overlay.getByRole("status")).toContainText(
  "Could not start terminal",
);
await patchConfig({ shell: "/bin/sh" });
await overlay
  .getByRole("button", { name: "Restart shell", exact: true })
  .click();
await expect.poll(() => connections).toBe(4);
await expect(phase).toHaveAttribute("data-phase", "running");
// A restart must not expose stale cells from the previous emulator's memory.
await expect
  .poll(() =>
    page.locator(".terminal-surface canvas").evaluate((canvas) => {
      const context = (canvas as HTMLCanvasElement).getContext("2d")!;
      const pixels = context.getImageData(0, 100, canvas.clientWidth, 10).data;
      const bg = getComputedStyle(document.documentElement)
        .getPropertyValue("--bg")
        .trim();
      const rgb = [1, 3, 5].map((offset) =>
        parseInt(bg.slice(offset, offset + 2), 16),
      );
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i] !== rgb[0] ||
          pixels[i + 1] !== rgb[1] ||
          pixels[i + 2] !== rgb[2]
        )
          return false;
      return true;
    }),
  )
  .toBe(true);
await command("printf '\\nRECOVERED\\n'", "RECOVERED");

// Narrow-screen modal stays within viewport, Escape is still available.
await page.setViewportSize({ width: 390, height: 844 });
const box = await overlay.boundingBox();
assert.ok(box && box.x >= 0 && box.x + box.width <= 390);
await expect(
  overlay.getByRole("button", { name: "Hide terminal" }),
).toBeVisible();
await capture("terminal-mobile.png");
await page.keyboard.press("Escape");
assert.deepEqual(errors, []);
assert.ok(received.some((frame) => frame.type === "ready"));
console.log(
  "Terminal browser checks passed: lazy PTY, typing isolation, Escape persistence, resize, 14 themes, shell customization/restart, exit/error recovery, mobile bounds.",
);
