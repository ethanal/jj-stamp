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
let active: PrReviewSummary | null = null;
let listRequests = 0;
let listError = false;
let invalidDestination = false;
const opens: string[] = [];
let destination = "";
app.get("/api/pr/context", (_req, res) =>
  res.json({
    mode: active ? "pr" : "workspace",
    repository: active ? repository : null,
    originalWorkspaceUrl: active ? destination : null,
    pullRequest: active,
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
app.get("/api/pr/list", (_req, res) => {
  listRequests++;
  if (listError)
    return res
      .status(503)
      .json({ error: "Sign in with gh auth login before opening a PR." });
  res.json({ repository, pullRequests: prs, scope: "all-open", limit: 50 });
});
app.post("/api/pr/open", (req, res) => {
  opens.push(req.body.input);
  if (req.body.input !== "42")
    return res
      .status(400)
      .json({ error: "Use a PR in the current repository." });
  if (!invalidDestination) active = prs[0];
  res.json({
    url: invalidDestination ? "https://evil.example/" : destination,
  });
});
const mutations: string[] = [];
app.use("/api", (req, _res, next) => {
  if (
    req.method === "POST" &&
    /^\/(?:revision|squash|squash-lines|preview|undo|editor|comments)$/.test(
      req.path,
    )
  )
    mutations.push(req.path);
  next();
});
app.use("/api", router);
const fixture = await createBrowserFixture({ app });
destination = `${fixture.url}/`;
try {
  const { page, url, errors } = fixture;
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await page.goto(url);
  const toolbar = page.getByRole("button", { name: "Open PR…", exact: true });
  await expect(toolbar).toBeEnabled();
  await expect(page.locator(".jj-log .log-row").first()).toBeVisible();
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
  await direct.fill("https://github.com/other/repo/pull/42");
  await page.getByRole("button", { name: "Open directly" }).click();
  await expect(page.getByRole("alert")).toContainText("current repository");
  invalidDestination = true;
  await direct.fill("42");
  await page.getByRole("button", { name: "Open directly" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "invalid local workspace address",
  );
  assert.equal(page.url(), destination);
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
  invalidDestination = false;
  await page.getByRole("button", { name: /#42 · Improve queue/ }).click();
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "Open / resume review" }).click(),
  ]);
  const prToolbar = page.getByRole("button", { name: "PR #42 ▾" });
  await expect(prToolbar).toBeVisible();
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
  assert.deepEqual(mutations, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real PR picker UI, quiet non-PR state, safe navigation, errors, mobile and keyboard isolation",
  );
} finally {
  router.closeEvents();
  await fixture.close();
  await service.drain();
}
