// Run with: npx tsx tests/config-sync.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import {
  mkdtemp,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";

function repository() {
  const app = express();
  const source = {
    changeId: "k".repeat(32),
    commitId: "a".repeat(40),
    description: "Shared settings across servers",
    author: "Reviewer",
  };
  app.get("/api/state", (_request, response) =>
    response.json({
      repo: { name: "config-sync", path: "/example/config-sync" },
      version: "fixture-version",
      source,
      parent: null,
      targets: [],
      files: [],
      operation: "fixture-operation",
      canUndo: false,
    }),
  );
  app.get("/api/graph", (_request, response) =>
    response.json({
      version: "fixture-version",
      rows: [{ graph: "@ ", revision: source }],
    }),
  );
  app.get("/api/events", (_request, response) => {
    response.type("text/event-stream").end("event: unavailable\ndata: {}\n\n");
  });
  return app;
}

const root = await mkdtemp(path.join(tmpdir(), "jj-stamp-config-sync-"));
const configPath = path.join(root, "config.json");
await using resources = new AsyncDisposableStack();
resources.defer(() => rm(root, { recursive: true, force: true }));
const first = await createBrowserFixture({ app: repository(), configPath });
resources.defer(() => first.close());
const second = await createBrowserFixture({ app: repository(), configPath });
resources.defer(() => second.close());
const third = await first.browser.newPage({
  viewport: { width: 1440, height: 900 },
});
third.on("pageerror", (error) => first.errors.push(error.message));
const pages = [first.page, second.page, third];

// Old per-origin storage must neither seed nor overwrite the shared file.
await first.page.addInitScript(() => {
  localStorage.setItem("jj-stamp.color-scheme", "light");
  localStorage.setItem("jj-stamp.vim-mode", "true");
});
// Unlike repository refresh, settings observation must stay alive in background.
await second.page.addInitScript(() => {
  Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  document.hasFocus = () => false;
});
await Promise.all([
  first.page.goto(first.url),
  second.page.goto(second.url),
  third.goto(first.url),
]);
for (const page of pages) {
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dark",
  );
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("checkbox", { name: /Vim mode/ }),
  ).not.toBeChecked();
}
await assert.rejects(readFile(configPath), { code: "ENOENT" });

async function scheme(value: string) {
  for (const page of pages) {
    await expect(page.locator("html")).toHaveAttribute(
      "data-color-scheme",
      value,
    );
    await expect(page.getByLabel("Color scheme")).toHaveValue(value);
  }
}
await first.page.getByLabel("Color scheme").selectOption("light");
await scheme("light");
await expect
  .poll(async () => (await first.readConfig())["color-scheme"])
  .toBe("light");

// Distinct changes in different windows merge rather than replacing a stale
// whole document. The third window is on the same server as the first.
await Promise.all([
  first.page.getByRole("checkbox", { name: /Vim mode/ }).check(),
  second.page
    .getByRole("checkbox", { name: /Reveal sidebars on hover/ })
    .check(),
]);
for (const page of pages) {
  await expect(page.getByRole("checkbox", { name: /Vim mode/ })).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: /Reveal sidebars on hover/ }),
  ).toBeChecked();
}
await expect
  .poll(async () => {
    const config = await first.readConfig();
    return [
      config["vim-mode"],
      config["hover-sidebars"],
      config["color-scheme"],
    ];
  })
  .toEqual([true, true, "light"]);

// An editor's atomic save updates all windows, even the hidden/unfocused one.
await writeFile(
  path.join(root, "replacement.json"),
  JSON.stringify({
    "color-scheme": "solarized-dark",
    "font-size": 17,
    "diff-style": "split",
    "files-expanded": false,
    "log-revset": "all()",
  }),
);
await rename(path.join(root, "replacement.json"), configPath);
await scheme("solarized-dark");
for (const page of pages) {
  await expect(page.getByLabel("Font size", { exact: true })).toHaveValue("17");
  await expect(page.locator(".workspace")).toHaveClass(/files-collapsed/);
  await expect(
    page.getByRole("textbox", { name: "jj log revset" }),
  ).toHaveValue("all()");
}

// Preserve an actively edited revset draft, but still apply disk config to the
// actual graph and every other control.
const thirdDraft = third.getByRole("textbox", { name: "jj log revset" });
await thirdDraft.fill("mine()");
await writeFile(
  configPath,
  JSON.stringify({ "color-scheme": "dim", "log-revset": "none()" }),
);
await scheme("dim");
await expect(
  first.page.getByRole("textbox", { name: "jj log revset" }),
).toHaveValue("none()");
await expect(thirdDraft).toHaveValue("mine()");

// Malformed edits retain the last good view, surface an error, and recover.
await writeFile(configPath, "{ broken JSON");
for (const page of pages) {
  await expect(page.getByRole("dialog").getByRole("status")).toContainText(
    "invalid JSON",
  );
  await expect(page.locator("html")).toHaveAttribute(
    "data-color-scheme",
    "dim",
  );
}
await writeFile(
  configPath,
  JSON.stringify({ "color-scheme": "light", "font-size": 16 }),
);
await scheme("light");
for (const page of pages) {
  await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
}

// Optional evidence captures the real UI from both independently served windows.
if (process.env.JJ_STAMP_SCREENSHOTS) {
  const directory = path.resolve(process.env.JJ_STAMP_SCREENSHOTS);
  await mkdir(directory, { recursive: true });
  await first.page.screenshot({
    path: path.join(directory, "shared-config-server-one.png"),
  });
  await second.page.screenshot({
    path: path.join(directory, "shared-config-server-two.png"),
  });
}

// Deletion resets to defaults and recreation works without restarting streams.
await unlink(configPath);
await scheme("dark");
await writeFile(configPath, JSON.stringify({ "color-scheme": "dracula" }));
await scheme("dracula");
await first.page.getByRole("button", { name: "Close settings" }).click();
await first.page.reload();
await expect(first.page.locator("html")).toHaveAttribute(
  "data-color-scheme",
  "dracula",
);
assert.deepEqual(first.errors, []);
assert.deepEqual(second.errors, []);
console.log(
  "Config sync browser checks passed: two servers, three windows, background sync, merged edits, atomic disk saves, invalid edits, deletion/recreation, reload, ignored browser cache.",
);
