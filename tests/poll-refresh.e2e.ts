import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect, type Page, type Route } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { projectSquash, refsFromSelection } from "../src/optimistic.ts";
import type { DiffFile, RepoState, Revision } from "../src/types.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

type PollControls = {
  focused: boolean;
  visibility: DocumentVisibilityState;
};

type TestWindow = Window &
  typeof globalThis & {
    __pollControls: PollControls;
    __pollMutations?: string[];
    __pollObserver?: MutationObserver;
  };

async function installControlledClock(page: Page) {
  // A source string is deliberate: tsx's keep-names helper is not available in
  // Playwright's isolated init-script world.
  await page.addInitScript(`
    const controls = { focused: true, visibility: "visible" };
    Object.defineProperty(window, "__pollControls", { value: controls });
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
  // applying the fake time; pauseAt rejects timestamps already in the past.
  await page.clock.pauseAt((await page.evaluate(() => Date.now())) + 1_000);
}

async function setPollEnvironment(
  page: Page,
  update: Partial<PollControls>,
  event?: "blur" | "focus" | "visibilitychange",
) {
  await page.evaluate(
    ({ update, event }) => {
      Object.assign((window as TestWindow).__pollControls, update);
      if (event === "visibilitychange")
        document.dispatchEvent(new Event("visibilitychange"));
      else if (event) window.dispatchEvent(new Event(event));
    },
    { update, event },
  );
}

async function flushPage(page: Page) {
  // A new protocol task runs after fetch continuations and React's microtasks.
  await page.evaluate(() => undefined);
}

async function realRepositoryCoverage() {
  const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-poll-"));
  await using resources = new AsyncDisposableStack();
  resources.defer(() => rm(directory, { recursive: true, force: true }));
  const repoPath = await createDemo(directory);
  const service = new ReviewService({ repoPath });
  resources.defer(() => service.drain());
  const app = express();
  app.use("/api", createApi(service));
  const fixture = await createBrowserFixture({ app });
  resources.defer(() => fixture.close());
  const { page, url, errors } = fixture;
  await installControlledClock(page);

  let reads = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/api/state")) reads++;
  });
  const stateResponse = () =>
    page.waitForResponse((response) => response.url().endsWith("/api/state"));
  const advanceToRead = async (milliseconds: number) => {
    const before = reads;
    const response = stateResponse();
    await page.clock.runFor(milliseconds);
    assert.equal((await response).status(), 200);
    await flushPage(page);
    assert.equal(reads, before + 1);
  };

  await page.goto(url);
  await expect(page.locator(".file-bar")).toContainText("src/notifications.ts");
  await expect(
    page.locator('[data-line-type="change-addition"]').first(),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await pauseClock(page);

  await page
    .locator('.file-tree [data-item-path="src/preferences.ts"]')
    .click();
  await expect(page.locator(".file-bar")).toContainText("src/preferences.ts");
  const added = page.locator('[data-line-type="change-addition"]').first();
  const selected = page.locator("[data-line][data-fold-selected]");
  await added.click();
  await expect(selected.first()).toBeVisible();
  const scrollTop = await page.locator(".viewer-scroll").evaluate((element) => {
    element.scrollTop = 40;
    return element.scrollTop;
  });
  const surface = await page.locator(".code-surface").elementHandle();
  assert(surface);
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
    target.__pollMutations = [];
    target.__pollObserver = new MutationObserver((records) => {
      target.__pollMutations!.push(
        ...records.map(
          (record) =>
            `${record.type}:${record.attributeName ?? ""}:${record.target.nodeName}`,
        ),
      );
    });
    target.__pollObserver.observe(app, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  });

  // Multiple unchanged polls are completely quiet: no busy flash, disabled
  // control, render replacement, selection loss, or scroll movement.
  await advanceToRead(2_100);
  await advanceToRead(2_000);
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
    await page.evaluate(() => (window as TestWindow).__pollMutations),
    [],
    "unchanged polls must not cause even transient DOM mutations",
  );

  // A real editor save is discovered by polling alone. No focus or visibility
  // event is sent, and the existing automatic replace explains stale selection.
  await page.evaluate(() =>
    (window as TestWindow).__pollObserver?.disconnect(),
  );
  const preferencePath = path.join(repoPath, "src/preferences.ts");
  await writeFile(
    preferencePath,
    (await readFile(preferencePath, "utf8")).replace(
      "push: false,",
      "push: false, // quiet poll",
    ),
  );
  await advanceToRead(2_000);
  await expect(page.locator(".code-surface")).toContainText("// quiet poll");
  await expect(selected).toHaveCount(0);
  await expect(page.locator(".statusbar")).toContainText(
    "Repository changed; selection cleared.",
  );

  // Scheduled checks keep ticking but issue no request while hidden or while the
  // document does not have focus. Restoring eligibility needs no focus event.
  await setPollEnvironment(page, { visibility: "hidden" }, "visibilitychange");
  // Let a request already dispatched at the visibility boundary finish; no
  // later timer may start a read while the page remains hidden.
  await page.clock.runFor(2_000);
  await flushPage(page);
  let count = reads;
  await page.clock.runFor(6_000);
  await flushPage(page);
  assert.equal(reads, count, "hidden pages must not poll");
  await setPollEnvironment(page, { visibility: "visible", focused: false });
  await page.clock.runFor(4_000);
  await flushPage(page);
  assert.equal(reads, count, "unfocused pages must not poll");

  // A drag suppresses every timer that expires under the pointer. Polling resumes
  // on a later scheduled check after mouseup, without a synthetic focus event.
  await setPollEnvironment(page, { focused: true });
  await added.scrollIntoViewIfNeeded();
  const box = await added.boundingBox();
  assert(box);
  await page.mouse.move(box.x + 80, box.y + box.height / 2);
  await page.mouse.down();
  await expect(selected.first()).toBeVisible();
  count = reads;
  await page.clock.runFor(4_000);
  await flushPage(page);
  assert.equal(reads, count, "an active range drag must suppress polling");
  await page.mouse.up();
  await advanceToRead(2_000);
  await expect(selected.first()).toBeVisible();

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

function mockedState(label: string, source = revisionA): RepoState {
  return {
    repo: { name: "poll-fixture", path: "/fixture/poll" },
    version: `version-${label}`,
    source,
    parent: parentRevision,
    targets: [],
    files: [diff(label)],
    operation: `operation-${label}`,
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
  const app = express();
  app.use(express.json());
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
    );
    response.json({ state: current });
  });
  app.post("/api/squash-lines", (request, response) => {
    if (failSquash) {
      response.status(500).json({
        error: "Deliberate squash failure",
        code: "TOOL_FAILED",
        output: "poll fixture diagnostics",
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
    projected.operation = `${current.operation}-squashed`;
    projected.canUndo = true;
    current = projected;
    response.json({ state: current });
  });

  await using resources = new AsyncDisposableStack();
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
          error: "Temporary poll failure",
          code: "SERVER_ERROR",
        }),
      });
      return;
    }
    await route.continue();
  });
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
  async function advanceToHeld(held: HeldState, milliseconds = 2_000) {
    await page.clock.runFor(milliseconds);
    await held.ready;
  }
  async function advanceToResponse(milliseconds: number, status: number) {
    const response = page.waitForResponse((item) =>
      item.url().endsWith("/api/state"),
    );
    await page.clock.runFor(milliseconds);
    assert.equal((await response).status(), status);
    await flushPage(page);
  }

  await page.goto(url);
  await expect(page.locator(".code-surface")).toContainText("new initial");
  await page.waitForLoadState("networkidle");
  await pauseClock(page);
  await page.locator('[data-line-type="change-addition"]').first().click();
  await expect(
    page.getByRole("button", { name: "s squash", exact: true }),
  ).toBeEnabled();

  // A slow poll never locks the interface and never overlaps another scheduled
  // poll. A foreground refresh may overtake it, and its stale completion loses.
  let held = holdNextState(mockedState("stale-poll"));
  const slowBefore = reads;
  await advanceToHeld(held, 2_100);
  await expect(
    page.getByRole("button", { name: "refresh r", exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "s squash", exact: true }),
  ).toBeEnabled();
  await expect(page.locator(".statusbar")).not.toContainText("Refreshing…");
  await page.clock.runFor(20_000);
  await flushPage(page);
  assert.equal(reads, slowBefore + 1, "slow polls must not overlap");

  current = mockedState("manual");
  const manual = page.waitForResponse((response) =>
    response.url().endsWith("/api/state"),
  );
  await page.keyboard.press("r");
  assert.equal((await manual).status(), 200);
  await expect(page.locator(".code-surface")).toContainText("new manual");
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).toContainText("new manual");
  await expect(page.locator(".code-surface")).not.toContainText("stale-poll");

  // Changing the selected range while a changed poll response is in flight
  // invalidates that response rather than clearing the new selection.
  held = holdNextState(mockedState("range-race"));
  await advanceToHeld(held);
  await page.locator('[data-line-type="change-addition"]').first().click();
  await expect(
    page.locator("[data-line][data-fold-selected]").first(),
  ).toBeVisible();
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).toContainText("new manual");
  await expect(
    page.locator("[data-line][data-fold-selected]").first(),
  ).toBeVisible();
  await expect(page.locator(".statusbar")).not.toContainText(
    "selection cleared",
  );
  await page.keyboard.press("Escape");

  // Blur/focus generations also make an old response unusable, independently of
  // whether the tab remained visible for the entire request.
  held = holdNextState(mockedState("blur-race"));
  await advanceToHeld(held);
  await setPollEnvironment(page, { focused: false }, "blur");
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).toContainText("new manual");
  await setPollEnvironment(page, { focused: true });

  // Stateful revision navigation overtakes an old poll. Its selected identity
  // and content cannot be rolled back when that poll finally returns.
  held = holdNextState(mockedState("navigation-race"));
  await advanceToHeld(held);
  const navigated = page.waitForResponse((response) =>
    response.url().endsWith("/api/revision"),
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
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    revisionB.changeId,
  );
  await expect(page.locator(".code-surface")).not.toContainText(
    "navigation-race",
  );

  // A queue epoch/confirmed identity change wins too. The held pre-squash view
  // must not restore a line after the mutation is acknowledged.
  await page.locator('[data-line-type="change-addition"]').first().click();
  held = holdNextState(mockedState("squash-race", revisionB));
  await advanceToHeld(held);
  const squashed = page.waitForResponse((response) =>
    response.url().endsWith("/api/squash-lines"),
  );
  await page.keyboard.press("s");
  assert.equal((await squashed).status(), 200);
  await expect(page.locator(".queue-count")).toHaveCount(0);
  await expect(page.locator(".statusbar")).toContainText("1 line squashed.");
  held.release();
  await held.done;
  await flushPage(page);
  await expect(page.locator(".code-surface")).not.toContainText("squash-race");
  await expect(page.locator(".statusbar")).toContainText("1 line squashed.");

  // Silent errors double the post-completion delay (2, 4, 8, 16, 30 seconds),
  // cap at 30 seconds, retain the current view, and never publish an alert.
  failureBudget = 5;
  const failureReads = reads;
  for (const [index, delay] of [
    2_000, 4_000, 8_000, 16_000, 30_000,
  ].entries()) {
    if (delay > 1) {
      await page.clock.runFor(delay - 1);
      await flushPage(page);
      assert.equal(
        reads,
        failureReads + index,
        `poll ${index + 1} fired before its ${delay}ms backoff`,
      );
    }
    await advanceToResponse(1, 503);
    assert.equal(reads, failureReads + index + 1);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".code-surface")).not.toContainText(
      "squash-race",
    );
  }

  // A failed mutation performs its one recovery read and remains halted. Even
  // after diagnostics are dismissed and enough fake time passes for many poll
  // timers, polling must not silently authorize or recover the queue.
  failSquash = true;
  const remaining = page.locator(
    '[data-line-type="change-deletion"], [data-line-type="change-addition"]',
  );
  await remaining.first().click();
  const failed = page.waitForResponse((response) =>
    response.url().endsWith("/api/squash-lines"),
  );
  const recovery = page.waitForResponse((response) =>
    response.url().endsWith("/api/state"),
  );
  await page.keyboard.press("s");
  assert.equal((await failed).status(), 500);
  assert.equal((await recovery).status(), 200);
  await expect(page.getByRole("alert")).toContainText(
    "Deliberate squash failure",
  );
  const haltedReads = reads;
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alert")).toHaveCount(0);
  current = mockedState("must-not-auto-recover", revisionB);
  await page.clock.runFor(120_000);
  await flushPage(page);
  assert.equal(reads, haltedReads, "a halted queue must never auto-recover");
  await expect(page.locator(".code-surface")).not.toContainText(
    "must-not-auto-recover",
  );
  await expect(
    page.getByRole("button", { name: "s squash", exact: true }),
  ).toBeDisabled();

  assert.deepEqual(errors, []);
}

await realRepositoryCoverage();
await controlledServerCoverage();
console.log(
  "Quiet polling: unchanged UI, saves, eligibility pauses, race discards, serialization, backoff, and halted queues passed.",
);
