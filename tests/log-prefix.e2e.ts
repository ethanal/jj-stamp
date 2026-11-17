// Run with: npx tsx tests/log-prefix.e2e.ts
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { colorSchemes, type ColorScheme } from "../src/preference-values.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

await using resources = new AsyncDisposableStack();
const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-log-prefix-"));
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const service = new ReviewService({ repoPath });
const state = await service.getState();
const graph = await service.getLog({ includeOutput: false });
const app = express();
app.use("/api", createApi(service));
const fixture = await createBrowserFixture({
  app,
  config: { "log-width": 500 },
});
resources.defer(() => fixture.close());
const { page, url, errors } = fixture;
await page.goto(url);
const current = page.locator('.log-change[aria-pressed="true"]');
await expect(current).toHaveAttribute("data-change-id", state.source.changeId);
await expect(
  page.getByRole("region", {
    name: "Diff for src/notifications.ts",
    exact: true,
  }),
).toBeVisible();

for (const row of graph.rows) {
  if (!row.revision) continue;
  const { changeId, changeIdPrefix } = row.revision;
  assert(changeIdPrefix);
  const button = page.getByRole("button", {
    name: `Review change ${changeId}`,
  });
  await expect(button).toHaveText(
    changeId.slice(0, Math.max(8, changeIdPrefix.length)),
  );
  await expect(button.locator(".change-id-prefix")).toHaveText(changeIdPrefix);
  await expect(button.locator(".change-id-rest")).toHaveText(
    changeId.slice(changeIdPrefix.length, Math.max(8, changeIdPrefix.length)),
  );
}
// The header is intentionally outside the scope of log highlighting.
await expect(page.locator(".revision-info .change-id-prefix")).toHaveCount(0);
const other = page.getByRole("button", {
  name: `Review change ${state.parent!.changeId}`,
  exact: true,
});
for (const scheme of Object.keys(colorSchemes) as ColorScheme[]) {
  await fixture.updateConfig({ "color-scheme": scheme });
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    scheme,
  );
  for (const button of [current, other]) {
    const prefix = button.locator(".change-id-prefix");
    const rest = button.locator(".change-id-rest");
    await expect(prefix).toHaveCSS("font-weight", "700");
    await expect(rest).toHaveCSS("font-weight", "400");
    const color = await button.evaluate((node) => getComputedStyle(node).color);
    await expect(prefix).toHaveCSS("color", color);
    await expect(rest).not.toHaveCSS("color", color);
  }
  const muted = await page
    .locator("html")
    .evaluate((node) =>
      getComputedStyle(node).getPropertyValue("--muted").trim(),
    );
  // Let the browser normalize the theme's hex value before comparing.
  const mutedColor = await page.evaluate((color) => {
    const probe = document.createElement("span");
    probe.style.color = color;
    document.body.append(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, muted);
  await expect(other.locator(".change-id-rest")).toHaveCSS("color", mutedColor);
  await other.hover();
  await expect(other.locator(".change-id-prefix")).toHaveCSS(
    "font-weight",
    "700",
  );
  await expect(other.locator(".change-id-rest")).toHaveCSS("color", mutedColor);
  await page.mouse.move(0, 0);
}
// The whole ID remains a single clickable control, using its full identity.
await other.click();
await expect(other).toHaveAttribute("aria-pressed", "true");
await expect(page.locator(".statusbar")).not.toContainText("switching change");
await expect(other.locator(".change-id-prefix")).toHaveCSS(
  "font-weight",
  "700",
);
await expect(other.locator(".change-id-rest")).toHaveCSS("font-weight", "400");

if (process.env.SCREENSHOT_DIR) {
  await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
  await page
    .getByRole("button", {
      name: `Review change ${state.source.changeId}`,
    })
    .click();
  await expect(page.locator(".statusbar")).not.toContainText(
    "switching change",
  );
  await expect(page.locator(".log-loading")).toHaveCount(0);
  for (const scheme of ["dark", "light"] as const) {
    await fixture.updateConfig({ "color-scheme": scheme });
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      scheme,
    );
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(process.env.SCREENSHOT_DIR, `log-prefix-${scheme}.png`),
    });
  }
}
assert.deepEqual(errors, []);
console.log(
  "log prefixes: real jj metadata, all themes, hover and selection passed",
);
