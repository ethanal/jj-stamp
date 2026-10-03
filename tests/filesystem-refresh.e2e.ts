import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express, { type Response } from "express";
import { expect, type Page, type Route } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { projectSquash, refsFromSelection } from "../src/optimistic.ts";
import type { DiffFile, RepoState, Revision } from "../src/types.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

type BrowserControls = {
  focused: boolean;
  visibility: DocumentVisibilityState;
};

type TestWindow = Window &
  typeof globalThis & {
    __filesystemControls: BrowserControls;
    __filesystemMutations?: string[];
    __filesystemObserver?: MutationObserver;
  };

async function installControlledClock(page: Page) {
  // A source string is deliberate: tsx's keep-names helper is unavailable in
  // Playwright's isolated init-script world.
  await page.addInitScript(`
    const controls = { focused: true, visibility: "visible" };
    Object.defineProperty(window, "__filesystemControls", { value: controls });
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => controls.focused,
    });
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => controls.visibility,
    });
  `);
  await page.clock.install({ time: new Date("2026-10-02T12:00:00Z") });
}

async function pauseClock(page: Page) {
  // Leave enough headroom for the protocol round trip between reading and
  // applying fake time; pauseAt rejects timestamps already in the past.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}

async function setEnvironment(
  page: Page,
  update: Partial<BrowserControls>,
  event?: "blur" | "focus" | "visibilitychange",
) {
  await page.evaluate(
    ({ update, event }) => {
      Object.assign((window as TestWindow).__filesystemControls, update);
      if (event === "visibilitychange")
        document.dispatchEvent(new Event("visibilitychange"));
      else if (event) window.dispatchEvent(new Event(event));
    },
    { update, event },
  );
}

async function flushPage(page: Page) {
  // A new protocol task runs after EventSource, fetch, and React microtasks.
  await page.evaluate(() => undefined);
}

async function realRepositoryCoverage() {
  const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-events-"));
  await using resources = new AsyncDisposableStack();
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const repoPath = await createDemo(directory);
  const service = new ReviewService({ repoPath });
  resources.defer(() => service.drain());
  const app = express();
  const api = createApi(service);
  resources.defer(() => api.closeEvents());
  app.use("/api", api);
  const fixture = await createBrowserFixture({ app });
  resources.defer(() => fixture.close());
  const { page, url, errors } = fixture;
  await installControlledClock(page);

  let reads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/state")) reads++;
  });
  const nextState = () =>
    page.waitForResponse((response) => response.url().endsWith("/api/state"));

  const connected = page.waitForResponse((response) =>
    response.url().endsWith("/api/events"),
  );
  await page.goto(url);
  await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
  await expect(
    page.locator('[data-line-type="change-addition"]').first(),
  ).toBeVisible();
  assert.equal((await connected).status(), 200);
  await flushPage(page);
  assert.equal(reads, 1, "initial state is loaded exactly once");

  // Pausing advances through the named ready event's one-second catch-up. It is
  // not the beginning of a recurring polling loop.
  let response = nextState();
  await pauseClock(page);
  assert.equal((await response).status(), 200);
  await flushPage(page);
  assert.equal(reads, 2);

  // getState may create its own jj metadata snapshot. Its matching operation
  // event is acknowledged rather than feeding a state-read loop.
  await new Promise((resolve) => setTimeout(resolve, 150));
  await page.clock.runFor(60_000);
  await flushPage(page);
  assert.equal(reads, 2, "idle observation must issue no recurring reads");

  // A real editor-style save is found by the filesystem watcher, without a
  // focus/visibility event or a periodic timer.
  await page
    .locator('.file-tree [data-item-path="src/preferences.ts"]')
    .click();
  await expect(page.locator(".file-bar")).toContainText("src/preferences.ts");
  const preferencePath = path.join(repoPath, "src/preferences.ts");
  await writeFile(
    preferencePath,
    (await readFile(preferencePath, "utf8")).replace(
      "push: false,",
      "push: false, // filesystem refresh",
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  response = nextState();
  await page.clock.runFor(1_000);
  assert.equal((await response).status(), 200);
  await flushPage(page);
  await expect(page.locator(".code-surface")).toContainText(
    "// filesystem refresh",
  );
  assert.equal(reads, 3);

  await new Promise((resolve) => setTimeout(resolve, 100));
  await page.clock.runFor(30_000);
  await flushPage(page);
  assert.equal(reads, 3, "a saved snapshot must not trigger itself forever");
  assert.deepEqual(errors, []);
}

const revisionA: Revision = {
  changeId: "change-a",
  commitId: "a".repeat(40),
  description: "Change A",
};
const revisionB: Revision = {
  changeId: "change-b",
  commitId: "b".repeat(40),
  description: "Change B",
};
const parentRevision: Revision = {
  changeId: "parent",
  commitId: "c".repeat(40),
  description: "Parent",
};

function diff(label: string): DiffFile {
  return {
    path: "example.txt",
    additions: 1,
    deletions: 1,
    patch: `diff --git a/example.txt b/example.txt\n--- a/example.txt\n+++ b/example.txt\n@@ -1,3 +1,3 @@\n before\n-old ${label}\n+new ${label}\n after\n`,
    hunks: [
      {
        id: `hunk-${label}`,
        header: "@@ -1,3 +1,3 @@",
        rows: [
          { index: 1, raw: " before", oldLine: 1, newLine: 1 },
          { index: 2, raw: `-old ${label}`, oldLine: 2 },
          { index: 3, raw: `+new ${label}`, newLine: 2 },
          { index: 4, raw: " after", oldLine: 3, newLine: 3 },
        ],
      },
    ],
  };
}

const operationIds = {
  initial: "1".repeat(64),
  burst: "2".repeat(64),
  disconnected: "3".repeat(64),
  drag: "4".repeat(64),
  manual: "5".repeat(64),
  navigation: "6".repeat(64),
  squash: "7".repeat(64),
  halted: "8".repeat(64),
};

function mockedState(
  label: string,
  source = revisionA,
  operation = operationIds.initial,
): RepoState {
  return {
    repo: { name: "event-fixture", path: "/fixture/events" },
    version: `version-${label}`,
    source,
    parent: parentRevision,
    targets: [],
    files: [diff(label)],
    operation,
    canUndo: false,
  };
}

type HeldState = {
  ready: Promise<void>;
  release(): void;
  done: Promise<void>;
};

async function controlledServerCoverage() {
  let current = mockedState("initial");
  let failSquash = false;
  const eventClients = new Set<Response>();
  let eventConnections = 0;
  let eventCloses = 0;
  const app = express();
  app.use(express.json());
  app.get("/api/events", (request, response) => {
    eventConnections++;
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.flushHeaders();
    eventClients.add(response);
    request.once("close", () => {
      if (eventClients.delete(response)) eventCloses++;
    });
  });
  app.get("/api/state", (_request, response) => response.json(current));
  app.get("/api/graph", (_request, response) =>
    response.json({
      version: current.version,
      rows: [
        { graph: "@ ", revision: current.source, mutable: true },
        { graph: "○ ", revision: revisionB, mutable: true },
        { graph: "○ ", revision: parentRevision, mutable: true },
      ],
    }),
  );
  app.post("/api/commit", (request, response) => {
    const revision = [revisionA, revisionB, parentRevision].find(
      (item) => item.commitId === request.body.commitId,
    );
    response.json({
      repo: current.repo,
      commitId: request.body.commitId,
      baseCommitId: null,
      files: [diff(revision?.changeId ?? "cached")],
    });
  });
  app.post("/api/commit-file", (request, response) =>
    response.json({
      oldFile: { name: request.body.path, contents: "before\nold\nafter\n" },
      newFile: { name: request.body.path, contents: "before\nnew\nafter\n" },
    }),
  );
  app.post("/api/revision", (request, response) => {
    current = mockedState(
      request.body.changeId === revisionB.changeId ? "navigation" : "initial",
      request.body.changeId === revisionB.changeId ? revisionB : revisionA,
      request.body.changeId === revisionB.changeId
        ? operationIds.navigation
        : operationIds.initial,
    );
    response.json({ state: current });
  });
  app.post("/api/squash-lines", (request, response) => {
    if (failSquash) {
      response.status(500).json({
        error: "Deliberate squash failure",
        code: "TOOL_FAILED",
        output: "filesystem fixture diagnostics",
      });
      return;
    }
    const refs = refsFromSelection(
      current,
      Object.fromEntries(
        request.body.selections.map(
          (selection: { id: string; lines: number[] }) => [
            selection.id,
            selection.lines,
          ],
        ),
      ),
    );
    const projected = structuredClone(projectSquash(current, refs));
    projected.version = `${current.version}-squashed`;
    projected.operation = operationIds.squash;
    projected.canUndo = true;
    current = projected;
    response.json({ state: current });
  });

  await using resources = new AsyncDisposableStack();
  resources.defer(() => {
    for (const client of eventClients) client.end();
  });
  const fixture = await createBrowserFixture({ app });
  resources.defer(() => fixture.close());
  const { page, url, errors } = fixture;
  await installControlledClock(page);

  let reads = 0;
  let failureBudget = 0;
  let armed:
    | {
        body: RepoState;
        capture(): void;
        gate: Promise<void>;
        finish(): void;
        taken: boolean;
      }
    | undefined;
  await page.route("**/api/state", async (route: Route) => {
    reads++;
    if (armed && !armed.taken) {
      const request = armed;
      request.taken = true;
      request.capture();
      await request.gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(request.body),
      });
      request.finish();
      return;
    }
    if (failureBudget > 0) {
      failureBudget--;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Temporary filesystem refresh failure",
          code: "SERVER_ERROR",
        }),
      });
      return;
    }
    await route.continue();
  });

  function sendEvent(name: "ready" | "change" | "unavailable", data: unknown) {
    const frame = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of eventClients) client.write(frame);
  }
  async function deliverEvent(
    name: "ready" | "change" | "unavailable",
    data: unknown,
  ) {
    sendEvent(name, data);
    await flushPage(page);
  }
  function holdNextState(body: RepoState): HeldState {
    assert.equal(armed, undefined);
    let capture!: () => void;
    let release!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      capture = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    armed = { body, capture, gate, finish, taken: false };
    void done.then(() => {
      armed = undefined;
    });
    return { ready, release, done };
  }
  async function advanceToHeld(held: HeldState, milliseconds = 1_000) {
    await page.clock.runFor(milliseconds);
    await held.ready;
  }
  async function advanceToState(milliseconds: number, status = 200) {
    const response = page.waitForResponse((item) =>
      item.url().endsWith("/api/state"),
    );
    await page.clock.runFor(milliseconds);
    assert.equal((await response).status(), status);
    await flushPage(page);
  }
  async function expectConnections(active: number) {
    await expect.poll(() => eventClients.size).toBe(active);
  }

  const connected = page.waitForResponse((response) =>
    response.url().endsWith("/api/events"),
  );
  await page.goto(url);
  await expect(page.locator(".code-surface")).toContainText("new initial");
  assert.equal((await connected).status(), 200);
  await expectConnections(1);
  await expect(page.locator(".log-change:enabled").first()).toBeVisible();
  assert.equal(reads, 1);
  // The mock withholds ready, so the fully rendered UI can be paused without
  // accidentally consuming an event debounce. networkidle is invalid for SSE.
  await pauseClock(page);

  await page.locator('[data-line-type="change-addition"]').first().click();
  await expect(
    page.locator("[data-line][data-fold-selected]").first(),
  ).toBeVisible();
  const surface = await page.locator(".code-surface").elementHandle();
  assert(surface);
  const scrollTop = await page.locator(".viewer-scroll").evaluate((element) => {
    element.scrollTop = 20;
    return element.scrollTop;
  });
  const before = await page.locator(".app").evaluate((app) => ({
    html: app.innerHTML,
    buttons: Array.from(app.querySelectorAll("button")).map((button) => ({
      name: button.getAttribute("aria-label") ?? button.textContent,
      disabled: button.disabled,
      ariaDisabled: button.getAttribute("aria-disabled"),
    })),
    status: app.querySelector(".statusbar")?.textContent,
  }));
  await page.locator(".app").evaluate((app) => {
    const target = window as TestWindow;
    target.__filesystemMutations = [];
    target.__filesystemObserver = new MutationObserver((records) => {
      target.__filesystemMutations!.push(
        ...records.map(
          (record) =>
            `${record.type}:${record.attributeName ?? ""}:${record.target.nodeName}`,
        ),
      );
    });
    target.__filesystemObserver.observe(app, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });

  // Ready is a one-second catch-up, but an unchanged read is completely quiet:
  // no lock, render replacement, selection loss, scroll jump, or transient DOM.
  await deliverEvent("ready", {});
  await page.clock.runFor(999);
  await flushPage(page);
  assert.equal(reads, 1);
  await advanceToState(1);
  assert.equal(reads, 2);
  assert(await surface.evaluate((element) => element.isConnected));
  assert.equal(
    await page
      .locator(".viewer-scroll")
      .evaluate((element) => element.scrollTop),
    scrollTop,
  );
  assert.deepEqual(
    await page.locator(".app").evaluate((app) => ({
      html: app.innerHTML,
      buttons: Array.from(app.querySelectorAll("button")).map((button) => ({
        name: button.getAttribute("aria-label") ?? button.textContent,
        disabled: button.disabled,
        ariaDisabled: button.getAttribute("aria-disabled"),
      })),
      status: app.querySelector(".statusbar")?.textContent,
    })),
    before,
  );
  assert.deepEqual(
    await page.evaluate(() => (window as TestWindow).__filesystemMutations),
    [],
    "unchanged event refreshes must not mutate the DOM",
  );
  await page.evaluate(() =>
    (window as TestWindow).__filesystemObserver?.disconnect(),
  );

  await page.clock.runFor(60_000);
  await flushPage(page);
  assert.equal(reads, 2, "an open event stream must not poll while idle");

  // A metadata-only hint for the state operation already acknowledged by the
  // app is consumed without a state read. IDs are valid 32-128 digit hex.
  await deliverEvent("change", {
    workspace: false,
    heads: [current.operation],
  });
  await page.clock.runFor(2_000);
  await flushPage(page);
  assert.equal(reads, 2);

  // Bursts use a trailing one-second edge and coalesce to a single state read.
  current = mockedState("burst", revisionA, operationIds.burst);
  await deliverEvent("change", {
    workspace: true,
    heads: ["a".repeat(64)],
  });
  await page.clock.runFor(600);
  await deliverEvent("change", {
    workspace: true,
    heads: [operationIds.burst],
  });
  await page.clock.runFor(999);
  await flushPage(page);
  assert.equal(reads, 2);
  await advanceToState(1);
  assert.equal(reads, 3);
  await expect(page.locator(".code-surface")).toContainText("new burst");

  // Background failures are silent and never create a timer retry. A later
  // event can revalidate normally.
  failureBudget = 1;
  await deliverEvent("change", { workspace: true, heads: null });
  await advanceToState(1_000, 503);
  assert.equal(reads, 4);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.clock.runFor(120_000);
  await flushPage(page);
  assert.equal(reads, 4, "failed event reads must not retry on a timer");
  await deliverEvent("change", {
    workspace: true,
    heads: [operationIds.burst],
  });
  await advanceToState(1_000);
  assert.equal(reads, 5);

  // Blur and hide tear down the stream. Visibility alone cannot reconnect an
  // unfocused document; focus reopens it only after initial state exists.
  await setEnvironment(page, { focused: false }, "blur");
  await expectConnections(0);
  assert.equal(eventCloses, 1);
  current = mockedState("disconnected", revisionA, operationIds.disconnected);
  await page.clock.runFor(10_000);
  assert.equal(reads, 5);
  await setEnvironment(page, { visibility: "hidden" }, "visibilitychange");
  await setEnvironment(page, { visibility: "visible" }, "visibilitychange");
  await flushPage(page);
  assert.equal(eventClients.size, 0);

  const reconnected = page.waitForResponse((response) =>
    response.url().endsWith("/api/events"),
  );
  await setEnvironment(page, { focused: true }, "focus");
  assert.equal((await reconnected).status(), 200);
  await expectConnections(1);
  // Existing focus refresh remains the immediate fallback path.
  await advanceToState(100);
  assert.equal(reads, 6);
  await expect(page.locator(".code-surface")).toContainText("new disconnected");
  await deliverEvent("ready", {});
  await advanceToState(1_000);
  assert.equal(reads, 7);
  assert.equal(eventConnections, 2);

  // Hiding an active document also closes its stream.
  await setEnvironment(page, { visibility: "hidden" }, "visibilitychange");
  await expectConnections(0);
  assert.equal(eventCloses, 2);
  const visibleAgain = page.waitForResponse((response) =>
    response.url().endsWith("/api/events"),
  );
  await setEnvironment(
    page,
    { visibility: "visible", focused: true },
    "visibilitychange",
  );
  assert.equal((await visibleAgain).status(), 200);
  await expectConnections(1);
  await advanceToState(100);
  assert.equal(reads, 8);
  // Consume the reconnect catch-up before the drag scenario.
  await deliverEvent("ready", {});
  await advanceToState(1_000);
  assert.equal(reads, 9);

  // Dirty state remains pending throughout a range drag and becomes eligible
  // immediately after mouseup; no focus event is needed.
  const added = page.locator('[data-line-type="change-addition"]').first();
  await added.scrollIntoViewIfNeeded();
  const box = await added.boundingBox();
  assert(box);
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await page.mouse.down();
  await expect(
    page.locator("[data-line][data-fold-selected]").first(),
  ).toBeVisible();
  current = mockedState("drag", revisionA, operationIds.drag);
  await deliverEvent("change", {
    workspace: true,
    heads: [operationIds.drag],
  });
  const dragReads = reads;
  await page.clock.runFor(10_000);
  await flushPage(page);
  assert.equal(reads, dragReads, "dragging must defer dirty state");
  const afterDrag = page.waitForResponse((item) =>
    item.url().endsWith("/api/state"),
  );
  await page.mouse.up();
  await flushPage(page);
  await page.clock.runFor(1);
  assert.equal((await afterDrag).status(), 200);
  await expect(page.locator(".code-surface")).toContainText("new drag");
  assert.equal(reads, dragReads + 1);

  // A slow event read never locks the interface or overlaps another. Manual
  // refresh overtakes its stale response, while changes received during the
  // await remain coalesced into one delayed follow-up check.
  let held = holdNextState(mockedState("stale-manual"));
  await deliverEvent("change", { workspace: true, heads: null });
  await advanceToHeld(held);
  await expect(
    page.getByRole("button", { name: "refresh r", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".statusbar")).not.toContainText("Refreshing…");
  const heldReads = reads;
  await deliverEvent("change", {
    workspace: true,
    heads: ["b".repeat(64)],
  });
  await deliverEvent("change", {
    workspace: false,
    heads: ["c".repeat(64)],
  });
  await page.clock.runFor(20_000);
  await flushPage(page);
  assert.equal(reads, heldReads, "event reads must serialize");
  current = mockedState("manual", revisionA, operationIds.manual);
  const manual = page.waitForResponse((item) =>
    item.url().endsWith("/api/state"),
  );
  await page.keyboard.press("r");
  assert.equal((await manual).status(), 200);
  await expect(page.locator(".code-surface")).toContainText("new manual");
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).not.toContainText("stale-manual");
  const followManual = reads;
  await advanceToState(1_000);
  assert.equal(reads, followManual + 1, "overtaken invalidation is retained");

  // Revision navigation similarly wins over a stale filesystem response.
  held = holdNextState(mockedState("stale-navigation"));
  await deliverEvent("change", { workspace: true, heads: null });
  await advanceToHeld(held);
  const navigated = page.waitForResponse((item) =>
    item.url().endsWith("/api/revision"),
  );
  await page
    .getByRole("button", {
      name: `Review change ${revisionB.changeId}`,
      exact: true,
    })
    .click();
  assert.equal((await navigated).status(), 200);
  await expect(page.locator(".code-surface")).toContainText("new navigation");
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).not.toContainText(
    "stale-navigation",
  );
  await advanceToState(1_000);
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    revisionB.changeId,
  );

  // A queue epoch/confirmed change wins too. The stale pre-squash state cannot
  // restore a line, and the retained invalidation checks once after the queue.
  const selectable = page.locator(
    '[data-line-type="change-deletion"], [data-line-type="change-addition"]',
  );
  await selectable.first().click();
  held = holdNextState(mockedState("stale-squash", revisionB));
  await deliverEvent("change", { workspace: true, heads: null });
  await advanceToHeld(held);
  const squashed = page.waitForResponse((item) =>
    item.url().endsWith("/api/squash-lines"),
  );
  await page.keyboard.press("s");
  assert.equal((await squashed).status(), 200);
  await expect(page.locator(".statusbar")).toContainText("1 line squashed.");
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).not.toContainText("stale-squash");
  await advanceToState(1_000);
  await expect(page.locator(".statusbar")).toContainText("1 line squashed.");

  // Failed queues remain halted. Filesystem hints cannot silently authorize or
  // recover them, even after diagnostics are dismissed and much time passes.
  failSquash = true;
  await selectable.first().click();
  const failed = page.waitForResponse((item) =>
    item.url().endsWith("/api/squash-lines"),
  );
  const recovery = page.waitForResponse((item) =>
    item.url().endsWith("/api/state"),
  );
  await page.keyboard.press("s");
  assert.equal((await failed).status(), 500);
  assert.equal((await recovery).status(), 200);
  await expect(page.getByRole("alert")).toContainText(
    "Deliberate squash failure",
  );
  const haltedReads = reads;
  await page.keyboard.press("Escape");
  current = mockedState("must-not-recover", revisionB, operationIds.halted);
  await deliverEvent("change", {
    workspace: true,
    heads: [operationIds.halted],
  });
  await page.clock.runFor(120_000);
  await flushPage(page);
  assert.equal(reads, haltedReads, "halted queues must ignore event refreshes");
  await expect(page.locator(".code-surface")).not.toContainText(
    "must-not-recover",
  );
  await expect(
    page.getByRole("button", { name: "s squash", exact: true }),
  ).toBeDisabled();

  // The server's explicit unavailable event is terminal for this page session;
  // the browser must not reconnect it on an error timer.
  await deliverEvent("unavailable", {});
  await expectConnections(0);
  const finalConnections = eventConnections;
  await page.clock.runFor(120_000);
  await flushPage(page);
  assert.equal(eventConnections, finalConnections);
  assert.deepEqual(errors, []);
}

await realRepositoryCoverage();
await controlledServerCoverage();
console.log(
  "Filesystem refresh: real saves, idle streams, quiet batching, focus gates, deferral, races, and halted guards passed.",
);
