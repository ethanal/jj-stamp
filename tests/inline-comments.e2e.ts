// Run with: npx tsx tests/inline-comments.e2e.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { parseReviewComments } from "../src/review-comments.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-inline-"));
await using resources = new AsyncDisposableStack();
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const commentPath = "src/inline-sample.ts";
const diskPath = path.join(repoPath, commentPath);
const firstId = "11111111-1111-4111-8111-111111111111";
const rangeId = "22222222-2222-4222-8222-222222222222";
const initial = [
  `// JJ-STAMP(${firstId}): What does this do?`,
  `// JJ-STAMP(${firstId}): <img src=x onerror=alert(1)>`,
  "export const threshold = 3;",
  `// JJ-STAMP(${rangeId}): Why these two values?`,
  "export const low = 1;",
  "export const high = 9;",
  `// JJ-STAMP(${rangeId})`,
  "export const tail = 6;",
  "export const extra = 7;",
  "",
].join("\n");
await writeFile(diskPath, initial);
const service = new ReviewService({ repoPath });
resources.defer(() => service.drain());
const app = express();
const router = createApi(service);
resources.defer(() => router.closeEvents());
app.use("/api", router);
const fixture = await createBrowserFixture({ app });
resources.defer(() => fixture.close());
const { page, url, errors } = fixture;
const currentCards = () =>
  page.getByRole("article", { name: "Review comment", exact: true });
const firstCard = () => page.locator(`[data-comment-id="${firstId}"]`).last();
const newLine = (number: number) =>
  page
    .locator(`[data-line="${number}"]:not([data-line-type="change-deletion"])`)
    .last();
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.goto(url);
await page.locator(`.file-tree [data-item-path="${commentPath}"]`).click();
await expect(firstCard()).toBeVisible();
await expect(firstCard()).toContainText(
  "What does this do?\n<img src=x onerror=alert(1)>",
);
await expect(firstCard().locator("img")).toHaveCount(0);
await expect(currentCards()).toHaveCount(2);
for (const line of [1, 2, 4, 7])
  await expect(newLine(line)).toHaveCSS("visibility", "hidden");
await expect(newLine(3)).toHaveText("export const threshold = 3;");
await expect(
  page.getByRole("button", { name: `Squash file ${commentPath}`, exact: true }),
).toBeDisabled();
await expect(
  firstCard().getByRole("button", { name: "Edit comment" }),
).toBeEnabled();
await newLine(3).click();
await newLine(8).click({ modifiers: ["Shift"] });
await page.keyboard.press("Control+c");
const copied = await page.evaluate(() => navigator.clipboard.readText());
assert(copied.includes("export const threshold = 3;"));
assert(copied.includes("export const high = 9;"));
assert(!copied.includes("JJ-STAMP"));
assert(!copied.includes("Why these two values?"));

// Editing is real textarea input: ordinary application shortcut letters must
// never squash, refresh, or navigate while the editor owns focus.
await firstCard().getByRole("button", { name: "Edit comment" }).click();
const editor = page.getByRole("textbox", { name: "Comment body" });
await editor.fill("");
await editor.pressSequentially("s u r e: literal <script>safe</script>");
await editor.press("Enter");
await editor.pressSequentially("second line");
await page.getByRole("button", { name: "Save comment", exact: true }).click();
await expect(firstCard()).toContainText(
  "s u r e: literal <script>safe</script>\nsecond line",
);
assert.match(await readFile(diskPath, "utf8"), /JJ-STAMP.*second line/);
await expect(page.locator(".code-surface")).toBeFocused();
await page.reload();
await expect(firstCard()).toBeVisible();
await expect(firstCard()).toContainText("second line");

// The same inline slots work in split/stacked and single/all-file layouts.
await page.getByRole("button", { name: "Split", exact: true }).click();
await expect(firstCard()).toBeVisible();
await page.getByRole("button", { name: "All files", exact: true }).click();
await expect(firstCard()).toBeVisible();
await page.getByRole("button", { name: "One file", exact: true }).click();
await page.getByRole("button", { name: "Stacked", exact: true }).click();

// A physical new-side code range is passed unchanged to the mutation API.
await newLine(8).click();
await newLine(9).click({ modifiers: ["Shift"] });
await page.getByRole("button", { name: "Add comment", exact: true }).click();
await expect(editor).toBeVisible();
await editor.fill("A new range comment");
const addResponse = page.waitForResponse((response) =>
  response.url().endsWith("/api/comments"),
);
await page.getByRole("button", { name: "Save comment", exact: true }).click();
const addedResponse = await addResponse;
assert.equal(addedResponse.status(), 200, await addedResponse.text());
await expect(currentCards()).toHaveCount(3);
const added = parseReviewComments(
  commentPath,
  await readFile(diskPath, "utf8"),
).comments.find((comment) => comment.body === "A new range comment");
assert(added, "compose writes a real comment marker into the working copy");
assert.equal(added.endAnchorLine - added.anchorLine, 1);
assert(added.endMarkerLine);
await page.reload();
await expect(page.locator(`[data-comment-id="${added.id}"]`)).toBeVisible();

// An external source save invalidates the immutable pinned contents and cards.
await writeFile(
  diskPath,
  (await readFile(diskPath, "utf8")).replace(
    "A new range comment",
    "Changed in an external editor",
  ),
);
await expect(page.locator(`[data-comment-id="${added.id}"]`)).toContainText(
  "Changed in an external editor",
  { timeout: 15_000 },
);
await page
  .locator(`[data-comment-id="${added.id}"]`)
  .getByRole("button", { name: "Remove comment" })
  .click();
await expect(page.locator(`[data-comment-id="${added.id}"]`)).toHaveCount(0);
assert(!(await readFile(diskPath, "utf8")).includes(added.id));
assert((await readFile(diskPath, "utf8")).includes("export const low = 1;"));
assert((await readFile(diskPath, "utf8")).includes("export const high = 9;"));
assert.deepEqual(errors, []);
console.log("inline file-backed comment UI: ok");
