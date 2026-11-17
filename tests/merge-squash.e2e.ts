// Run with: npx tsx tests/merge-squash.e2e.ts (real browser/API, disposable jj repo).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";
import { createApi } from "../server/api.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import type { RepoState } from "../src/types.ts";

await using cleanup = new AsyncDisposableStack();
const directory = await mkdtemp(path.join(tmpdir(), "merge-squash-browser-"));
cleanup.defer(() => rm(directory, { recursive: true, force: true }));
const repoPath = path.join(directory, "repo");
await jj(directory, ["git", "init", "--no-colocate", repoPath]);
for (const [key, value] of [
  ["user.name", "Merge Destination Test"],
  ["user.email", "merge@example.test"],
  ['revset-aliases."immutable_heads()"', "root()"],
])
  await jj(repoPath, ["config", "set", "--repo", key, value]);
const id = async (revision: string, template = "change_id") =>
  (
    await jj(repoPath, ["log", "--no-graph", "-r", revision, "-T", template])
  ).stdout.trim();
const base = Array.from(
  { length: 46 },
  (_, i) => `unchanged line ${i + 1}\n`,
).join("");
const leftText = base.replace("unchanged line 10\n", "LEFT inherited edit\n");
const rightText = base.replace("unchanged line 30\n", "RIGHT inherited edit\n");
const mergedBase = leftText.replace(
  "unchanged line 30\n",
  "RIGHT inherited edit\n",
);
const selectedEdit = "SELECTED merge-owned edit\n";
const unselectedEdit = "UNSELECTED merge-owned edit\n";
const withSelected = (text: string) =>
  text.replace("unchanged line 20\n", `${selectedEdit}unchanged line 20\n`);
const sourceText = withSelected(mergedBase).replace(
  "unchanged line 38\n",
  `${unselectedEdit}unchanged line 38\n`,
);
await writeFile(path.join(repoPath, "review.txt"), base);
await jj(repoPath, ["commit", "-m", "Shared base"]);
const baseId = await id("@-");
await writeFile(path.join(repoPath, "review.txt"), leftText);
await jj(repoPath, ["describe", "-m", "Left parent"]);
const left = await id("@");
await jj(repoPath, ["new", baseId, "-m", "Right parent"]);
await writeFile(path.join(repoPath, "review.txt"), rightText);
const right = await id("@");
await jj(repoPath, ["new", left, right, "-m", "Reviewed merge"]);
assert.equal(
  await readFile(path.join(repoPath, "review.txt"), "utf8"),
  mergedBase,
);
await writeFile(path.join(repoPath, "review.txt"), sourceText);
await jj(repoPath, ["commit", "-m", "Reviewed merge"]);
const source = await id("@-");
await writeFile(
  path.join(repoPath, "workspace.txt"),
  "unrelated working-copy bytes\n",
);
await jj(repoPath, ["describe", "-m", "Working copy away from reviewed merge"]);
const workspace = await id("@");

async function tree(revision: string): Promise<Record<string, Buffer>> {
  const listed = (
    await jj(repoPath, [
      "file",
      "list",
      "--ignore-working-copy",
      "-r",
      revision,
    ])
  ).stdout;
  const result: Record<string, Buffer> = {};
  for (const name of listed.trimEnd().split("\n").filter(Boolean)) {
    const file = await jj(repoPath, [
      "file",
      "show",
      "--ignore-working-copy",
      "-r",
      revision,
      "--",
      `root-file:${JSON.stringify(name)}`,
    ]);
    result[name] = file.stdoutBytes ?? Buffer.from(file.stdout);
  }
  return result;
}
const originals = Object.fromEntries(
  await Promise.all(
    [baseId, left, right, source, workspace].map(async (revision) => [
      revision,
      await tree(revision),
    ]),
  ),
);
const originalCommits = Object.fromEntries(
  await Promise.all(
    [baseId, left, right, source, workspace].map(async (revision) => [
      revision,
      await id(revision, "commit_id"),
    ]),
  ),
);
const service = new ReviewService({ repoPath, revision: source });
cleanup.defer(() => service.drain());
const initial = await service.getState();
assert.equal(initial.parent, null);
assert.equal(initial.squashUnavailable, undefined);
for (const parent of [left, right])
  assert(initial.targets.some((target) => target.changeId === parent));
const api = createApi(service);
cleanup.defer(() => api.closeEvents());
const app = express();
app.use("/api", api);
const fixture = await createBrowserFixture({
  app,
  config: {
    "log-revset": `${source} | ${left} | ${right} | ${baseId} | @`,
    "diff-style": "unified",
    "hover-sidebars": false,
  },
  captureConsoleErrors: true,
});
cleanup.defer(() => fixture.close());
const { page, url, errors } = fixture;
await page.addInitScript(() => {
  document.hasFocus = () => false;
});
const mutations: { target?: string; version: string }[] = [];
const revisions: unknown[] = [];
page.on("request", (request) => {
  if (request.method() !== "POST") return;
  if (request.url().endsWith("/api/squash-lines"))
    mutations.push(request.postDataJSON());
  if (request.url().endsWith("/api/revision"))
    revisions.push(request.postDataJSON());
});
const trigger = page.getByRole("button", { name: /^Squash into/ });
const menu = page.getByRole("menu", { name: "Squash destination" });
const destination = page.locator(".squash-destination");
const row = (revision: string) =>
  page.locator(`.log-change[data-change-id="${revision}"]`);
const squash = page.getByRole("button", { name: "Squash", exact: true });
const selectedLine = () =>
  page.locator('[data-line="20"][data-line-type="change-addition"]');
const selectedRows = page.locator("[data-line][data-fold-selected]");
const reason =
  "Choose a destination in the log; this revision has multiple parents.";
async function screenshot(name: string) {
  await mkdir(".planka-artifacts", { recursive: true });
  await page.screenshot({
    path: `.planka-artifacts/merge-squash-${name}.png`,
    fullPage: true,
  });
}
async function assertOriginalTrees() {
  for (const revision of [baseId, left, right, source, workspace])
    assert.deepEqual(
      await tree(revision),
      originals[revision],
      `Exact original tree: ${revision}`,
    );
  assert.equal(await id("@"), workspace);
  assert.equal(
    await readFile(path.join(repoPath, "review.txt"), "utf8"),
    sourceText,
  );
  assert.equal(
    await readFile(path.join(repoPath, "workspace.txt"), "utf8"),
    "unrelated working-copy bytes\n",
  );
}

try {
  // Cold Vite transforms can outlast the browser's default navigation timeout.
  // App readiness is asserted below rather than waiting for every load resource.
  await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  await expect(selectedLine()).toBeVisible({ timeout: 30_000 });
  await expect(trigger).toHaveText("Choose revision…⌄");
  await expect(trigger).toHaveAttribute("title", reason);
  await expect(squash).toBeDisabled();
  await selectedLine().click();
  await expect(selectedRows).toHaveCount(1);
  await expect(squash).toBeDisabled();
  const beforeShortcut = (await service.getState()).operation;
  await page.getByRole("button", { name: "Refresh", exact: true }).focus();
  await page.keyboard.press("s");
  await expect(page.getByRole("alert").locator(".error-summary")).toHaveText(
    reason,
  );
  assert.equal(mutations.length, 0);
  assert.equal((await service.getState()).operation, beforeShortcut);
  await assertOriginalTrees();
  await page
    .getByRole("alert")
    .getByRole("button", { name: "Dismiss error" })
    .click();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Undo between runs proves either direct parent can be the explicit target.
  for (const [index, target] of [left, right].entries()) {
    if (index) {
      await expect(selectedRows).toHaveCount(0);
      await selectedLine().click();
    }
    await trigger.click();
    await expect(
      menu.getByRole("menuitemradio", { name: /^Parent/ }),
    ).toBeDisabled();
    const choose = menu.getByRole("menuitem", {
      name: "Choose revision in log…",
      exact: true,
    });
    await expect(choose).toBeEnabled();
    await choose.click();
    await expect(page.locator(".destination-pick-help")).toBeVisible();
    for (const preview of [left, right]) {
      await expect(row(preview)).toBeEnabled();
      await row(preview).hover();
      await expect(destination).toContainText(preview.slice(0, 8));
      await expect(row(preview).locator("..")).toHaveClass(/is-destination/);
      await expect(page.locator(".destination-arrow.is-preview")).toBeVisible();
      await expect(page.getByRole("status")).toContainText(
        `Preview destination: ${preview.slice(0, 8)}`,
      );
    }
    await row(target).click();
    await expect(page.locator(".destination-pick-help")).toHaveCount(0);
    await expect(trigger).toHaveAccessibleName(
      `Squash into ${target.slice(0, 8)}`,
    );
    await expect(destination).toContainText(target.slice(0, 8));
    await expect(selectedRows).toHaveCount(1);
    await expect(squash).toBeEnabled();
    assert.equal(mutations.length, index, "Picking never mutates");
    assert.equal(
      revisions.length,
      0,
      "Picking never navigates the reviewed source",
    );
    await screenshot(`picker-${index ? "right" : "left"}`);

    // Hydrated expansion must use the merged-parent tree, never the destination
    // tree: each candidate is missing one of these inherited same-file edits.
    const current = await service.getState();
    const contentResponse = await page.request.post(`${url}/api/commit-file`, {
      headers: { "X-Fold-Request": "1" },
      data: { commitId: current.source.commitId, path: "review.txt" },
    });
    assert.equal(contentResponse.status(), 200, await contentResponse.text());
    const contents = await contentResponse.json();
    assert.equal(contents.oldFile.contents, mergedBase);
    assert.equal(contents.newFile.contents, sourceText);
    assert.notEqual(contents.oldFile.contents, leftText);
    assert.notEqual(contents.oldFile.contents, rightText);
    await page
      .getByRole("button", { name: "Show 10 lines above", exact: true })
      .first()
      .click();
    await expect(
      page.locator('[data-line="10"][data-line-type^="context"]'),
    ).toContainText("LEFT inherited edit");
    await page
      .getByRole("button", { name: "Show 10 lines above", exact: true })
      .last()
      .click();
    await expect(
      page.locator('[data-line="31"][data-line-type^="context"]'),
    ).toContainText("RIGHT inherited edit");
    await expect(selectedRows).toHaveCount(1);

    const before = await service.getState();
    const responsePromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/squash-lines"),
    );
    await squash.click();
    const response = await responsePromise;
    assert.equal(response.status(), 200, await response.text());
    const result: { state: RepoState; warning?: string } =
      await response.json();
    assert.equal(result.warning, undefined);
    assert.equal(result.state.parent, null);
    assert.equal(result.state.squashUnavailable, undefined);
    assert.equal(mutations[index].target, target);
    assert.equal(mutations[index].version, before.version);
    await expect(trigger).toBeEnabled();
    await expect(page.locator(".queue-count")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(destination).toContainText(target.slice(0, 8));
    assert.deepEqual(await tree(target), {
      "review.txt": Buffer.from(
        withSelected(target === left ? leftText : rightText),
      ),
    });
    for (const revision of [
      baseId,
      target === left ? right : left,
      source,
      workspace,
    ])
      assert.deepEqual(
        await tree(revision),
        originals[revision],
        `Only chosen destination tree changes: ${revision}`,
      );
    assert.equal(await id("@"), workspace);
    assert.equal(
      await readFile(path.join(repoPath, "review.txt"), "utf8"),
      sourceText,
    );
    assert.equal(
      await readFile(path.join(repoPath, "workspace.txt"), "utf8"),
      "unrelated working-copy bytes\n",
    );
    const sourceDiff = (await jj(repoPath, ["diff", "-r", source, "--git"]))
      .stdout;
    assert(sourceDiff.includes(`+${unselectedEdit.trimEnd()}`));
    assert(!sourceDiff.includes(`+${selectedEdit.trimEnd()}`));
    const additions = result.state.files.flatMap((file) =>
      file.hunks.flatMap((hunk) =>
        hunk.rows
          .filter((line) => line.raw.startsWith("+"))
          .map((line) => line.raw),
      ),
    );
    assert.deepEqual(additions, [`+${unselectedEdit.trimEnd()}`]);
    await screenshot(`squashed-${index ? "right" : "left"}`);

    const undoPromise = page.waitForResponse((response) =>
      response.url().endsWith("/api/undo"),
    );
    await page.getByRole("button", { name: /^Undo/ }).click();
    const undo = await undoPromise;
    assert.equal(undo.status(), 200, await undo.text());
    await expect(selectedLine()).toBeVisible();
    await expect(trigger).toBeEnabled();
    await assertOriginalTrees();
    for (const revision of [baseId, left, right, source, workspace])
      assert.equal(
        await id(revision, "commit_id"),
        originalCommits[revision],
        "Undo restores exact original commits",
      );
  }
  assert.deepEqual(errors, []);
  console.log(
    "Merge squash browser E2E passed (both direct parents, merged context, explicit queue, exact trees/workspace and undo).",
  );
} catch (error) {
  await screenshot("failure");
  console.error("Merge squash browser errors:", errors);
  throw error;
}
