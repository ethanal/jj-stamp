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
import type { PrContext, PrReviewSummary } from "../src/pr-review-types.ts";

const repoPath = await createDemo(
  await mkdtemp(path.join(tmpdir(), "jj-stamp-pr-picker-")),
);
const service = new ReviewService({ repoPath });
const router = createApi(service);
const reviewService = new ReviewService({ repoPath });
const reviewRouter = createApi(reviewService);
const reviewId = "a".repeat(64);
const reviewPath = `/reviews/${reviewId}/`;
const app = express();
app.use(express.json());
const repository = {
  owner: "example",
  name: "repo",
  nameWithOwner: "example/repo",
  url: "https://github.com/example/repo",
};
const prs: PrReviewSummary[] = [
  {
    number: 42,
    title: "Improve queue shutdown",
    url: `${repository.url}/pull/42`,
    state: "OPEN",
    isDraft: false,
    headRefName: "queue-fix",
    baseRefName: "main",
    headRefOid: "a".repeat(40),
    baseRefOid: "b".repeat(40),
    author: { login: "sam" },
  },
  {
    number: 43,
    title: '<img src=x onerror="window.injected=true">',
    url: `${repository.url}/pull/43`,
    state: "OPEN",
    isDraft: true,
    headRefName: "queue-metrics",
    baseRefName: "main",
    headRefOid: "c".repeat(40),
    baseRefOid: "b".repeat(40),
    author: { login: "mira" },
  },
];
let listRequests = 0;
let listError = false;
let invalidDestination: string | null = null;
const opens: string[] = [];
let destination = "";
let originalUrl = "";
const mutations: string[] = [];
const rootRequests: string[] = [];
const scopedRequests: string[] = [];
function prRouter(scoped: boolean) {
  const pr = express.Router();
  pr.use((req, _res, next) => {
    (scoped ? scopedRequests : rootRequests).push(req.path);
    if (
      req.method === "POST" &&
      /^\/(?:revision|squash|squash-lines|preview|undo|editor|comments)$/.test(
        req.path,
      )
    )
      mutations.push(req.path);
    next();
  });
  pr.get("/pr/context", (_req, res) =>
    res.json({
      mode: scoped ? "pr" : "workspace",
      repository: scoped ? repository : null,
      originalWorkspaceUrl: scoped ? originalUrl : null,
      pullRequest: scoped ? prs[0] : null,
      capabilities: {
        list: true,
        open: true,
        refresh: false,
        submit: false,
        dismiss: false,
        threads: false,
      },
    } satisfies PrContext),
  );
  pr.get("/pr/list", (_req, res) => {
    listRequests++;
    if (listError)
      return res
        .status(503)
        .json({ error: "Sign in with gh auth login before opening a PR." });
    res.json({
      repository,
      pullRequests: prs,
      scope: "review-involves",
      limit: 50,
    });
  });
  pr.post("/pr/open", (req, res) => {
    opens.push(req.body.input);
    if (!["42", `${repository.url}/pull/42`].includes(req.body.input))
      return res
        .status(400)
        .json({ error: "Use a PR in the current repository." });
    res.json({
      url: invalidDestination ?? destination,
    });
  });
  return pr;
}
app.use("/api", prRouter(false), router);
app.use(`${reviewPath}api`, prRouter(true), reviewRouter);
// Vite serves the same ordinary UI only at the loaded review's entry path.
app.use("/reviews", (req, res, next) => {
  if (
    (req.method === "GET" || req.method === "HEAD") &&
    req.path === `/${reviewId}/`
  )
    next();
  else res.status(404).type("text").send("Unknown review");
});
const fixture = await createBrowserFixture({ app });
originalUrl = `${fixture.url}/`;
destination = `${fixture.url}${reviewPath}`;
try {
  const { page, url, errors } = fixture;
  await page.addInitScript(() => {
    document.hasFocus = () => true;
  });
  await page.goto(url);
  const toolbar = page.getByRole("button", { name: "Open PR…", exact: true });
  await expect(toolbar).toBeEnabled();
  await expect(page.locator(".jj-log .log-row").first()).toBeVisible();
  await expect.poll(() => rootRequests.includes("/events")).toBe(true);
  assert.equal(listRequests, 0, "ordinary review must not query GitHub");
  await expect(page.getByText("Submit review", { exact: true })).toHaveCount(0);
  await toolbar.click();
  const selector = page.getByRole("dialog", { name: "Pull requests" });
  await expect(selector).toBeVisible();
  assert.deepEqual(await selector.boundingBox(), {
    x: 0,
    y: 0,
    width: 1440,
    height: 900,
  });
  const filter = page.getByLabel("Filter by title, author, or number");
  await expect(filter).toBeFocused();
  await expect(page.locator(".pr-review-choice")).toHaveCount(2);
  await expect(
    selector.locator(".pr-review-list-status [role=status]"),
  ).toContainText("unmerged PRs for you and your teams");
  await filter.pressSequentially("mira");
  await expect(filter).toBeFocused();
  await expect(page.locator(".pr-review-choice")).toHaveCount(1);
  await page.locator(".pr-review-choice").click();
  await expect(
    page.getByRole("complementary", { name: "Selected PR details" }),
  ).toContainText(prs[1].title);
  assert.equal(await page.locator("dialog img").count(), 0);
  await filter.fill("no match");
  await expect(
    page.getByRole("button", { name: "Open / resume review" }),
  ).toBeDisabled();
  await filter.fill("");
  const direct = page.getByLabel("Open a PR by number or URL");
  await expect(direct).toHaveAttribute(
    "placeholder",
    `#284 or ${repository.url}/pull/284`,
  );
  await direct.fill("https://github.com/other/repo/pull/42");
  await page.getByRole("button", { name: "Open directly" }).click();
  await expect(page.getByRole("alert")).toContainText("current repository");
  await direct.fill("42");
  const otherPort = new URL(originalUrl);
  otherPort.port =
    otherPort.port === "65535" ? "1" : String(Number(otherPort.port) + 1);
  for (const invalid of [
    "https://evil.example/",
    `${fixture.url}/not-a-review/`,
    otherPort.href,
  ]) {
    invalidDestination = invalid;
    await page.getByRole("button", { name: "Open directly" }).click();
    await expect(page.getByRole("alert")).toContainText(
      "invalid local workspace address",
    );
    assert.equal(page.url(), originalUrl);
  }
  assert.equal(
    (
      await page.request.get(`${fixture.url}/reviews/${"b".repeat(64)}/`)
    ).status(),
    404,
  );
  await page.getByRole("button", { name: "Back to workspace" }).focus();
  await page.keyboard.press("s");
  await page.keyboard.press("u");
  await page.keyboard.press("r");
  assert.deepEqual(mutations, []);
  await page.keyboard.press("Escape");
  await expect(selector).not.toBeVisible();
  await expect(toolbar).toBeFocused();

  listError = true;
  await toolbar.click();
  await expect(page.getByRole("alert")).toContainText("gh auth login");
  listError = false;
  await page.getByRole("button", { name: "Reload list" }).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.deepEqual(await selector.boundingBox(), {
    x: 0,
    y: 0,
    width: 390,
    height: 844,
  });
  assert(
    await selector.evaluate((el) => el.scrollWidth <= el.clientWidth),
    "mobile selector must not overflow horizontally",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  invalidDestination = null;
  await page.getByRole("button", { name: /#42 · Improve queue/ }).click();
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Open / resume review" }).click(),
  ]);
  const prToolbar = page.getByRole("button", { name: "PR #42 ▾" });
  await expect(prToolbar).toBeVisible();
  assert.equal(page.url(), destination);
  await expect(page.locator(".jj-log .log-row").first()).toBeVisible();
  await expect(page.locator("[data-line]").first()).toBeVisible();
  await expect.poll(() => scopedRequests.includes("/state")).toBe(true);
  await expect.poll(() => scopedRequests.includes("/graph")).toBe(true);
  await expect.poll(() => scopedRequests.includes("/events")).toBe(true);
  await prToolbar.click();
  const menu = page.getByRole("dialog", { name: "PR review", exact: true });
  await expect(menu).toContainText("Imported head: aaaaaaaaaaaa");
  await expect(menu).toContainText("not implemented");
  await expect(
    menu.getByRole("button", { name: "Return to original workspace" }),
  ).toBeVisible();
  await menu.getByRole("button", { name: "Open another PR…" }).click();
  await expect(selector).toBeVisible();
  assert.equal(opens.at(-1), "42");
  await page.getByRole("button", { name: "Back to workspace" }).click();
  await prToolbar.click();
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Return to original workspace" }).click(),
  ]);
  assert.equal(page.url(), originalUrl);
  await expect(toolbar).toBeVisible();
  repository.url =
    "https://source-control.github.enterprise.example/example/repo";
  for (const pr of prs) pr.url = `${repository.url}/pull/${pr.number}`;
  await page.reload();
  await page.getByRole("button", { name: "Open PR…", exact: true }).click();
  await expect(selector).toContainText(
    "source-control.github.enterprise.example/example/repo",
  );
  await expect(direct).toHaveAttribute(
    "placeholder",
    `#284 or ${repository.url}/pull/284`,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await selector.evaluate((el) => el.scrollWidth <= el.clientWidth),
    "Enterprise repository identity must not overflow the mobile selector",
  );
  await direct.fill(`${repository.url}/pull/42`);
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Open directly" }).click(),
  ]);
  await expect(prToolbar).toBeVisible();
  assert.equal(page.url(), destination);
  assert.equal(opens.at(-1), `${repository.url}/pull/42`);
  assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: same-origin scoped PR UI/API/events, return to original workspace, public/Enterprise picker, safe navigation, mobile and keyboard isolation",
  );
} finally {
  router.closeEvents();
  reviewRouter.closeEvents();
  await fixture.close();
  await Promise.all([service.drain(), reviewService.drain()]);
}
