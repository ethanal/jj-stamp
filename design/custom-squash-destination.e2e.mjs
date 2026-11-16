// Design-only checks. No app/API server or repository mutations.
// Run from the repository root: node design/custom-squash-destination.e2e.mjs
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

await mkdir(".planka-artifacts", { recursive: true });
const html = await readFile(
  new URL("./custom-squash-destination.html", import.meta.url),
  "utf8",
);
await writeFile(
  ".planka-artifacts/index.html",
  html.replace("../src/fonts/SourceCodePro.ttf", "SourceCodePro.ttf"),
);
// Shelley iframes cannot fetch sibling files. Embed the same local font so the
// interactive presentation preserves graph metrics without network requests.
const font = await readFile(
  new URL("../src/fonts/SourceCodePro.ttf", import.meta.url),
);
await writeFile(
  ".planka-artifacts/interactive-mockups.html",
  html.replace(
    "../src/fonts/SourceCodePro.ttf",
    `data:font/ttf;base64,${font.toString("base64")}`,
  ),
);
await copyFile(
  new URL("../src/fonts/SourceCodePro.ttf", import.meta.url),
  ".planka-artifacts/SourceCodePro.ttf",
);

await copyFile(
  new URL("../public/fonts/source-code-pro/OFL.txt", import.meta.url),
  ".planka-artifacts/OFL.txt",
);

const browser = await chromium.launch({ args: ["--no-sandbox"] });
async function expectCompactGraph(page, expectedRows = 5) {
  const geometry = await page.locator("#log-list").evaluate((log) => {
    const probe = document.createElement("div");
    probe.textContent = "@  normal line height";
    probe.style.cssText = "position:absolute;font:inherit;line-height:normal";
    log.append(probe);
    const normalHeight = probe.getBoundingClientRect().height;
    probe.remove();
    const rows = [...log.querySelectorAll(".revision")];
    return {
      lineHeight: getComputedStyle(log).lineHeight,
      whiteSpace: getComputedStyle(log).whiteSpace,
      normalHeight,
      rows: rows.map((row) => {
        const bounds = row.getBoundingClientRect();
        const graph = row.querySelector(".graph");
        const id = row.querySelector(".review-id");
        const title = row.querySelector(".row-title");
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          graph: graph.textContent,
          graphWidth: graph.getBoundingClientRect().width,
          idOffset:
            id.getBoundingClientRect().left -
            graph.getBoundingClientRect().left,
          titleTop: title.getBoundingClientRect().top,
          idTop: id.getBoundingClientRect().top,
          styles: [...row.querySelectorAll("*")].map((node) => {
            const style = getComputedStyle(node);
            return {
              font: style.fontFamily,
              size: style.fontSize,
              lineHeight: style.lineHeight,
            };
          }),
        };
      }),
    };
  });
  assert.equal(geometry.lineHeight, "normal");
  assert.equal(geometry.whiteSpace, "pre");
  assert.equal(geometry.rows.length, expectedRows);
  for (const [index, row] of geometry.rows.entries()) {
    assert.equal(row.height, geometry.normalHeight, "no padded/tall log rows");
    assert.equal(row.titleTop, row.idTop, "description stays on the ID's line");
    assert.equal(
      row.idOffset,
      row.graphWidth,
      "literal graph prefix sets ID column",
    );
    assert.equal(
      row.graphWidth,
      geometry.rows[0].graphWidth,
      "monospace graph cells align",
    );
    assert.equal(row.graph.includes("\n"), false, "no invented connector rows");
    assert.equal(row.graph.length, 3);
    for (const style of row.styles) {
      assert.equal(style.font.includes("Source"), true);
      assert.equal(style.size, "13px", "controls inherit the graph font size");
      assert.equal(style.lineHeight, "normal");
    }
    if (index)
      assert.equal(
        row.top,
        geometry.rows[index - 1].bottom,
        "no inter-row gaps",
      );
  }
}
async function expectRoute(page, destination, preview = false) {
  const handle = page.locator("#route-handle");
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("data-destination", destination);
  await expect(handle).toHaveClass(preview ? /preview/ : /^(?!.*preview)/);
  const geometry = await handle.evaluate((button, id) => {
    const source = document
      .querySelector(".revision.current")
      .getBoundingClientRect();
    const target = document
      .querySelector(`[data-revision="${id}"]`)
      .getBoundingClientRect();
    const bounds = button.getBoundingClientRect();
    const graphViewport = document
      .querySelector("#log-list")
      .getBoundingClientRect();
    return {
      sourceError: Math.abs(bounds.top + 6 - (source.top + source.height / 2)),
      destinationError: Math.abs(
        bounds.bottom - 6 - (target.top + target.height / 2),
      ),
      staysInMargin: bounds.right <= graphViewport.left,
    };
  }, destination);
  assert.ok(
    geometry.sourceError < 0.1,
    "arrow starts at the source row center",
  );
  assert.ok(
    geometry.destinationError < 0.1,
    "arrow lands at the destination row center",
  );
  assert.equal(
    geometry.staysInMargin,
    true,
    "arrow never displaces or overlaps the jj graph",
  );
}
async function captureLog(page, filename) {
  const bounds = await page.locator(".log").boundingBox();
  await page.screenshot({
    path: `.planka-artifacts/${filename}`,
    clip: { ...bounds, height: 275 },
  });
}
async function expectClickOnly(page) {
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(
    page.locator(
      "input, textarea, [contenteditable=true], #custom-editor, #destination-revset, #apply-revset",
    ),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Apply", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.locator(
      "#route-svg circle, #route-svg ellipse, #route-svg marker, #route-source",
    ),
  ).toHaveCount(0);
  await expect(page.locator("#route-svg path")).toHaveCount(2);
}
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.goto(
    new URL("./custom-squash-destination.html", import.meta.url).href,
  );
  await page.evaluate(() => document.fonts.ready);
  const mode = page.getByRole("combobox", {
    name: "Squash destination mode",
    exact: true,
  });
  const target = page.locator("#destination-id"),
    source = page.locator(".revision.current .review-id"),
    squash = page.locator("#squash-demo");
  await expectClickOnly(page);
  await expect(mode).toHaveValue("parent");
  await expect(mode.locator("option")).toHaveText(["Commit below", "Custom…"]);
  await expect(target).toHaveText("pqxvqmoo");
  await expectRoute(page, "pqxvqmoo");
  await expectCompactGraph(page);
  await expect(squash).toBeEnabled();
  await expect(page.locator(".role, .row-note, .row-action")).toHaveCount(0);
  await expect(page.locator(".revision.target")).toHaveCSS(
    "box-shadow",
    "none",
  );
  await expect(page.locator(".revision.target")).toHaveCSS(
    "border-left-width",
    "0px",
  );
  await expect(page.locator(".revision.target")).toHaveCSS(
    "background-color",
    "rgb(41, 38, 31)",
  );

  // Default follows the reviewed source's real parent, not @ or filtered rows.
  await page.locator("#move-working-copy").click();
  await expect(target).toHaveText("pqxvqmoo");
  await expect(source).toHaveText("vqkqszmu");
  await expectRoute(page, "pqxvqmoo");
  await expectCompactGraph(page, 6);
  await page.locator('[data-view="default"]').click();
  await page.locator("#review-parent").click();
  await expect(source).toHaveText("pqxvqmoo");
  await expect(page.locator(".app-header .blue")).toHaveText("pqxvqmoo");
  await expect(page.locator('[data-revision="vqkqszmu"] .graph')).toHaveText(
    "@  ",
  );
  await expectRoute(page, "rwpxovrz");
  await expectCompactGraph(page);
  await captureLog(page, "click-only-01-commit-below.png");
  await page.locator("#move-working-copy").click();
  await expect(target).toHaveText("rwpxovrz");
  await page.locator("#scenario").selectOption("filtered");
  await expect(mode).toHaveValue("parent");
  await expect(target).toHaveText("pqxvqmoo");
  await expect(page.locator('[data-revision="pqxvqmoo"]')).toHaveCount(0);
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(squash).toBeEnabled();
  await expectCompactGraph(page, 4);

  // Custom is only a commit-row picker, with no entry field or Apply button.
  await page.locator('[data-view="default"]').click();
  await mode.selectOption("custom");
  await expect(mode).toHaveValue("custom");
  await expect(page.locator("#pick-help")).toBeVisible();
  await expect(page.locator("#cancel-custom")).toBeVisible();
  await expectClickOnly(page);
  await expect(
    page.getByRole("button", {
      name: "Choose destination vqkqszmu",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", {
      name: "Choose destination zzzzzzzz",
      exact: true,
    }),
  ).toBeDisabled();
  await page.locator('[data-revision="zzzzzzzz"] .row-title').click();
  await expect(mode).toHaveValue("custom");
  await expect(squash).toBeDisabled();
  await page.locator('[data-revision="rwpxovrz"] .row-title').hover();
  await expectRoute(page, "rwpxovrz", true);
  await expectCompactGraph(page);
  await captureLog(page, "click-only-02-choosing.png");
  await page.keyboard.press("Escape");
  await expect(mode).toHaveValue("parent");
  await expect(mode).toBeFocused();
  await expect(page.locator("#pick-help")).toBeHidden();
  await expectRoute(page, "pqxvqmoo");

  await mode.selectOption("custom");
  await page.locator('[data-revision="rwpxovrz"] .row-title').click();
  await expect(mode).toHaveValue("custom");
  await expectRoute(page, "rwpxovrz");
  await expect(squash).toBeEnabled();
  await expect(page.locator("#pick-help")).toBeHidden();
  await expect(source).toHaveText("vqkqszmu");
  await expect(page.locator(".line.sel")).toHaveCount(3);
  await expect(page.locator("#selection-target")).toHaveText("rwpxovrz");
  await expect(page.locator("#footer-destination")).toHaveText("rwpxovrz");
  await expectClickOnly(page);
  await captureLog(page, "click-only-03-selected.png");

  // Reopening/cancelling preserves a committed custom target and mode.
  await page.locator("#change-custom").click();
  await page.locator('[data-revision="ksuunvyp"] .row-title').hover();
  await expectRoute(page, "ksuunvyp", true);
  await page.locator("#cancel-custom").click();
  await expect(mode).toHaveValue("custom");
  await expectRoute(page, "rwpxovrz");
  await page.locator("#change-custom").click();
  await page
    .getByRole("button", { name: "Choose destination ksuunvyp", exact: true })
    .click();
  await expectRoute(page, "ksuunvyp");
  await mode.selectOption("parent");
  await expectRoute(page, "pqxvqmoo");
  await page.locator("#route-handle").click();
  await expect(mode).toHaveValue("custom");
  await page.locator("#cancel-custom").click();
  await expect(mode).toHaveValue("parent");
  await expectRoute(page, "pqxvqmoo");

  // Retain keyboard access without any text entry, skipping unavailable rows.
  await page.locator('[data-view="default"]').click();
  await page.locator("#route-handle").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowUp");
  await expectRoute(page, "pqxvqmoo", true);
  await page.keyboard.press("ArrowDown");
  await expectRoute(page, "rwpxovrz", true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectRoute(page, "ksuunvyp", true);
  await page.keyboard.press("Enter");
  await expectRoute(page, "ksuunvyp");
  await expect(squash).toBeEnabled();

  // A clicked target stays fixed as @ moves; source changes can invalidate it.
  await page.locator("#scenario").selectOption("custom");
  await page.locator("#move-working-copy").click();
  await expectRoute(page, "rwpxovrz");
  await expect(source).toHaveText("vqkqszmu");
  await page.locator('[data-view="default"]').click();
  await mode.selectOption("custom");
  await page
    .getByRole("button", { name: "Choose destination pqxvqmoo", exact: true })
    .click();
  await page.locator("#review-parent").click();
  await expect(page.locator("#destination-error")).toContainText(
    "reviewed source",
  );
  await expect(target).toHaveText("—");
  await expect(squash).toBeDisabled();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(page.locator(".revision.target")).toHaveCount(0);
  await mode.selectOption("parent");
  await expectRoute(page, "rwpxovrz");
  await expect(squash).toBeEnabled();

  // A previously clicked target may leave the filter; changing it needs a row.
  await page.locator("#scenario").selectOption("hidden");
  await expect(target).toHaveText("nukxtrvy");
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator("#route-handle")).toBeHidden();
  await page.locator("#change-custom").click();
  await page
    .getByRole("button", { name: "Choose destination rwpxovrz", exact: true })
    .click();
  await expectRoute(page, "rwpxovrz");
  await expect(page.locator("#outside")).toBeHidden();

  // Accepted queue work keeps its pinned IDs and locks destination controls.
  await page.locator("#scenario").selectOption("queued");
  await expect(mode).toHaveValue("parent");
  await expectRoute(page, "pqxvqmoo");
  for (const id of [
    "destination-mode",
    "route-handle",
    "squash-demo",
    "move-working-copy",
    "review-parent",
  ])
    await expect(page.locator(`#${id}`)).toBeDisabled();
  await expect(page.locator("#locked")).toContainText("pinned to pqxvqmoo");
  await page.locator("#move-working-copy").dispatchEvent("click");
  await page.locator("#review-parent").dispatchEvent("click");
  await expect(target).toHaveText("pqxvqmoo");
  await expect(source).toHaveText("vqkqszmu");
  await page.locator("#scenario").selectOption("default");
  await squash.click();
  await expect(page.locator("#status")).toContainText("no repository writes");

  for (const name of ["index.html", "interactive-mockups.html"]) {
    await page.goto(
      new URL(`../.planka-artifacts/${name}`, import.meta.url).href,
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(() => document.fonts.check("13px Source")),
      true,
    );
    await expect(mode).toHaveValue("parent");
    await expectClickOnly(page);
    await expectCompactGraph(page);
    await expectRoute(page, "pqxvqmoo");
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "narrow preview must not overflow",
  );
  await expectCompactGraph(page);
  const beforeScroll = await page.locator("#route-handle").boundingBox();
  await page.locator("#log-list").evaluate((log) => {
    log.scrollLeft = 100;
  });
  await expectRoute(page, "pqxvqmoo");
  assert.equal(
    (await page.locator("#route-handle").boundingBox()).x,
    beforeScroll.x,
  );
  await mode.selectOption("custom");
  await page
    .getByRole("button", { name: "Choose destination rwpxovrz", exact: true })
    .click();
  await expectRoute(page, "rwpxovrz");
  await expectClickOnly(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await expectCompactGraph(page);
  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.deepEqual(requests, [], "no HTTP/API requests");
  console.log(
    "PASS: click-only custom choice with no text fields/Apply, no arrow source dot, source-relative default, source/@/filter independence, row/ID/keyboard choice, cancel and mode restore, unavailable targets, fixed custom IDs, pinned queue, compact graph and arrow geometry, mobile and both presentation bundles; zero page errors or HTTP requests.",
  );
} finally {
  await browser.close();
}
