// Run with: npx tsx tests/preferences.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { createBrowserFixture } from "./browser-fixture.ts";
import { expect } from "@playwright/test";

const source = {
  changeId: "abcdefghijklmno",
  changeIdPrefix: "abc",
  commitId: "0123456789abcdef",
  description: "Review toolbar preferences",
  author: "A. Reviewer",
};
const app = express();
app.get("/api/state", (_request, response) =>
  response.json({
    repo: { name: "example", path: "/home/reviewer/full/path/example" },
    version: "fixture-v1",
    source,
    parent: null,
    targets: [],
    files: [
      {
        path: "review.txt",
        additions: 422,
        deletions: 15,
        patch: "",
        hunks: [],
        unsupported: "Fixture preview",
      },
    ],
    operation: "fixture-op",
    canUndo: false,
  }),
);
app.get("/api/graph", (_request, response) =>
  response.json({
    version: "fixture-v1",
    rows: [{ graph: "@  ", revision: source, mutable: true }],
  }),
);
const fixture = await createBrowserFixture({
  app,
});
const { page, url, errors, browser } = fixture;
try {
  await page.goto(url);
  await expect(page).toHaveTitle(
    `${source.description} (abcdefgh /home/reviewer/full/path/example)`,
  );
  await expect(
    page.getByLabel("Current change ID").locator("strong"),
  ).toHaveCount(0);
  await expect(page.getByLabel("Current change ID")).toHaveText("abcdefgh");
  await expect(page.locator(".log-change strong")).toHaveCount(0);
  await expect(page.getByLabel("Revision author")).toHaveCount(0);
  await expect(page.locator(".topbar")).not.toContainText(source.author);
  const heading = page.getByLabel("Reviewed revision");
  await expect(heading.getByLabel("Current commit ID")).toHaveText(
    "0123456789ab",
  );
  await expect(heading.getByLabel("Change line counts")).toHaveText("+422−15");
  const descriptionBox = await heading
    .locator(".source-description")
    .boundingBox();
  const commitBox = await heading.getByLabel("Current commit ID").boundingBox();
  assert(descriptionBox && commitBox);
  assert(commitBox.x - (descriptionBox.x + descriptionBox.width) <= 15);
  await expect(page.locator(".log-row.is-current")).toBeVisible();
  await expect(page.locator(".log-row.is-current")).toHaveCSS(
    "box-shadow",
    "none",
  );
  const settings = page.getByRole("button", { name: "settings", exact: true });
  const dialog = page.getByRole("dialog", { name: "Settings" });
  const picker = page.getByLabel("Color scheme");
  await expect(dialog).not.toBeVisible();
  await expect(picker).not.toBeVisible();
  await settings.click();
  await expect(dialog).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Close settings" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(picker).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close settings" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(picker).toBeFocused();
  await page.getByRole("button", { name: "Close settings" }).focus();
  // App shortcuts must not operate on the inert background while settings is open.
  await page.keyboard.press("l");
  await expect(
    page.getByRole("button", { name: "Collapse log sidebar" }),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  const files = page.getByRole("separator", { name: "Resize files sidebar" });
  const log = page.getByRole("separator", { name: "Resize log sidebar" });
  await files.focus();
  await page.keyboard.press("ArrowRight");
  await expect(files).toHaveAttribute("aria-valuenow", "255");
  await page.keyboard.press("Shift+ArrowRight");
  await expect(files).toHaveAttribute("aria-valuenow", "295");
  const leftBox = await files.boundingBox();
  assert(leftBox);
  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(leftBox.x + leftBox.width / 2 + 45, leftBox.y + 80, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await expect(page.getByLabel("Files sidebar", { exact: true })).toHaveCSS(
    "width",
    "340px",
  );
  const rightBox = await log.boundingBox();
  assert(rightBox);
  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + 80);
  await page.mouse.down();
  await page.mouse.move(rightBox.x + rightBox.width / 2 - 40, rightBox.y + 80, {
    steps: 5,
  });
  await page.mouse.up();
  await expect(log).toHaveAttribute("aria-valuenow", "390");
  await log.focus();
  await page.keyboard.press("ArrowLeft");
  await expect(log).toHaveAttribute("aria-valuenow", "400");
  await settings.click();
  await picker.selectOption("light");
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".log-row.is-current")).toHaveCSS(
    "color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator(".log-row.is-current")).toHaveCSS(
    "background-color",
    "rgb(7, 87, 154)",
  );
  await page.reload();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await expect(log).toHaveAttribute("aria-valuenow", "400");
  await expect(dialog).not.toBeVisible();
  await settings.click();
  await expect(picker).toHaveValue("light");
  await page.getByRole("button", { name: "Close settings" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(settings).toBeFocused();
  await page.getByRole("button", { name: "Collapse files sidebar" }).click();
  await expect(files).toHaveCount(0);
  await page.getByRole("button", { name: "Expand files sidebar" }).click();
  await expect(files).toHaveAttribute("aria-valuenow", "340");
  await settings.click();
  await picker.selectOption("dim");
  await expect(page.locator("html")).toHaveCSS(
    "background-color",
    "rgb(34, 39, 46)",
  );
  for (const [scheme, background, mode] of [
    ["solarized-dark", "rgb(0, 43, 54)", "dark"],
    ["solarized-light", "rgb(253, 246, 227)", "light"],
  ] as const) {
    await page.getByLabel("Color scheme").selectOption(scheme);
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      background,
    );
    await expect(page.locator("html")).toHaveCSS("color-scheme", mode);
    await page.reload();
    await settings.click();
    await expect(picker).toHaveValue(scheme);
    await expect(page.locator("html")).toHaveCSS(
      "background-color",
      background,
    );
  }
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.screenshot({ path: "/tmp/jj-stamp-preferences-desktop.png" });
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(files).toBeVisible();
  await expect(log).not.toBeVisible();
  await expect(page.getByLabel("Reviewed revision")).toBeVisible();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth,
    ),
    false,
  );
  await settings.click();
  await expect(dialog).toBeVisible();
  const dialogBox = await dialog.boundingBox();
  assert(dialogBox && dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= 600);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: "/tmp/jj-stamp-preferences-mobile.png" });
  const noStorage = await browser.newPage();
  await noStorage.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new Error("Storage unavailable");
      },
    });
  });
  await noStorage.goto(url);
  await noStorage
    .getByRole("button", { name: "settings", exact: true })
    .click();
  await expect(noStorage.getByLabel("Color scheme")).toHaveValue("dark");
  await noStorage.getByLabel("Color scheme").selectOption("light");
  await expect(noStorage.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "light",
  );
  await noStorage.close();
  assert.deepEqual(errors, []);
  console.log(
    "Preference browser checks passed: drag/keyboard resize, persistence, themes, title/header, graph highlight, accessible settings, mobile, unavailable storage.",
  );
} finally {
  await fixture.close();
}
