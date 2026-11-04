// Run with: npx tsx tests/inline-comments-render.e2e.ts
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";

const fixture = await createBrowserFixture({
  entry: "/tests/inline-comments.fixture.tsx",
});
try {
  const { page, url, errors } = fixture;
  await page.goto(url);
  const previous = page.getByRole("article", {
    name: "Previous review comment",
  });
  const current = page.getByRole("article", {
    name: "Review comment",
    exact: true,
  });
  await expect(previous).toBeVisible();
  await expect(previous).toContainText("Previous <b>question</b>");
  await expect(previous.locator("b")).toHaveCount(0);
  await expect(previous.getByRole("button")).toHaveCount(0);
  await expect(current).toBeVisible();
  await expect(page.locator("#loads")).toHaveText("1");
  for (const layout of ["split", "unified"]) {
    await page.getByRole("button", { name: "Toggle layout" }).click();
    await expect(page.locator("[data-diff-type]")).toHaveAttribute(
      "data-diff-type",
      layout === "unified" ? "single" : layout,
    );
    await expect(previous).toBeVisible();
    await expect(current).toBeVisible();
    await expect(page.locator("#loads")).toHaveText("1");
  }
  // Ordinary historical source markers are view-only. Editing is exclusively
  // available through the independently loaded managed COMMENTS overlay.
  await expect(current.getByRole("button")).toHaveCount(0);
  await expect(current).toContainText("Current question");

  // Marker-bearing files permit comment range selection, but never produce
  // code-squash row selections in original or projected coordinates.
  await page
    .locator('[data-line="2"]:not([data-line-type="change-deletion"])')
    .last()
    .click();
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(
    0,
  );
  await expect(page.locator("#selection")).toHaveText("{}");
  await page.getByRole("button", { name: "Historical revision" }).click();
  await expect(current.getByRole("button")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(
    0,
  );
  await expect(current).toBeVisible();
  await page.getByRole("button", { name: "Historical revision" }).click();

  await page.getByRole("button", { name: "Malformed markers" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Some review markers are malformed",
  );
  const malformed = page
    .locator('[data-line="1"]:not([data-line-type="change-deletion"])')
    .last();
  await expect(malformed).toBeVisible();
  await expect(malformed).toContainText("JJ-STAMP(invalid)");
  await expect(current).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(
    0,
  );
  await expect(page.locator("#loads")).toHaveText("2");
  assert.deepEqual(errors, []);
  console.log(
    "inline comment rendering, historical and malformed coverage: ok",
  );
} finally {
  await fixture.close();
}
