// Real application and isolated jj fixture; PR actions must remain UI-only.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const temporary = await mkdtemp(path.join(tmpdir(), "jj-stamp-pr-ui-"));
const repoPath = await createDemo(temporary);
const service = new ReviewService({ repoPath });
const router = createApi(service);
const app = express();
const mutations: string[] = [];
app.use("/api", (req, _res, next) => {
  if (
    req.method === "POST" &&
    /^\/(?:revision|squash|squash-lines|preview|undo|editor)$/.test(req.path)
  )
    mutations.push(req.path);
  next();
});
app.use("/api", router);
const fixture = await createBrowserFixture({ app });
try {
  const { page, url, errors } = fixture;
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await page.goto(url);
  await expect(page.locator(".file-bar-filename")).toContainText(
    "notifications.ts",
  );
  await expect(page.locator(".jj-log .log-row").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const normalGeometry = await page.evaluate(() =>
    [".workspace", ".sidebar", ".viewer", ".log-panel", ".statusbar"].map(
      (selector) => {
        const rect = document.querySelector(selector)!.getBoundingClientRect();
        return [rect.x, rect.y, rect.width, rect.height];
      },
    ),
  );
  assert(
    !requests.some((url) => /PrReviewPrototype|pr-review-prototype/.test(url)),
    "ordinary reviews must not load the prototype or its data/styles",
  );
  const before = await service.getState();
  await page.goto(`${url}?pr-prototype=1`);
  await expect(page.locator(".file-bar-filename")).toContainText(
    "notifications.ts",
  );

  const toolbar = page.getByTitle(
    "PR review prototype — sample metadata only",
    { exact: true },
  );
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toBeEnabled();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  const openSelector = async () => {
    await toolbar.click();
    await page.getByRole("button", { name: "Open PR…", exact: true }).click();
  };
  await openSelector();
  const selector = page.getByRole("dialog", { name: "Pull requests" });
  const filter = page.getByLabel("Filter by title, author, or number");
  const direct = page.getByLabel("Open a PR by number or URL");
  await expect(selector).toBeVisible();
  assert.deepEqual(await selector.boundingBox(), {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  });
  await expect(filter).toBeFocused();
  await expect(page.locator(".prp-choice")).toHaveCount(5);
  await filter.pressSequentially("queue");
  await expect(filter).toBeFocused();
  await expect(page.locator(".prp-choice")).toHaveCount(2);
  await page
    .getByRole("button", { name: /#279.*Add queue saturation metrics/ })
    .click();
  await expect(
    page.getByRole("complementary", { name: "Selected PR details" }),
  ).toContainText("Add queue saturation metrics");
  await expect(
    page.getByRole("button", { name: "Start PR preview", exact: true }),
  ).toBeEnabled();
  await filter.fill("there is no such sample");
  await expect(page.locator(".prp-results")).toContainText(
    "No sample PRs match",
  );
  await expect(
    page.getByRole("button", { name: "Start PR preview", exact: true }),
  ).toBeDisabled();
  await filter.fill("");
  await page.getByRole("button", { name: "Active locally · 3" }).click();
  await expect(page.locator(".prp-choice")).toHaveCount(3);
  await direct.fill("https://github.com/another/repo/pull/284");
  await page
    .getByRole("button", { name: "Open directly", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "Other hosts and repositories",
  );
  await direct.fill("99999");
  await page
    .getByRole("button", { name: "Open directly", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "PR not found in sample data",
  );
  await direct.fill("https://github.com/orbit/notifications/pull/284");
  await page
    .getByRole("button", { name: "Open directly", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".prp-choice[aria-pressed=true]")).toContainText(
    "#284",
  );
  await page
    .getByRole("button", { name: "Resume PR preview", exact: true })
    .click();
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(toolbar).toContainText("#284");
  await expect(toolbar).toBeFocused();

  await toolbar.click();
  await page.getByRole("button", { name: "Refresh PR (simulate)" }).click();
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "No remote request, workspace change, or diff refresh occurred",
  );
  await page.getByRole("button", { name: /Staged comments preview/ }).click();
  await expect(page.locator(".prp-comment")).toHaveCount(2);
  const note = '<img src=x onerror="alert(1)"> a literal sample note';
  await page.getByLabel("Add a local sample note").fill(note);
  await page.getByRole("button", { name: "Stage sample note" }).click();
  await expect(page.locator(".prp-comment")).toHaveCount(3);
  await expect(page.locator(".prp-comment").last()).toContainText(note);
  await expect(page.locator(".prp-comment img")).toHaveCount(0);
  await page
    .getByRole("button", { name: `Edit comment: ${note}`, exact: true })
    .click();
  await page.getByLabel("Edit sample comment").fill("Edited local note");
  await page.getByRole("button", { name: "Save locally" }).click();
  await expect(page.locator(".prp-comment").last()).toContainText(
    "Edited local note",
  );
  await page
    .getByRole("button", { name: "Remove comment: Edited local note" })
    .click();
  await expect(page.locator(".prp-comment")).toHaveCount(2);
  await page.getByRole("button", { name: "Submit review… (simulate)" }).click();
  for (const event of ["Comment", "Approve", "Request changes"]) {
    await page.getByRole("radio", { name: event, exact: true }).check();
    await page
      .getByRole("button", { name: "Confirm simulation — send nothing" })
      .click();
    await expect(page.getByRole("dialog").getByRole("status")).toContainText(
      `Simulated “${event}” preview complete`,
    );
    await expect(page.getByRole("dialog").getByRole("status")).toContainText(
      "All sample drafts retained",
    );
  }
  // App-level s/u/r shortcuts must not leak out of PR dialogs.
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("s");
  await page.keyboard.press("u");
  await page.keyboard.press("r");
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(toolbar).toBeFocused();
  await toolbar.click();
  await page.getByRole("button", { name: "Dismiss local preview…" }).click();
  await expect(
    page.getByRole("button", { name: "Keep preview" }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Keep preview" }).click();
  await page
    .getByRole("button", { name: /Staged comments preview · 2/ })
    .click();
  await page.getByRole("button", { name: "Back to PR actions" }).click();
  await page.getByRole("button", { name: "Dismiss local preview…" }).click();
  await page
    .getByRole("button", { name: "Discard local sample preview" })
    .click();
  await expect(toolbar).not.toContainText("#284");
  await openSelector();
  await expect(
    page.getByRole("button", { name: "Active locally · 2" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start PR preview" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await expect(toolbar).toBeFocused();

  // The full-screen surface remains usable at the smallest supported font/viewport
  // and follows the existing theme instead of bringing a separate palette.
  await page.setViewportSize({ width: 390, height: 844 });
  await openSelector();
  assert.deepEqual(await selector.boundingBox(), {
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
  assert(
    await selector.evaluate(
      (element) => element.scrollWidth === element.clientWidth,
    ),
    "selector must fit a narrow viewport",
  );
  await filter.fill("#284");
  await expect(page.locator(".prp-choice")).toHaveCount(1);
  await expect(filter).toBeFocused();
  await page.evaluate(() => {
    document.documentElement.dataset.colorScheme = "light";
  });
  await expect(selector).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.keyboard.press("Escape");
  await expect(toolbar).toBeFocused();
  await page.evaluate(() => {
    document.documentElement.dataset.colorScheme = "dark";
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  const after = await service.getState();
  assert.equal(after.repo.path, before.repo.path);
  assert.equal(after.source.commitId, before.source.commitId);
  assert.deepEqual(mutations, [], "PR prototype actions must not mutate jj");
  assert.deepEqual(
    await page.evaluate(() =>
      [".workspace", ".sidebar", ".viewer", ".log-panel", ".statusbar"].map(
        (selector) => {
          const rect = document
            .querySelector(selector)!
            .getBoundingClientRect();
          return [rect.x, rect.y, rect.width, rect.height];
        },
      ),
    ),
    normalGeometry,
    "option A must preserve the existing workspace layout",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: option A React PR prototype; original workspace preserved",
  );
} finally {
  router.closeEvents();
  await fixture.close();
  await service.drain();
}
