import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clampSidebarWidth,
  colorSchemes,
  parseFileView,
  parseColorScheme,
  parseSidebarWidth,
  resizeFromKey,
} from "../src/preferences.ts";
import { SidebarResize } from "../src/SidebarResize.tsx";
import {
  ChangeId,
  ColorSchemePicker,
  SettingsDialog,
  RevisionHeading,
  revisionPageTitle,
} from "../src/ReviewToolbar.tsx";

const source = {
  changeId: "abcdefghijklmno",
  changeIdPrefix: "abc",
  description: "Review a change",
  commitId: "0123456789abcdef",
  author: "A. Reviewer",
};

test("appearance preferences validate stored values and preserve known schemes", () => {
  assert.equal(parseColorScheme(null), "dark");
  assert.equal(parseColorScheme("unknown"), "dark");
  assert.equal(parseColorScheme("toString"), "dark");
  assert.equal(colorSchemes["solarized-dark"].themeType, "dark");
  assert.equal(colorSchemes["solarized-light"].themeType, "light");
  for (const scheme of Object.keys(colorSchemes))
    assert.equal(parseColorScheme(scheme), scheme);
  assert.equal(parseSidebarWidth("files", null), 245);
  assert.equal(parseSidebarWidth("log", ""), 350);
  assert.equal(parseSidebarWidth("log", "  "), 350);
  assert.equal(parseSidebarWidth("files", "bad"), 245);
  assert.equal(parseSidebarWidth("log", "Infinity"), 350);
  assert.equal(parseSidebarWidth("files", "298.7"), 299);
  assert.equal(parseSidebarWidth("log", "410"), 410);
  assert.equal(parseSidebarWidth("files", "-20"), 120);
  assert.equal(parseSidebarWidth("log", "999999"), 640);
});

test("file view defaults to one file and validates its stored preference", () => {
  assert.equal(parseFileView(null), "single");
  assert.equal(parseFileView("unknown"), "single");
  assert.equal(parseFileView("single"), "single");
  assert.equal(parseFileView("all"), "all");
});

test("sidebar keyboard resizing follows the physical edge in either sidebar", () => {
  assert.equal(resizeFromKey("files", 245, "ArrowRight"), 255);
  assert.equal(resizeFromKey("files", 245, "ArrowLeft", true), 205);
  assert.equal(resizeFromKey("log", 350, "ArrowLeft"), 360);
  assert.equal(resizeFromKey("log", 350, "ArrowRight", true), 310);
  assert.equal(resizeFromKey("files", 245, "Home"), 120);
  assert.equal(resizeFromKey("log", 350, "End"), 640);
  assert.equal(resizeFromKey("files", 520, "ArrowRight"), 520);
  assert.equal(resizeFromKey("log", 160, "ArrowRight"), 160);
  assert.equal(resizeFromKey("files", 245, "s"), null);
  assert.equal(clampSidebarWidth("log", NaN), 350);
});

test("resizers expose their purpose, bounds and current width to keyboard and AT", () => {
  const html = renderToStaticMarkup(
    createElement(SidebarResize, {
      side: "files",
      width: 275,
      onResize() {},
    }),
  );
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-label="Resize files sidebar"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-valuenow="275"/);
  assert.match(html, /aria-valuemin="120"/);
  assert.match(html, /aria-valuemax="520"/);
  assert.match(html, /tabindex="0"/);
});

test("page title puts the description before the short change ID and full repository path", () => {
  assert.equal(
    revisionPageTitle(source, "/home/me/repository"),
    "Review a change (abcdefgh /home/me/repository)",
  );
  assert.equal(
    revisionPageTitle(
      { ...source, changeIdPrefix: "abcdefghij" },
      "/repo with spaces",
    ),
    "Review a change (abcdefghij /repo with spaces)",
  );
  assert.equal(
    revisionPageTitle({ ...source, description: "" }, "/repo"),
    "(no description) (abcdefgh /repo)",
  );
  assert.equal(revisionPageTitle(source, undefined), "jj-stamp");
  assert.equal(revisionPageTitle(undefined, "/repo"), "jj-stamp");
  assert.equal(revisionPageTitle(undefined, undefined), "jj-stamp");
});

test("heading groups change ID, title, commit ID and totals without the author", () => {
  const html = renderToStaticMarkup(
    createElement(RevisionHeading, { source }, "change +422 −15"),
  );
  assert.doesNotMatch(html, /<strong>|Revision author|A\. Reviewer/);
  assert.match(html, />abcdefgh</);
  const fields = [
    ">abcdefgh<",
    ">Review a change<",
    ">0123456789ab<",
    "change +422 −15",
  ];
  const positions = fields.map((field) => html.indexOf(field));
  assert.ok(positions.every((position) => position >= 0));
  assert.deepEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
  assert.match(
    renderToStaticMarkup(
      createElement(RevisionHeading, {
        source: { ...source, description: "" },
      }),
    ),
    /\(no description\)/,
  );
});

test("change ID display handles old metadata and prefixes longer than eight characters", () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(ChangeId, {
        revision: { ...source, changeIdPrefix: undefined },
      }),
    ),
    "abcdefgh",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ChangeId, {
        revision: { ...source, changeIdPrefix: "abcdefghij" },
      }),
    ),
    "abcdefghij",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ChangeId, {
        revision: { ...source, changeIdPrefix: "mismatch" },
      }),
    ),
    "abcdefgh",
  );
});

test("theme control exposes all supported palettes and current preference", () => {
  const html = renderToStaticMarkup(
    createElement(ColorSchemePicker, {
      value: "light",
      disabled: false,
      onChange() {},
    }),
  );
  assert.match(html, /aria-label="Color scheme"/);
  assert.match(html, /value="light" selected=""/);
  for (const scheme of Object.keys(colorSchemes))
    assert.match(html, new RegExp(`value="${scheme}"`));
});

test("settings uses a labeled, initially closed native dialog and a named close control", () => {
  const html = renderToStaticMarkup(
    createElement(SettingsDialog, {
      colorScheme: "dark",
      disabled: false,
      onColorSchemeChange() {},
    }),
  );
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /<dialog[^>]*aria-labelledby=/);
  assert.doesNotMatch(html, /<dialog[^>]*\bopen(?:[ =>])/);
  assert.match(html, /<h2[^>]*>Settings<\/h2>/);
  assert.match(html, /aria-label="Close settings"/);
  assert.match(html, /<span>Color scheme<\/span>/);
});
