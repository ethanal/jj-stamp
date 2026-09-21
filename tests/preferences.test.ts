import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  clampSidebarWidth,
  parseColorScheme,
  parseSidebarWidth,
  resizeFromKey,
} from "../src/preferences.ts";
import { SidebarResize } from "../src/SidebarResize.tsx";
import {
  ChangeId,
  ColorSchemePicker,
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
  for (const scheme of ["light", "dark", "dim"] as const)
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

test("page title uses the complete change id and repository path in the requested order", () => {
  assert.equal(
    revisionPageTitle(source, "/home/me/repository"),
    "abcdefghijklmno: Review a change (/home/me/repository)",
  );
  assert.equal(revisionPageTitle(undefined, undefined), "jj-stamp");
});

test("heading puts change id, author, title, then commit id and bolds only unique prefix", () => {
  const html = renderToStaticMarkup(createElement(RevisionHeading, { source }));
  assert.match(html, /<strong>abc<\/strong>defgh/);
  const fields = [
    "<strong>abc",
    "A. Reviewer",
    ">Review a change<",
    ">0123456789ab<",
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
        source: {
          changeId: "abcdefghijk",
          commitId: "0123456789abcdef",
          description: "",
        },
      }),
    ),
    /Unknown author/,
  );
});

test("change ID display handles old metadata and prefixes longer than eight characters", () => {
  assert.equal(
    renderToStaticMarkup(
      createElement(ChangeId, {
        revision: { ...source, changeIdPrefix: undefined },
      }),
    ),
    "<strong>abcdefgh</strong>",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ChangeId, {
        revision: { ...source, changeIdPrefix: "abcdefghij" },
      }),
    ),
    "<strong>abcdefghij</strong>",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(ChangeId, {
        revision: { ...source, changeIdPrefix: "mismatch" },
      }),
    ),
    "<strong>abcdefgh</strong>",
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
  for (const scheme of ["light", "dark", "dim"])
    assert.match(html, new RegExp(`value="${scheme}"`));
});
