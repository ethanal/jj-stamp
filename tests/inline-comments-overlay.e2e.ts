// Run with: npx tsx tests/inline-comments-overlay.e2e.ts
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";

const fixture = await createBrowserFixture({
  entry: "/tests/inline-comments-overlay.fixture.tsx",
});
try {
  const { page, url, errors } = fixture;
  const card = () =>
    page.locator('[data-comment-id="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]');
  const line = (number: number) =>
    page
      .locator(`[data-line="${number}"][data-line-type="change-addition"]`)
      .last();
  await page.goto(url);
  await expect(card()).toBeVisible();
  await expect(card()).toContainText("Line 1–2 · COMMENTS revision");
  await expect(card()).toContainText("A companion <b>comment</b>");
  await expect(card().locator("b")).toHaveCount(0);
  await expect(line(1)).toBeVisible();
  await expect(line(1)).toHaveText("export const value = 10;");
  await expect(page.locator("[data-fold-comment-marker]")).toHaveCount(0);
  await expect(
    page.getByText("The original source range was deleted.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("Keep this unresolved body visible"),
  ).toBeVisible();
  await expect(page.locator("#loads")).toHaveText("1");
  await expect(page.locator("#comment-loads")).toHaveText("1");
  await line(1).click();
  await line(2).click({ modifiers: ["Shift"] });
  const selected = JSON.parse(
    (await page.locator("#selection").textContent())!,
  );
  assert(Object.values(selected).some((rows) => (rows as number[]).length > 0));
  await expect(page.getByRole("button", { name: "Add comment" })).toBeEnabled();
  for (const layout of ["split", "single"]) {
    await page.getByRole("button", { name: "Toggle layout" }).click();
    await expect(page.locator("[data-diff-type]")).toHaveAttribute(
      "data-diff-type",
      layout,
    );
    await expect(card()).toBeVisible();
    await expect(page.locator("#loads")).toHaveText("1");
    await expect(page.locator("#comment-loads")).toHaveText("1");
  }
  await page.getByRole("button", { name: "Toggle failed save" }).click();
  await card().getByRole("button", { name: "Edit comment" }).click();
  const editor = page.getByRole("textbox", { name: "Comment body" });
  await editor.fill("Unsaved companion draft");
  await page.getByRole("button", { name: "Save comment" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Companion revision save failed",
  );
  await expect(editor).toHaveValue("Unsaved companion draft");
  await page.getByRole("button", { name: "Toggle failed save" }).click();
  await page.getByRole("button", { name: "Save comment" }).click();
  await expect(card()).toContainText("Unsaved companion draft");
  await expect(page.locator(".code-surface")).toBeFocused();
  await expect(page.locator("#loads")).toHaveText("1");
  await expect(page.locator("#comment-loads")).toHaveText("2");
  await page.getByRole("button", { name: "Add comment" }).click();
  await editor.fill("Clean-coordinate range comment");
  await page.getByRole("button", { name: "Save comment" }).click();
  await expect(
    page.getByText("Clean-coordinate range comment", { exact: true }),
  ).toBeVisible();
  const mutations = JSON.parse(
    (await page.locator("#mutations").textContent())!,
  );
  assert.deepEqual(mutations.at(-1), {
    version: "state-1",
    path: "clean-code.ts",
    action: "add",
    line: 1,
    endLine: 2,
    body: "Clean-coordinate range comment",
  });
  await page.reload();
  await expect(
    page.getByText("Clean-coordinate range comment", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "External comment save" }).click();
  await expect(card()).toContainText("Externally changed companion");
  await expect(page.locator("#loads")).toHaveText("1");
  await card().getByRole("button", { name: "Remove comment" }).click();
  await expect(card()).toHaveCount(0);
  await page.getByRole("button", { name: "Historical revision" }).click();
  await expect(page.getByRole("button", { name: "Edit comment" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("button", { name: "Add comment" })).toHaveCount(
    0,
  );
  // The managed overlay uses physical coordinates, not source-language
  // lexing or an extension allowlist. Exercise actual mutations and reloads
  // in every formerly problematic kind of source.
  for (const source of [
    "rust",
    "python",
    "json",
    "markdown",
    "extensionless",
  ]) {
    await page.goto(`${url}?source=${source}`);
    await expect(card()).toBeVisible();
    await expect(page.locator("#loads")).toHaveText("1");
    await line(1).click();
    await line(2).click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Add comment" }).click();
    await editor.fill(`${source}: added on physical source lines`);
    await page.getByRole("button", { name: "Save comment" }).click();
    const added = page.locator(
      '[data-comment-id="dddddddd-dddd-4ddd-8ddd-dddddddddddd"]',
    );
    await expect(added).toContainText(
      `${source}: added on physical source lines`,
    );
    await expect(added).toContainText("Line 1–2 · COMMENTS revision");
    await added.getByRole("button", { name: "Edit comment" }).click();
    await editor.fill(`${source}: edited`);
    await page.getByRole("button", { name: "Save comment" }).click();
    await expect(added).toContainText(`${source}: edited`);
    await expect(page.locator("#loads")).toHaveText("1");
    await expect(page.locator("[data-fold-comment-marker]")).toHaveCount(0);
    await page.reload();
    await expect(added).toContainText(`${source}: edited`);
    await added.getByRole("button", { name: "Remove comment" }).click();
    await expect(added).toHaveCount(0);
    await expect(page.locator("#loads")).toHaveText("1");
    await page.reload();
    await expect(card()).toBeVisible();
    await expect(added).toHaveCount(0);
  }
  assert.deepEqual(errors, []);
  console.log(
    "independent COMMENTS overlays use clean coordinates in every source language: ok",
  );
} finally {
  await fixture.close();
}
