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
async function expectCompactGraph(page) {
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
  assert.equal(geometry.rows.length, 5);
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
  const target = page.locator("#destination-id");
  const source = page.locator(".revision.current .review-id");
  await expectCompactGraph(page);
  await expectRoute(page, "pqxvqmoo");
  await expect(target).toHaveText("pqxvqmoo");
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
  await captureLog(page, "arrow-01-parent-default.png");

  // The arrow itself is the destination picker; selecting never changes source.
  await page
    .getByRole("button", { name: /Change squash destination, currently/ })
    .click();
  await expect(page.locator("#pick-banner")).toBeVisible();
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
  await page.locator('[data-revision="rwpxovrz"] .row-title').hover();
  await expectRoute(page, "rwpxovrz", true);
  await expect(target).toHaveText("pqxvqmoo");
  await expect(page.locator(".revision.target")).toHaveAttribute(
    "data-revision",
    "pqxvqmoo",
  );
  await expectCompactGraph(page);
  await captureLog(page, "arrow-02-choose-destination.png");
  await page.keyboard.press("Escape");
  await expect(target).toHaveText("pqxvqmoo");
  await expectRoute(page, "pqxvqmoo");
  await expect(page.locator("#change")).toBeFocused();
  await page.locator("#change").click();
  await page.locator('[data-revision="rwpxovrz"] .row-title').click();
  await expect(target).toHaveText("rwpxovrz");
  await expect(page.locator("#pick-banner")).toBeHidden();
  await expectRoute(page, "rwpxovrz");
  await expect(source).toHaveText("vqkqszmu");
  await expect(page.locator(".line.sel")).toHaveCount(3);
  await expect(page.locator("#selection-target")).toHaveText("rwpxovrz");
  await expect(page.locator("#footer-destination")).toHaveText("rwpxovrz");
  await expectCompactGraph(page);
  await captureLog(page, "arrow-03-custom-destination.png");
  await page.locator("#reset").click();
  await expectRoute(page, "pqxvqmoo");

  // Keyboard entry and bounded candidate navigation, skipping source/immutable.
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
  await expect(target).toHaveText("ksuunvyp");
  await expectRoute(page, "ksuunvyp");
  await page.locator("#change").click();
  await page.locator("#cancel-pick").click();
  await expect(target).toHaveText("ksuunvyp");

  // Search is available inside pick mode, including off-filter fixture commits.
  await page.locator("#change").click();
  await page.locator("#find").click();
  await expect(page.locator("#search")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Choose vqkqszmu", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Choose zzzzzzzz", exact: true }),
  ).toBeDisabled();
  await page.locator("#search").fill("no matching commit");
  await expect(page.locator(".no-results")).toBeVisible();
  await page.locator("#search").fill("delivery");
  await expect(page.locator(".result")).toHaveCount(3);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(target).toHaveText("nukxtrvy");
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(page.locator(".revision.target")).toHaveCount(0);
  await page.locator("#change").click();
  await page.locator("#find").click();
  await page.locator("h1").click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(target).toHaveText("nukxtrvy");
  await page.locator("#change").click();
  await page.locator("#find").click();
  await page.locator("#close-picker").click();
  await expect(target).toHaveText("nukxtrvy");
  await page.locator("#reset").click();

  // Illustrative queue pins the destination, including the new arrow handle.
  await page.locator("#scenario").selectOption("queued");
  await expect(page.locator("#locked")).toBeVisible();
  for (const id of ["route-handle", "change", "reset", "squash-demo"])
    await expect(page.locator(`#${id}`)).toBeDisabled();
  await expectRoute(page, "rwpxovrz");
  await page.locator("#scenario").selectOption("default");
  await page.locator("#squash-demo").click();
  await expect(page.locator("#status")).toContainText("no repository writes");

  // Each walkthrough state and the same iframe-ready standalone presentation.
  for (const state of ["default", "picking", "custom"]) {
    await page.locator(`[data-view="${state}"]`).click();
    await expectCompactGraph(page);
    await expectRoute(
      page,
      state === "default" ? "pqxvqmoo" : "rwpxovrz",
      state === "picking",
    );
  }
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
    "arrow remains in fixed margin during horizontal scroll",
  );
  await page.locator("#route-handle").click();
  await page.locator('[data-revision="ksuunvyp"] .row-title').click();
  await expect(target).toHaveText("ksuunvyp");
  await expectRoute(page, "ksuunvyp");
  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.deepEqual(requests, [], "no HTTP/API requests");
  console.log(
    "PASS: arrow geometry/default/custom/preview, click-arrow and keyboard destination choice, cancel/reset, unchanged compact graph/source/selection, no role labels/stripe, search, queue lock, off-filter target, mobile scrolling, both presentation bundles; zero page errors or HTTP requests.",
  );
} finally {
  await browser.close();
}
