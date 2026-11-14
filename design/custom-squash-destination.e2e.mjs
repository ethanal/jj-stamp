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
  const field = page.getByRole("textbox", {
    name: "Destination revset",
    exact: true,
  });
  const target = page.locator("#destination-id");
  const source = page.locator(".revision.current .review-id");
  const squash = page.locator("#squash-demo");
  await expectCompactGraph(page);
  await expectRoute(page, "pqxvqmoo");
  await expect(field).toHaveValue("@-");
  await expect(target).toHaveText("pqxvqmoo");
  await expect(squash).toBeEnabled();
  await expect(page.locator("#reset")).toBeHidden();
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

  // Editing is a blocked, dashed preview until Enter/Apply saves the expression.
  await page
    .getByRole("button", { name: "Edit destination revset", exact: true })
    .click();
  await expect(field).toBeFocused();
  await field.fill("@--");
  await expectRoute(page, "rwpxovrz", true);
  await expect(squash).toBeDisabled();
  await expect(page.locator("#apply-revset")).toBeVisible();
  await field.press("Enter");
  await expectRoute(page, "rwpxovrz");
  await expect(field).toHaveValue("@--");
  await expect(squash).toBeEnabled();
  await expect(page.locator("#apply-revset")).toBeHidden();
  await expect(source).toHaveText("vqkqszmu");
  await expect(page.locator(".line.sel")).toHaveCount(3);
  await expect(page.locator("#selection-target")).toHaveText("rwpxovrz");
  await expect(page.locator("#footer-destination")).toHaveText("rwpxovrz");
  await expectCompactGraph(page);
  await captureLog(page, "revset-01-saved-expression.png");

  // Move @, not the selected review. The same expression must resolve afresh.
  await page.locator("#move-working-copy").click();
  await expect(field).toHaveValue("@--");
  await expect(target).toHaveText("pqxvqmoo");
  await expectRoute(page, "pqxvqmoo");
  await expect(source).toHaveText("vqkqszmu");
  await expect(page.locator(".line.sel")).toHaveCount(3);
  await expect(page.locator('[data-revision="xmturvkn"] .graph')).toHaveText(
    "@  ",
  );
  await expect(page.locator(".revision.current .graph")).toHaveText("○  ");
  await expectCompactGraph(page, 6);
  await captureLog(page, "revset-02-follows-working-copy.png");

  // An unresolved draft never falls back to the old destination, even on Enter.
  await field.fill("all()");
  await expect(page.locator("#revset-error")).toContainText(
    "Resolved to 6 commits",
  );
  await expect(field).toHaveAttribute("aria-invalid", "true");
  await expect(squash).toBeDisabled();
  await expect(page.locator("#apply-revset")).toBeDisabled();
  await expect(target).toHaveText("—");
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(page.locator(".revision.target")).toHaveCount(0);
  await captureLog(page, "revset-03-multiple-matches.png");
  await field.press("Enter");
  await expect(target).toHaveText("—");
  await field.press("Escape");
  await expect(field).toHaveValue("@--");
  await expectRoute(page, "pqxvqmoo");
  for (const [expression, message] of [
    ["none()", "Resolved to 0 commits"],
    ["@—", "Use ASCII hyphens"],
    ["@[", "Not a supported fixture expression"],
    ["", "Enter a revset"],
    ["vqkqszmu", "reviewed source"],
    ["zzzzzzzz", "immutable"],
    ["xmturvkn", "older ancestors"],
  ]) {
    await field.fill(expression);
    await expect(page.locator("#revset-error")).toContainText(message);
    await expect(squash).toBeDisabled();
    await expect(target).toHaveText("—");
    await field.press("Escape");
    await expect(field).toHaveValue("@--");
    await expect(squash).toBeEnabled();
  }

  // A fixed ID stays fixed while @ moves, unlike a saved moving expression.
  await page.locator('[data-view="default"]').click();
  await field.fill("rwpxovrz");
  await page.locator("#apply-revset").click();
  await page.locator("#move-working-copy").click();
  await expect(field).toHaveValue("rwpxovrz");
  await expectRoute(page, "rwpxovrz");
  // Default @- now points at the source: block it, don't invent another target.
  await page.locator('[data-view="default"]').click();
  await page.locator("#move-working-copy").click();
  await expect(field).toHaveValue("@-");
  await expect(page.locator("#revset-error")).toContainText("reviewed source");
  await expect(squash).toBeDisabled();
  await expect(page.locator("#route-handle")).toBeHidden();
  await page.locator("#reset").click();
  await expect(field).toHaveValue("vqkqszmu-");
  await expectRoute(page, "pqxvqmoo");
  await expect(squash).toBeEnabled();

  // Off-filter targets can be expressed without silently changing the graph.
  await field.fill("nukxtrvy");
  await field.press("Enter");
  await expect(target).toHaveText("nukxtrvy");
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(page.locator(".revision.target")).toHaveCount(0);
  await expect(squash).toBeEnabled();
  await page.locator("#reset").click();
  await expectRoute(page, "pqxvqmoo");

  // Queued work locks the editor and pins a resolved ID, not a moving revset.
  await page.locator("#scenario").selectOption("queued");
  await expect(field).toHaveValue("@--");
  await expectRoute(page, "rwpxovrz");
  for (const id of [
    "destination-revset",
    "route-handle",
    "reset",
    "squash-demo",
    "move-working-copy",
  ])
    await expect(page.locator(`#${id}`)).toBeDisabled();
  await expect(page.locator("#locked")).toContainText("pinned to rwpxovrz");
  await page.locator("#move-working-copy").dispatchEvent("click");
  await expect(target).toHaveText("rwpxovrz");
  await expectCompactGraph(page);
  await page.locator("#scenario").selectOption("custom");
  await squash.click();
  await expect(page.locator("#status")).toContainText("no repository writes");

  // Both the file bundle and the exact iframe presentation remain standalone.
  for (const name of ["index.html", "interactive-mockups.html"]) {
    await page.goto(
      new URL(`../.planka-artifacts/${name}`, import.meta.url).href,
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(() => document.fonts.check("13px Source")),
      true,
    );
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
  await expectRoute(page, "pqxvqmoo");
  const beforeScroll = await page.locator("#route-handle").boundingBox();
  await page.locator("#log-list").evaluate((log) => {
    log.scrollLeft = 100;
  });
  await expectRoute(page, "pqxvqmoo");
  const afterScroll = await page.locator("#route-handle").boundingBox();
  assert.equal(
    beforeScroll.x,
    afterScroll.x,
    "arrow stays in fixed margin during horizontal scroll",
  );
  await page.locator("#route-handle").click();
  await expect(field).toBeFocused();
  await field.fill("@--");
  await field.press("Enter");
  await expectRoute(page, "rwpxovrz");
  await page.locator("#move-working-copy").click();
  await expect(field).toHaveValue("@--");
  await expectRoute(page, "pqxvqmoo");
  await expectCompactGraph(page, 6);
  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.deepEqual(requests, [], "no HTTP/API requests");
  console.log(
    "PASS: saved revset and moving @ resolution, fixed-ID contrast, Enter/Apply/Escape, zero/multiple/unsupported/ineligible matches fail closed, queue pinning, off-filter target, source/selection preservation, compact graph and arrow geometry, mobile scrolling, both presentation bundles; zero page errors or HTTP requests.",
  );
} finally {
  await browser.close();
}
