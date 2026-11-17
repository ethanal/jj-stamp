// Production assets, real Ghostty WASM and native loopback PTY; no transport mocks.
// Build first, then: npx tsx tests/terminal-chrome.e2e.ts [before|after]
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium, expect } from "@playwright/test";
import { startLocalServer } from "../server/http.ts";
import { ReviewService } from "../server/service.ts";
import { createDemo } from "./fixtures.ts";

const stage = process.argv[2] ?? "after";
assert.ok(stage === "before" || stage === "after");
const screenshotPrefix =
  process.env.TERMINAL_CHROME_SCREENSHOT_PREFIX ?? "terminal-narrow";
await using resources = new AsyncDisposableStack();
const directory = await mkdtemp(
  path.join(tmpdir(), "jj-stamp-terminal-chrome-"),
);
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const configPath = path.join(directory, "config.json");
await writeFile(
  configPath,
  JSON.stringify({
    shell: "/bin/sh",
    "files-expanded": false,
    "log-expanded": true,
    "hover-sidebars": true,
  }),
);
const local = await startLocalServer({
  service: new ReviewService({ repoPath }),
  configPath,
  assetsDir: path.resolve("dist/client"),
  port: 0,
});
resources.defer(() => local.close());
const browser = await chromium.launch({ args: ["--no-sandbox"] });
resources.defer(() => browser.close());
const page = await browser.newPage({
  viewport: { width: 650, height: 960 },
  deviceScaleFactor: 1,
});
const files = page.getByLabel("Files sidebar", { exact: true });
const log = page.getByLabel("Revision graph", { exact: true });
const workspace = page.locator(".workspace");
const panel = page.getByRole("region", { name: "Terminal", exact: true });
const input = panel.getByRole("textbox", { name: "Shell input", exact: true });
const terminalButton = page.getByRole("button", {
  name: "Terminal",
  exact: true,
});
const refresh = page.getByRole("button", { name: "Refresh", exact: true });
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
let output = "";
page.on("websocket", (socket) => {
  if (!socket.url().includes("/api/terminal?")) return;
  socket.on("framereceived", ({ payload }) => {
    const frame = JSON.parse(String(payload));
    if (frame.type === "data") output += frame.data;
  });
});
await page.goto(local.url);
await expect(page.locator(".log-row.is-current")).toBeVisible({
  timeout: 30000,
});
if (stage === "after") await expectNarrowGeometry("initially hidden");
await terminalButton.click();
await expect(input).toHaveAttribute("data-phase", "running");
await expect.poll(() => output).toContain("$ ");
await expect(input.locator("canvas")).toBeVisible();
await page.evaluate(() => document.fonts.ready);
await input.focus();
await files.hover();
await expect(page.locator("#files-sidebar-content")).toBeVisible();
await files.evaluate((element) =>
  element.getAnimations().forEach((animation) => animation.finish()),
);
await mkdir(path.resolve(".planka-artifacts"), { recursive: true });
await page.screenshot({
  path: path.resolve(`.planka-artifacts/${screenshotPrefix}-${stage}.png`),
  caret: "initial",
});
console.log(
  `Captured ${stage}: actual bare /bin/sh prompt, native PTY and Ghostty canvas`,
);
if (stage === "after") {
  await expect(terminalButton).toHaveAttribute("title", "Open terminal (t)");
  await expect(terminalButton.locator("svg")).toHaveCount(1);
  await expect(terminalButton.locator("svg rect")).toHaveCount(0);
  await expect(panel.locator(".terminal-heading h2 svg")).toHaveCount(1);
  await expect(panel.locator(".terminal-heading h2 svg rect")).toHaveCount(0);
  await expect(terminalButton).toHaveText("");
  await expect(refresh).toHaveText("");
  await expect(refresh).toHaveAttribute("title", "Refresh repository");
  await expect(refresh.locator("svg")).toHaveCount(1);
  await expect(refresh.locator("svg")).toBeVisible();

  // The native canvas cursor keeps blinking, but neither it nor the hovered
  // files preview may alter a single pixel of the terminal header.
  await page.mouse.move(1, 1);
  await expect(files).not.toHaveClass(/is-peeking/);
  await input.focus();
  const heading = panel.locator(".terminal-heading");
  const stillHeading = await heading.screenshot({ caret: "initial" });
  const canvasFingerprint = () =>
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
  const initialCanvas = await canvasFingerprint();
  await expect
    .poll(canvasFingerprint, { timeout: 3000 })
    .not.toBe(initialCanvas);
  assert.deepEqual(
    await heading.screenshot({ caret: "initial" }),
    stillHeading,
    "native cursor blinking leaves the header still",
  );
  await files.hover();
  await expect(files).toHaveClass(/is-peeking/);
  await files.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
  assert.deepEqual(
    await heading.screenshot({ caret: "initial" }),
    stillHeading,
    "narrow files hover has no shadow below onto the terminal heading",
  );

  // Every mobile state uses the same full-width bottom track, whether the
  // terminal was never opened, is open, or has subsequently been hidden.
  for (const width of [390, 600, 850]) {
    await page.setViewportSize({ width, height: 960 });
    for (const state of ["closed", "open", "hidden-again"] as const) {
      await setTerminal(state === "open");
      for (const filesExpanded of [false, true]) {
        await setPinned("files", filesExpanded);
        for (const logExpanded of [false, true]) {
          await setPinned("log", logExpanded);
          const label = `${width}/${state}/files:${filesExpanded}/log:${logExpanded}`;
          await expectNarrowGeometry(label);
          if (!filesExpanded) {
            await files.hover();
            await expect(files).toHaveClass(/is-peeking/);
            await finishPeek(files);
            await expectNarrowGeometry(`${label}/files-peek`);
            await page.mouse.move(1, 1);
          }
          if (!logExpanded) {
            await log.hover();
            await expect(log).toHaveClass(/is-peeking/);
            await finishPeek(log);
            await expectNarrowGeometry(`${label}/log-peek`);
            await page.mouse.move(1, 1);
          }
        }
      }
    }
  }
  await page.setViewportSize({ width: 650, height: 960 });
  await setPinned("files", false);
  await setPinned("log", false);
  await setTerminal(true);
  await page.locator(".squash-destination-trigger").click();
  await page.getByRole("menuitem", { name: "Choose revision in log…" }).click();
  await expect(workspace).not.toHaveClass(/log-collapsed/);
  await expect(terminalButton).toBeDisabled();
  await expectNarrowGeometry("destination picker temporarily opens the log");
  await page.keyboard.press("t");
  await expect(input).not.toBeFocused();
  await page.screenshot({
    path: path.resolve(
      `.planka-artifacts/${screenshotPrefix}-destination-after.png`,
    ),
    caret: "initial",
  });
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveClass(/log-collapsed/);
  await expect(terminalButton).toBeEnabled();
  await expectNarrowGeometry("cancel restores the collapsed log with terminal");
  await setTerminal(false);
  await setPinned("log", true);
  await files.hover();
  await finishPeek(files);
  await page.screenshot({
    path: path.resolve(
      `.planka-artifacts/${screenshotPrefix}-closed-after.png`,
    ),
    caret: "initial",
  });

  // The mobile rules must not change desktop's full-height left/right panels.
  for (const width of [1100, 1440]) {
    await page.setViewportSize({ width, height: 960 });
    for (const terminalOpen of [false, true]) {
      await setTerminal(terminalOpen);
      for (const expanded of [true, false]) {
        await setPinned("files", expanded);
        await setPinned("log", expanded);
        await expectDesktopGeometry(expanded ? 245 : 30, expanded ? 350 : 30);
        if (!expanded) {
          await files.hover();
          await expect(files).toHaveClass(/is-peeking/);
          await finishPeek(files);
          await expectDesktopGeometry(245, 30);
          await page.mouse.move(1, 1);
          await log.hover();
          await expect(log).toHaveClass(/is-peeking/);
          await finishPeek(log);
          await expectDesktopGeometry(30, 350);
          await page.mouse.move(1, 1);
        }
      }
    }
  }

  // Exercise the icon's real handler against a real edited jj workspace.
  // Waiting for its request verifies more than a synthetic click counter.
  await setPinned("files", true);
  await page
    .locator('.file-tree [data-item-path="src/notifications.ts"]')
    .click();
  const sourcePath = path.join(repoPath, "src/notifications.ts");
  await writeFile(
    sourcePath,
    (await readFile(sourcePath, "utf8")).replace(
      "return `[orbit] ${notification.subject.trim()}`;",
      "return `[chrome-refresh] ${notification.subject.trim()}`;",
    ),
  );
  const stateResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/state") &&
      response.request().method() === "GET",
  );
  await refresh.click();
  assert.equal((await stateResponse).status(), 200);
  await expect(page.locator(".code-surface")).toContainText("[chrome-refresh]");
  console.log(
    "Terminal chrome, native-cursor/header pixels, mobile geometry matrix, desktop rails and real icon Refresh passed",
  );
}
assert.deepEqual(errors, []);

async function finishPeek(locator: typeof files) {
  await locator.evaluate((element) =>
    element.getAnimations().forEach((animation) => animation.finish()),
  );
}

async function setPinned(side: "files" | "log", expanded: boolean) {
  await page.mouse.move(1, 1);
  const collapsed = (await workspace.getAttribute("class"))!.includes(
    `${side}-collapsed`,
  );
  if (collapsed === expanded)
    await (side === "files" ? files : log).locator(".sidebar-toggle").click();

  if (expanded)
    await expect(workspace).not.toHaveClass(new RegExp(`${side}-collapsed`));
  else await expect(workspace).toHaveClass(new RegExp(`${side}-collapsed`));
  await page.mouse.move(1, 1);
}

async function setTerminal(open: boolean) {
  await page.mouse.move(1, 1);
  const currentlyOpen = (await workspace.getAttribute("class"))!.includes(
    "terminal-open",
  );
  if (open !== currentlyOpen) {
    if (open) await terminalButton.click();
    else
      await panel
        .getByRole("button", { name: "Hide terminal", exact: true })
        .click();
  }
  if (open) await expect(panel).toBeVisible();
  else await expect(panel).toBeHidden();
}

async function expectNarrowGeometry(label: string) {
  await expect
    .poll(
      async () => {
        const [work, graph, sidebar, viewer] = await Promise.all([
          workspace.boundingBox(),
          log.boundingBox(),
          files.boundingBox(),
          page.locator(".viewer").boundingBox(),
        ]);
        if (!work || !graph || !sidebar || !viewer) return false;
        return (
          graph.x === work.x &&
          graph.width === work.width &&
          graph.y + graph.height === work.y + work.height &&
          sidebar.y === viewer.y &&
          sidebar.y + sidebar.height === viewer.y + viewer.height
        );
      },
      {
        message: `full-width bottom log, files confined to diff row: ${label}`,
      },
    )
    .toBe(true);
}

async function expectDesktopGeometry(filesWidth: number, logWidth: number) {
  await expect
    .poll(
      async () => {
        const [work, graph, sidebar] = await Promise.all([
          workspace.boundingBox(),
          log.boundingBox(),
          files.boundingBox(),
        ]);
        if (!work || !graph || !sidebar) return false;
        return (
          sidebar.x === work.x &&
          sidebar.y === work.y &&
          sidebar.width === filesWidth &&
          sidebar.height === work.height &&
          graph.y === work.y &&
          graph.height === work.height &&
          graph.width === logWidth &&
          graph.x + graph.width === work.x + work.width
        );
      },
      { message: "desktop sidebars remain full-height outer columns" },
    )
    .toBe(true);
}
