// Run with: npx tsx tests/inline-comments.e2e.ts
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect as browserExpect } from "@playwright/test";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { parseReviewComments } from "../src/review-comments.ts";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createDemo } from "./fixtures.ts";

const expect = browserExpect.configure({ timeout: 15_000 });
const directory = await mkdtemp(path.join(tmpdir(), "jj-stamp-inline-"));
await using resources = new AsyncDisposableStack();
resources.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = await createDemo(directory);
const commentPath = "src/inline-sample.ts";
const diskPath = path.join(repoPath, commentPath);
const reviewedCode = [
  "export const threshold = 3;",
  "export const low = 1;",
  "export const high = 9;",
  "export const tail = 6;",
  "export const extra = 7;",
  "",
].join("\n");
const remainingCode = reviewedCode
  .replace("threshold = 3", "threshold = 30")
  .replace("tail = 6", "tail = 60");
await writeFile(diskPath, reviewedCode);
await jj(repoPath, ["commit", "-m", "Reviewed sample code"]);
await writeFile(diskPath, remainingCode);
await jj(repoPath, ["describe", "-m", "Remaining sample code"]);
const cleanService = new ReviewService({ repoPath });
resources.defer(() => cleanService.drain());
const cleanState = await cleanService.getState();
const branch = async (parent: string, description: string) => {
  await jj(repoPath, ["new", "--no-edit", parent, "-m", description]);
  return (
    await jj(repoPath, [
      "log",
      "--no-graph",
      "-r",
      `description(substring:"${description}")`,
      "-T",
      "change_id",
    ])
  ).stdout.trim();
};
const remainingComments = await branch(
  cleanState.source.changeId,
  "COMMENTS Remaining",
);
const reviewedComments = await branch(
  cleanState.parent!.changeId,
  "COMMENTS Reviewed",
);
const comments = {
  sourceChangeId: cleanState.source.changeId,
  reviewedChangeId: cleanState.parent!.changeId,
  branches: [
    {
      codeChangeId: cleanState.source.changeId,
      commentsChangeId: remainingComments,
    },
    {
      codeChangeId: cleanState.parent!.changeId,
      commentsChangeId: reviewedComments,
    },
  ],
};
const service = new ReviewService({ repoPath, comments });
resources.defer(() => service.drain());
const initial = await service.getState();
assert.equal(
  initial.canEditComments,
  true,
  initial.commentUnavailable + JSON.stringify(comments),
);
const seeded = await service.comment({
  version: initial.version,
  path: commentPath,
  action: "add",
  line: 1,
  endLine: 2,
  body: "What does this do?\n<img src=x onerror=alert(1)>",
});
assert.equal(seeded.state.source.commitId, initial.source.commitId);
const firstId = (
  await service.getComments({
    version: seeded.state.version,
    path: commentPath,
  })
).comments[0].id;
const revisionContents = async (revision: string) =>
  (
    await jj(repoPath, [
      "file",
      "show",
      "-r",
      revision,
      "--ignore-working-copy",
      "--",
      commentPath,
    ])
  ).stdout;
const app = express();
const router = createApi(service);
resources.defer(() => router.closeEvents());
app.use("/api", router);
const fixture = await createBrowserFixture({ app });
resources.defer(() => fixture.close());
const { page, url, errors } = fixture;
const firstCard = () => page.locator(`[data-comment-id="${firstId}"]`).last();
const newLine = (number: number) =>
  page
    .locator(`[data-line="${number}"]:not([data-line-type="change-deletion"])`)
    .last();
const reviewChange = (changeId: string) =>
  page.getByRole("button", {
    name: `Review change ${changeId}`,
    exact: true,
  });
const editor = page.getByRole("textbox", { name: "Comment body" });
const save = async () => {
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/comments"),
  );
  await page.getByRole("button", { name: "Save comment", exact: true }).click();
  const result = await response;
  assert.equal(result.status(), 200, await result.text());
  return (await result.json()).state;
};
const navigate = async (changeId: string) => {
  const response = page.waitForResponse((response) =>
    response.url().endsWith("/api/revision"),
  );
  await reviewChange(changeId).click();
  const selected = await response;
  assert.equal(selected.status(), 200, await selected.text());
  await expect(page.getByLabel("Current change ID")).toHaveAttribute(
    "title",
    changeId,
  );
};
await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
await page.goto(url);
await expect(firstCard()).toBeVisible();
await expect(firstCard()).toContainText("Line 1–2 · COMMENTS revision");
await expect(firstCard()).toContainText(
  "What does this do?\n<img src=x onerror=alert(1)>",
);
await expect(firstCard().locator("img")).toHaveCount(0);
await expect(page.locator("[data-fold-comment-marker]")).toHaveCount(0);
await expect(newLine(1)).toBeVisible();
await expect(newLine(1)).toHaveText("export const threshold = 30;");
await expect(
  page.getByRole("button", {
    name: `Squash file ${commentPath}`,
    exact: true,
  }),
).toBeEnabled();
assert.equal(await readFile(diskPath, "utf8"), remainingCode);
assert((await revisionContents(remainingComments)).includes(firstId));
assert(!(await revisionContents(initial.source.changeId)).includes("JJ-STAMP"));

// Ordinary shortcut letters remain textarea input. Saving only rewrites the
// independent side branch; overlay identity changes while clean code does not.
await firstCard().getByRole("button", { name: "Edit comment" }).click();
await editor.fill("");
await editor.pressSequentially("s u r e: literal <script>safe</script>");
await editor.press("Enter");
await editor.pressSequentially("second line");
const edited = await save();
assert.equal(edited.source.commitId, initial.source.commitId);
await expect(firstCard()).toContainText("second line");
await expect(page.locator(".code-surface")).toBeFocused();
await page.reload();
await expect(firstCard()).toContainText("second line");
assert.equal(await readFile(diskPath, "utf8"), remainingCode);

// Split/stacked and one/all-file modes all render the same clean anchors.
await page.getByRole("button", { name: "Split", exact: true }).click();
await expect(firstCard()).toBeVisible();
await page.getByRole("button", { name: "All files", exact: true }).click();
await expect(firstCard()).toBeVisible();
await page.getByRole("button", { name: "One file", exact: true }).click();
await page.getByRole("button", { name: "Stacked", exact: true }).click();
await newLine(1).click();
await newLine(5).click({ modifiers: ["Shift"] });
await page.keyboard.press("Control+c");
assert.equal(
  await page.evaluate(() => navigator.clipboard.readText()),
  remainingCode,
);

// Compose uses clean source lines4–5, despite earlier multiline markers in the
// companion file shifting its physical line positions by several rows.
await newLine(4).click();
await newLine(5).click({ modifiers: ["Shift"] });
await page.getByRole("button", { name: "Add comment", exact: true }).click();
await editor.fill("A new range comment");
const addedState = await save();
const added = (
  await service.getComments({
    version: addedState.version,
    path: commentPath,
  })
).comments.find((comment) => comment.body === "A new range comment");
assert(added);
assert.equal(added.startLine, 4);
assert.equal(added.endLine, 5);
const physical = parseReviewComments(
  commentPath,
  await revisionContents(remainingComments),
).comments.find((comment) => comment.id === added.id)!;
assert(physical.anchorLine > added.startLine);
await page.reload();
await expect(page.locator(`[data-comment-id="${added.id}"]`)).toBeVisible();

// A second client edits the real jj companion revision. Operation observation
// refreshes its overlay without changing source commit identity or workspace.
const external = await service.comment({
  version: (await service.getState()).version,
  path: commentPath,
  action: "edit",
  id: added.id,
  body: "Changed by another comment editor",
});
assert.equal(external.state.source.commitId, initial.source.commitId);
await expect(page.locator(`[data-comment-id="${added.id}"]`)).toContainText(
  "Changed by another comment editor",
  { timeout: 15_000 },
);
assert.equal(await readFile(diskPath, "utf8"), remainingCode);

// Squash annotated code normally: COMMENTS side branches do not contribute
// marker rows to selection maps or disable file/line squash actions.
await page.getByRole("button", { name: "Split", exact: true }).click();
await newLine(1).click();
await expect(page.getByRole("status")).toContainText(
  "2 changed lines selected",
);
const squashResponse = page.waitForResponse((response) =>
  response.url().endsWith("/api/squash-lines"),
);
await page.keyboard.press("s");
const squashResult = await squashResponse;
assert.equal(squashResult.status(), 200, await squashResult.text());
await expect(page.locator(".queue-count")).toHaveCount(0);
await navigate(initial.parent!.changeId);
await expect(firstCard()).toBeVisible();
await expect(firstCard()).toContainText("Line 1–2 · COMMENTS revision");
await navigate(initial.source.changeId);
await expect(
  page.getByRole("button", { name: "Undo", exact: true }),
).toBeEnabled();
const undoResponse = page.waitForResponse((response) =>
  response.url().endsWith("/api/undo"),
);
await page.locator(".code-surface").focus();
await page.keyboard.press("u");
const undone = await undoResponse;
assert.equal(undone.status(), 200, await undone.text());
await expect(firstCard()).toContainText("second line");
assert.equal(await readFile(diskPath, "utf8"), remainingCode);

// Reviewed gets its own source-file annotation branch. Unchanged code maps the
// new comment back onto Remaining without interleaving the main code chain.
await navigate(initial.parent!.changeId);
await newLine(3).click();
await page.getByRole("button", { name: "Add comment", exact: true }).click();
await editor.fill("Reviewed-side comment");
const reviewedSaved = await save();
const reviewedComment = (
  await service.getComments({
    version: reviewedSaved.version,
    path: commentPath,
  })
).comments.find((comment) => comment.body === "Reviewed-side comment");
assert(reviewedComment);
assert((await revisionContents(reviewedComments)).includes(reviewedComment.id));
await navigate(initial.source.changeId);
await expect(
  page.locator(`[data-comment-id="${reviewedComment.id}"]`),
).toBeVisible();
await page
  .locator(`[data-comment-id="${added.id}"]`)
  .getByRole("button", { name: "Remove comment" })
  .click();
await expect(page.locator(`[data-comment-id="${added.id}"]`)).toHaveCount(0);
assert(!(await revisionContents(remainingComments)).includes(added.id));
assert.equal(await readFile(diskPath, "utf8"), remainingCode);
assert.deepEqual(errors, []);

// A normal nonmanaged session cannot accidentally write embedded workspace
// markers or create comment branches on the user's behalf.
const ordinary = new ReviewService({ repoPath });
resources.defer(() => ordinary.drain());
const ordinaryApp = express();
const ordinaryRouter = createApi(ordinary);
resources.defer(() => ordinaryRouter.closeEvents());
ordinaryApp.use("/api", ordinaryRouter);
const ordinaryFixture = await createBrowserFixture({ app: ordinaryApp });
resources.defer(() => ordinaryFixture.close());
await ordinaryFixture.page.goto(ordinaryFixture.url);
await expect(
  ordinaryFixture.page.locator(".inline-comment-tools"),
).toContainText("managed PR review");
await expect(
  ordinaryFixture.page.getByRole("button", { name: "Add comment" }),
).toHaveCount(0);
assert.deepEqual(ordinaryFixture.errors, []);
console.log(
  "real-jj independent comment branches, clean overlays, squash/undo and reload: ok",
);
