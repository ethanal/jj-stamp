// Run with: npx tsx tests/config-sync.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { configSchema, defaultConfig } from "../src/config.ts";
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
// Two independent cold Vite caches can take more than 30s to serve the initial
// module graph on a busy VM. Keep normal interaction assertions at 5s.
for (const page of pages) page.setDefaultNavigationTimeout(120_000);

// Old per-origin storage must neither seed nor overwrite the shared file.
await first.page.addInitScript(() => {
  localStorage.setItem("jj-stamp.color-scheme", "light");
  localStorage.setItem("jj-stamp.vim-mode", "true");
});
// Unlike repository refresh, settings observation must stay alive in background.
// A source string avoids capturing tsx's keepNames helper in the getter.
await second.page.addInitScript(`
  Object.defineProperty(document, "visibilityState", { get: () => "hidden" });
  document.hasFocus = () => false;
`);
await Promise.all([
  first.page.goto(first.url),
  second.page.goto(second.url),
  third.goto(first.url),
]);
assert.deepEqual(
  await second.page.evaluate(() => ({
    visibility: document.visibilityState,
    focused: document.hasFocus(),
  })),
  { visibility: "hidden", focused: false },
);
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
await assertNoRecoveryControls();
await assert.rejects(readFile(configPath), { code: "ENOENT" });

async function assertNoRecoveryControls() {
  for (const page of pages) {
    await expect(
      page.getByRole("button", {
        name: /reset|back.?up/i,
        includeHidden: true,
      }),
    ).toHaveCount(0);
  }
}

async function screenshot(name: string) {
  if (!process.env.JJ_STAMP_SCREENSHOTS) return;
  const directory = path.resolve(process.env.JJ_STAMP_SCREENSHOTS);
  await mkdir(directory, { recursive: true });
  await first.page.screenshot({ path: path.join(directory, name) });
}

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
    shell: "/external/shell",
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
  await expect(
    page.getByRole("textbox", { name: "Terminal shell" }),
  ).toHaveValue("/external/shell");
}

// Preserve an actively edited revset draft, but still apply disk config to the
// actual graph and every other control.
const thirdDraft = third.getByRole("textbox", { name: "jj log revset" });
const thirdShellDraft = third.getByRole("textbox", { name: "Terminal shell" });
await thirdDraft.fill("mine()");
await thirdShellDraft.fill("/mine/shell");
await writeFile(
  configPath,
  JSON.stringify({
    "color-scheme": "dim",
    "log-revset": "none()",
    shell: "/updated/shell",
  }),
);
await scheme("dim");
await expect(
  first.page.getByRole("textbox", { name: "jj log revset" }),
).toHaveValue("none()");
await expect(thirdDraft).toHaveValue("mine()");
await expect(
  first.page.getByRole("textbox", { name: "Terminal shell" }),
).toHaveValue("/updated/shell");
await expect(thirdShellDraft).toHaveValue("/mine/shell");
// Reopening discards both unsaved drafts so subsequent disk edits can follow
// the saved revset and shell in all windows again.
await third.getByRole("button", { name: "Close settings" }).click();
await third.getByRole("button", { name: "Settings", exact: true }).click();
await expect(thirdDraft).toHaveValue("none()");
await expect(thirdShellDraft).toHaveValue("/updated/shell");

// Malformed edits retain the last good view and require manual file repair.
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
await assertNoRecoveryControls();
// An attempted save must fail without overwriting the invalid file.
await first.page.getByLabel("Color scheme").selectOption("light");
await expect(first.page.getByRole("dialog").getByRole("status")).toContainText(
  "Settings save could not be confirmed",
);
assert.equal(await readFile(configPath, "utf8"), "{ broken JSON");
await writeFile(
  configPath,
  JSON.stringify({ "color-scheme": "light", "font-size": 16 }),
);
await scheme("light");
for (const page of pages) {
  await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
}
assert.deepEqual(await readdir(root), ["config.json"]);

// Future keys and unsupported enum/type/range values are tolerated on external
// edits and initial page loads. Valid siblings apply; only unsupported fields
// fall back to their defaults, without offering destructive recovery.
const futureConfig = {
  "future-preferences": {
    version: 2,
    nested: ["keep me", { enabled: true }, null],
  },
  "color-scheme": "future-neon",
  "font-size": 99,
  "diff-style": "future-layout",
  "vim-mode": "enabled",
  "file-view": { mode: "future" },
  "hover-sidebars": true,
  "files-expanded": false,
  "log-revset": "all()",
};
await writeFile(configPath, JSON.stringify(futureConfig));
await scheme("dark");
async function assertUnsupportedDefaults() {
  await scheme("dark");
  for (const page of pages) {
    await expect(page.getByLabel("Font size", { exact: true })).toHaveValue(
      "13",
    );
    await expect(
      page.getByRole("checkbox", { name: /Vim mode/ }),
    ).not.toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /Reveal sidebars on hover/ }),
    ).toBeChecked();
    await expect(page.locator(".workspace")).toHaveClass(/files-collapsed/);
    await expect(
      page.getByRole("textbox", { name: "jj log revset" }),
    ).toHaveValue("all()");
    await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
  }
  await assertNoRecoveryControls();
}
await assertUnsupportedDefaults();
// All three windows also tolerate unsupported settings on a fresh page load,
// including both independent server connections.
await Promise.all(pages.map((page) => page.reload()));
for (const page of pages)
  await page.getByRole("button", { name: "Settings", exact: true }).click();
await assertUnsupportedDefaults();
for (const url of [first.url, second.url]) {
  const response = await fetch(`${url}/api/config`);
  assert.equal(response.status, 200);
  assert.deepEqual(configSchema.parse(await response.json()), {
    ...defaultConfig,
    "hover-sidebars": true,
    "files-expanded": false,
    "log-revset": "all()",
  });
}

// Saving an unrelated preference must preserve the raw future content, not
// replace it with the typed/defaulted effective config returned to browsers.
await first.page
  .getByRole("checkbox", { name: /Reveal sidebars on hover/ })
  .uncheck();
await expect
  .poll(async () => JSON.parse(await readFile(configPath, "utf8")))
  .toEqual({ ...futureConfig, "hover-sidebars": false });
for (const page of pages) {
  await expect(
    page.getByRole("checkbox", { name: /Reveal sidebars on hover/ }),
  ).not.toBeChecked();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
}
await assertNoRecoveryControls();
await screenshot("settings-default-fallback-no-reset.png");

// Explicitly replacing one unsupported field leaves every other raw key alone.
await first.page.getByLabel("Color scheme").selectOption("light");
await scheme("light");
await expect
  .poll(async () => JSON.parse(await readFile(configPath, "utf8")))
  .toEqual({
    ...futureConfig,
    "hover-sidebars": false,
    "color-scheme": "light",
  });

// Malformed documents retain the last valid settings, with manual repair
// guidance rather than backup/reset controls or automatic file replacement.
const malformedConfig = '{ "font-size": 15, "color-scheme": "light", }\n';
await writeFile(configPath, malformedConfig);
for (const page of pages) {
  const status = page.getByRole("dialog").getByRole("status");
  await expect(status).toContainText("invalid JSON");
  await expect(status).toContainText(/manually|manual repair|edit.*file/i);
  await expect(page.getByLabel("Font size", { exact: true })).toHaveValue("13");
  await expect(
    page.getByRole("checkbox", { name: /Reveal sidebars on hover/ }),
  ).not.toBeChecked();
  await expect(page.locator(".workspace")).toHaveClass(/files-collapsed/);
  await expect(
    page.getByRole("textbox", { name: "jj log revset" }),
  ).toHaveValue("all()");
}
await scheme("light");
await assertNoRecoveryControls();
await screenshot("settings-malformed-no-reset.png");
assert.equal(await readFile(configPath, "utf8"), malformedConfig);
assert.deepEqual(await readdir(root), ["config.json"]);

// The user repairs the file externally. A valid partial config clears every
// window's error and uses defaults for omitted fields, without a server restart.
await writeFile(
  configPath,
  JSON.stringify({ "color-scheme": "dim", "font-size": 16 }),
);
await scheme("dim");
for (const page of pages) {
  await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
  await expect(page.getByLabel("Font size", { exact: true })).toHaveValue("16");
  await expect(page.locator(".workspace")).not.toHaveClass(/files-collapsed/);
  await expect(
    page.getByRole("textbox", { name: "jj log revset" }),
  ).toHaveValue(defaultConfig["log-revset"]);
}
await assertNoRecoveryControls();
await first.page.getByLabel("Color scheme").selectOption("light");
await scheme("light");
await expect
  .poll(async () => (await first.readConfig())["color-scheme"])
  .toBe("light");
for (const page of pages) {
  await expect(page.getByRole("dialog").getByRole("status")).toHaveCount(0);
}
assert.deepEqual(await readdir(root), ["config.json"]);

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
  "Config sync browser checks passed: two servers, three windows, background sync, merged edits, atomic disk saves, tolerant future values on external edit/reload, raw unknown preservation, explicit field replacement, malformed edits, failed-save manual repair, no backup/reset controls or backup files, subsequent save, deletion/recreation, reload, ignored browser cache.",
);
