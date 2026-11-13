// Run: npx tsx tests/revision-settings.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import { defaultLogRevset } from "../src/preferences.ts";
import type { RepoState } from "../src/types.ts";

const first = {
  changeId: "kkkkkkkk",
  commitId: "a".repeat(40),
  description: "First revision",
};
const second = {
  changeId: "zzzzzzzz",
  commitId: "b".repeat(40),
  description: "Second revision",
};
let state: RepoState = {
  repo: { name: "settings", path: "/tmp/settings-fixture" },
  version: "v1",
  source: first,
  parent: null,
  targets: [],
  files: [],
  operation: "op1",
  canUndo: false,
};
const graphQueries: unknown[] = [];
const revisions: string[] = [];
const app = express();
app.use(express.json());
app.get("/api/state", (_req, res) => res.json(state));
app.get("/api/events", (_req, res) => res.sendStatus(204));
app.get("/api/graph", (req, res) => {
  graphQueries.push(req.query.revset);
  if (req.query.revset === "broken(") {
    res.status(400).json({ error: "Invalid revset", code: "INVALID_REVSET" });
    return;
  }
  res.json({
    version: state.version,
    rows: (req.query.revset === "none()" ? [] : [first, second]).map(
      (revision) => ({ graph: "○ ", revision, mutable: true }),
    ),
  });
});
app.post("/api/revision", (req, res) => {
  revisions.push(req.body.changeId);
  if (req.body.changeId !== "bbbb") {
    res
      .status(400)
      .json({ error: "No matching revision", code: "INVALID_REVISION" });
    return;
  }
  state = { ...state, source: second, version: "v2" };
  res.json({ state });
});
app.post("/api/commit", (_req, res) =>
  res.status(404).json({ error: "No preview" }),
);
const fixture = await createBrowserFixture({ app });
const { page, url, errors } = fixture;
try {
  await page.addInitScript(() => {
    document.hasFocus = () => false;
  });
  await page.goto(url);
  await expect(page.locator(".log-row")).toHaveCount(2);
  assert.equal(graphQueries.at(-1), undefined);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const input = settings.getByLabel("jj log revset", { exact: true });
  await expect(input).toHaveValue(defaultLogRevset);
  await expect(settings).toHaveCSS("width", "720px");
  for (const width of [600, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await settings.boundingBox();
    assert(box && box.x >= 16 && box.x + box.width <= width - 16);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await input.fill("broken(");
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveText("Invalid revset");
  await expect(page.locator(".log-row")).toHaveCount(2);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("jj-stamp.log-revset")),
    defaultLogRevset,
  );
  await input.fill("none()");
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".log-row")).toHaveCount(0);
  await expect(
    page.getByLabel("Current change ID", { exact: true }),
  ).toHaveText(first.changeId);
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(
    page.getByLabel("Current change ID", { exact: true }),
  ).toHaveText(first.changeId);
  await expect.poll(() => graphQueries.at(-1)).toBe("none()");
  await page.keyboard.press("g");
  const goto = page.getByRole("textbox", {
    name: "ID or revset",
    exact: true,
  });
  await expect(goto).toBeFocused();
  await goto.fill("bad");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("No matching revision", { exact: true }).first(),
  ).toBeVisible();
  await expect(goto).toBeVisible();
  await expect(
    page.getByLabel("Current change ID", { exact: true }),
  ).toHaveText(first.changeId);
  await goto.fill(" bbbb ");
  await page.keyboard.press("Enter");
  await expect(goto).toBeHidden();
  await expect(
    page.getByLabel("Current change ID", { exact: true }),
  ).toHaveText(second.changeId);
  assert.deepEqual(revisions, ["bad", "bbbb"]);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(input).toHaveValue("none()");
  await settings.getByRole("button", { name: "Reset to default" }).click();
  await expect(input).toHaveValue(defaultLogRevset);
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.locator(".log-row")).toHaveCount(2);
  await expect(
    page.getByLabel("Current change ID", { exact: true }),
  ).toHaveText(second.changeId);
  assert.deepEqual(errors, []);
  console.log("Revision lookup and log settings browser checks passed.");
} finally {
  await fixture.close();
}
