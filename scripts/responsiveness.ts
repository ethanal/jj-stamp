// Production-only smoke benchmark; never opens or changes the caller's jj repo.
// Build separately, then: npx tsx scripts/responsiveness.ts --runs 3 --extra-files 50
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { chromium, type Page, type Request } from "@playwright/test";
import { startLocalServer } from "../server/http.ts";
import { jj } from "../server/process.ts";
import { ReviewService } from "../server/service.ts";
import type { OperationTiming } from "../server/timing.ts";
import { createDemo } from "../tests/fixtures.ts";

const { values } = parseArgs({
  options: {
    runs: { type: "string", default: "3" },
    "extra-files": { type: "string", default: "50" },
    "scope-functions": { type: "string", default: "200" },
    assets: { type: "string", default: "dist/client" },
    output: { type: "string" },
    "source-label": { type: "string" },
  },
});
const runs = Number(values.runs);
const extraFiles = Number(values["extra-files"]);
const functions = Number(values["scope-functions"]);
for (const [name, value, min, max] of [
  ["runs", runs, 1, 100],
  ["extra-files", extraFiles, 0, 1000],
  ["scope-functions", functions, 2, 1000],
] as const)
  assert(
    Number.isSafeInteger(value) && value >= min && value <= max,
    `${name}: use ${min}..${max}`,
  );
const assets = path.resolve(values.assets);
const indexPath = path.join(assets, "index.html");
const index = await readFile(indexPath, "utf8").catch(() => {
  throw new Error(
    `Missing ${indexPath}. Build production assets separately; this benchmark never builds or starts Vite.`,
  );
});
const assetFiles = [
  ...index.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g),
].map((match) => match[1]);
const hash = createHash("sha256").update(index);
for (const file of assetFiles)
  hash.update(await readFile(path.join(assets, file)));
function command(name: string, args: string[]) {
  try {
    return execFileSync(name, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unavailable";
  }
}
const scopePath = "src/00-responsiveness.ts";
const otherPath = "src/notifications.ts";
const baseScope = Array.from({ length: functions }, (_, i) =>
  [
    `export function scope${i}(input: number): number {`,
    "  let result = input;",
    ...Array.from({ length: 24 }, (_, line) => `  result += ${line + 1};`),
    "  return result;",
    "}",
    "",
  ].join("\n"),
).join("\n");
const changedScope = baseScope.replaceAll(
  "  result += 15;",
  "  result += 150;",
);
type Entry = { startTime: number; duration: number; name: string };
type BrowserMetrics = {
  longTasks: Entry[];
  events: Entry[];
  supported: string[];
};
type ApiRequest = {
  path: string;
  file?: string;
  startMs: number;
  durationMs?: number;
  status?: number;
  failure?: string;
};
const samples: unknown[] = [];
const summary: Array<Record<string, string | number>> = [];
let browserVersion = "";

for (let run = 1; run <= runs; run++) {
  await using resources = new AsyncDisposableStack();
  const dataDir = await mkdtemp(
    path.join(os.tmpdir(), "jj-stamp-responsiveness-"),
  );
  resources.defer(() => rm(dataDir, { recursive: true, force: true }));
  const repoPath = await createDemo(dataDir);
  // Preserve the demo's working-copy delta while inserting a large unchanged
  // TypeScript file into its parent. Every history edit stays in this fixture.
  const demoPaths = [
    "src/notifications.ts",
    "src/preferences.ts",
    "tests/notifications.test.ts",
  ];
  const original = await Promise.all(
    demoPaths.map((file) => readFile(path.join(repoPath, file), "utf8")),
  );
  for (const file of demoPaths) {
    const parent = await jj(repoPath, ["file", "show", "-r", "@-", file]);
    await writeFile(path.join(repoPath, file), parent.stdout);
  }
  await writeFile(path.join(repoPath, scopePath), baseScope);
  await jj(repoPath, ["commit", "-m", "Responsiveness fixture base"]);
  for (let i = 0; i < demoPaths.length; i++)
    await writeFile(path.join(repoPath, demoPaths[i]), original[i]);
  await writeFile(path.join(repoPath, scopePath), changedScope);
  for (let i = 0; i < extraFiles; i++)
    await writeFile(
      path.join(repoPath, `zz-extra-${i}.txt`),
      `extra file ${i}\n`,
    );
  await jj(repoPath, ["describe", "-m", "Responsiveness fixture changes"]);
  await jj(repoPath, ["status"]);
  const operations: OperationTiming[] = [];
  const service = new ReviewService({
    repoPath,
    onTiming: (record) => {
      operations.push(record);
    },
  });
  const server = await startLocalServer({
    service,
    assetsDir: assets,
    port: 0,
  });
  resources.defer(() => server.close());
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  resources.defer(() => browser.close());
  browserVersion = browser.version();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  page.setDefaultTimeout(30_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const metrics: BrowserMetrics = {
      longTasks: [],
      events: [],
      supported: [...PerformanceObserver.supportedEntryTypes],
    };
    Object.assign(window, { __responsiveness: metrics });
    for (const type of ["longtask", "event"]) {
      if (!metrics.supported.includes(type)) continue;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          (type === "longtask" ? metrics.longTasks : metrics.events).push({
            startTime: entry.startTime,
            duration: entry.duration,
            name: entry.name,
          });
      }).observe({
        type,
        buffered: true,
        ...(type === "event" ? { durationThreshold: 16 } : {}),
      });
    }
  });
  const requests: ApiRequest[] = [];
  const requestMap = new Map<Request, ApiRequest>();
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return;
    const entry: ApiRequest = {
      path: pathname,
      startMs: performance.now(),
      file: request.postDataJSON()?.path,
    };
    requestMap.set(request, entry);
    requests.push(entry);
  });
  page.on("requestfinished", (request) => {
    const entry = requestMap.get(request);
    if (entry) {
      // Node-side Playwright event delivery can be delayed by browser long
      // tasks. Use the protocol's network timestamps, not callback wall time.
      const timing = request.timing();
      entry.startMs = timing.startTime - performance.timeOrigin;
      entry.durationMs = timing.responseEnd;
    }
  });
  page.on("response", (response) => {
    const entry = requestMap.get(response.request());
    if (entry) entry.status = response.status();
  });
  page.on("requestfailed", (request) => {
    const entry = requestMap.get(request);
    if (entry) entry.failure = request.failure()?.errorText;
  });
  const section = (file: string) =>
    page.locator(`.file-diff-section[data-file-path="${file}"]`);
  const tree = (file: string) =>
    page.locator(`.file-tree [role="treeitem"][data-item-path="${file}"]`);
  const frames = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  async function phase(
    name: string,
    action: () => Promise<unknown>,
    file?: string,
    scope = false,
  ) {
    const requestStart = requests.length,
      operationStart = operations.length;
    const browserStart =
      name === "cold load" ? 0 : await page.evaluate(() => performance.now());
    const start = performance.now();
    await action();
    if (file)
      await section(file)
        .locator("[data-line]")
        .first()
        .waitFor({ state: "visible" });
    await frames(page);
    const diffPaintMs = performance.now() - start;
    if (scope && file) {
      await section(file)
        .locator("[data-fold-hunk-context]")
        .first()
        .waitFor({ state: "visible" });
      await frames(page);
    }
    const readyMs = scope ? performance.now() - start : diffPaintMs;
    // Drain network and observer callbacks outside the reported interaction time.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(100);
    const metrics = await page.evaluate(
      () =>
        (window as unknown as { __responsiveness: BrowserMetrics })
          .__responsiveness,
    );
    const longTasks = metrics.longTasks.filter(
      (entry) => entry.startTime >= browserStart,
    );
    const events = metrics.events.filter(
      (entry) => entry.startTime >= browserStart,
    );
    const api = requests
      .slice(requestStart)
      .map((entry) => ({ ...entry, startMs: entry.startMs - start }));
    const service = operations.slice(operationStart);
    const result = {
      run,
      phase: name,
      diffPaintMs,
      readyMs,
      api,
      service,
      longTasks,
      events,
      observerSupported: metrics.supported,
    };
    samples.push(result);
    summary.push({
      run,
      phase: name,
      paintMs: Math.round(diffPaintMs),
      readyMs: Math.round(readyMs),
      fileRequests: api.filter((entry) =>
        ["/api/file", "/api/commit-file"].includes(entry.path),
      ).length,
      longTasks: longTasks.length,
      longTaskMs: Math.round(
        longTasks.reduce((sum, entry) => sum + entry.duration, 0),
      ),
      maxQueueMs: Math.round(
        Math.max(0, ...service.map((entry) => entry.queueMs)),
      ),
    });
    assert(
      api.every((entry) => entry.status === 200 && !entry.failure),
      `Failed API request during ${name}: ${JSON.stringify(api)}`,
    );
    assert.deepEqual(errors, [], "Browser page errors");
  }
  await phase(
    "cold load",
    () => page.goto(server.url, { waitUntil: "domcontentloaded" }),
    scopePath,
    true,
  );
  await phase(
    "select changed line",
    async () => {
      await section(scopePath)
        .locator('[data-line-type="change-addition"]')
        .first()
        .click();
      await section(scopePath)
        .locator("[data-fold-selected]")
        .first()
        .waitFor();
    },
    scopePath,
  );
  async function expandContext() {
    const firstLine = await section(scopePath)
      .locator("[data-line]")
      .evaluateAll((rows) =>
        Math.min(...rows.map((row) => Number(row.getAttribute("data-line")))),
      );
    await page
      .getByRole("button", { name: "Show 10 lines above", exact: true })
      .first()
      .click();
    await section(scopePath)
      .locator(`[data-line="${Math.max(1, firstLine - 10)}"]`)
      .first()
      .waitFor({ state: "visible" });
  }
  await phase("expand context", expandContext, scopePath);
  await phase("navigate cold", () => tree(otherPath).click(), otherPath, true);
  await phase("revisit warm", () => tree(scopePath).click(), scopePath, true);
  await phase("expand revisit", expandContext, scopePath);
  await phase("read contention burst", () =>
    page.evaluate(async (file) => {
      const state = await fetch("/api/state").then((response) =>
        response.json(),
      );
      const responses = await Promise.all([
        fetch("/api/graph"),
        fetch("/api/state"),
        ...Array.from({ length: 4 }, () =>
          fetch("/api/file", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Fold-Request": "1",
            },
            body: JSON.stringify({ version: state.version, path: file }),
          }),
        ),
      ]);
      for (const response of responses) {
        if (!response.ok)
          throw new Error(`Contention probe: HTTP ${response.status}`);
        await response.json();
      }
    }, scopePath),
  );
}
const report = {
  recordedAt: new Date().toISOString(),
  environment: {
    sourceLabel:
      values["source-label"] ?? command("git", ["rev-parse", "HEAD"]),
    workingTree: command("git", ["status", "--short"]),
    node: process.version,
    jj: command("jj", ["--version"]),
    browser: browserVersion,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    memoryBytes: os.totalmem(),
    assets,
    indexMtime: (await stat(indexPath)).mtime.toISOString(),
    entryAssetSha256: hash.digest("hex"),
  },
  fixture: {
    runs,
    changedFiles: extraFiles + 4,
    scopeFunctions: functions,
    scopeBytes: Buffer.byteLength(changedScope),
    scopeHunks: functions,
  },
  methodology:
    "Fresh browser/service/repo per run; warm OS cache. paintMs is action through DOM readiness plus two animation frames (not compositor paint); readyMs additionally waits for a visible scope label. Long tasks include network-idle plus 100ms settling. Request timings include transport; service queue/execution spans are separate. Event entries >=16ms are not INP. Scope label timing includes fetch, grammar loading, parsing, render and automation overhead, not isolated CPU parse time. Entry asset hash covers index and directly referenced assets, not lazy chunks. No performance thresholds.",
  summary,
  samples,
};
console.table(summary);
if (values.output) {
  const output = path.resolve(values.output);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Full measurements: ${output}`);
} else console.log(JSON.stringify(report, null, 2));
