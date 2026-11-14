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
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1080 },
  });
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.goto(
    new URL("./custom-squash-destination.html", import.meta.url).href,
  );
  await page.evaluate(() => document.fonts.ready);
  for (const line of await page.locator(".line").all()) {
    await expect(line).toHaveCSS("height", "23px");
  }
  await expectCompactGraph(page);
  const target = page.locator("#destination-id");
  const source = page.locator(".revision.current .review-id");
  await expect(target).toHaveText("pqxvqmoo");
  await expect(page.locator(".revision.target")).toHaveAttribute(
    "data-revision",
    "pqxvqmoo",
  );
  await expect(page.locator("#reset")).toBeHidden();
  await expect(source).toHaveText("vqkqszmu");

  // A: explicit row action changes only the destination, not the source/selection.
  await page
    .getByRole("button", { name: "Set destination rwpxovrz", exact: true })
    .click();
  await expect(target).toHaveText("rwpxovrz");
  await expect(page.locator("#destination-kind")).toHaveText("custom");
  await expect(page.locator("#selection-target")).toHaveText("rwpxovrz");
  await expect(source).toHaveText("vqkqszmu");
  await expect(page.locator(".line.sel")).toHaveCount(3);
  await expect(page.locator(".revision.target .role")).toHaveText("[target]");
  await expectCompactGraph(page);
  // Present the selected target and the independent inline action together.
  await page.locator('[data-revision="pqxvqmoo"]').hover();
  await page.screenshot({
    path: ".planka-artifacts/option-a-inline-log-action.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect(target).toHaveText("pqxvqmoo");
  await expect(page.locator("#scenario")).toHaveValue("default");

  // Keyboard focus exposes A's otherwise hover-only row control.
  const older = page.getByRole("button", {
    name: "Set destination ksuunvyp",
    exact: true,
  });
  await older.focus();
  await expect(older).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(target).toHaveText("ksuunvyp");
  await page.getByRole("button", { name: "Reset", exact: true }).click();

  // B: explicit mode, click a row, cancel/Escape without changing the destination.
  await page.locator('[data-concept="mode"]').click();
  await page.locator("#change").click();
  await expect(page.locator("#pick-banner")).toBeVisible();
  await expectCompactGraph(page);
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
  await page.screenshot({
    path: ".planka-artifacts/option-b-choose-in-log.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(target).toHaveText("pqxvqmoo");
  await expect(page.locator("#change")).toBeFocused();
  await page.locator("#change").click();
  await page.locator('[data-revision="ksuunvyp"] .row-title').click();
  await expect(target).toHaveText("ksuunvyp");
  await expect(page.locator("#pick-banner")).toBeHidden();
  await expect(source).toHaveText("vqkqszmu");

  // C: fixture search, unavailable rows, empty results, keyboard selection, external target.
  await page.locator('[data-concept="search"]').click();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expectCompactGraph(page);
  await page.locator("#change").click();
  await expect(page.locator("#search")).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Choose vqkqszmu", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Choose zzzzzzzz", exact: true }),
  ).toBeDisabled();
  await page.locator("#search").fill("no such commit");
  await expect(page.locator(".no-results")).toBeVisible();
  await page.locator("#search").fill("delivery");
  await expect(page.locator(".result")).toHaveCount(3);
  await page.screenshot({
    path: ".planka-artifacts/option-c-search-destination.png",
    fullPage: true,
  });
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "Choose rwpxovrz", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(target).toHaveText("nukxtrvy");
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator(".revision.target")).toHaveCount(0);
  await expect(source).toHaveText("vqkqszmu");
  await page.locator("#change").click();
  await page.locator("#search").fill("types");
  await page.locator("#close-picker").click();
  await expect(target).toHaveText("nukxtrvy");
  await expect(page.locator("#picker")).toBeHidden();
  await expect(page.locator("#change")).toBeFocused();
  await page.locator("#change").click();
  await page.locator("h1").click();
  await expect(page.locator("#picker")).toBeHidden();
  await expect(target).toHaveText("nukxtrvy");

  // All concepts freeze destination while the illustrative queue is active.
  for (const concept of ["row", "mode", "search"]) {
    await page.locator(`[data-concept="${concept}"]`).click();
    await page.locator("#scenario").selectOption("queued");
    await expect(page.locator("#locked")).toBeVisible();
    await expect(page.locator("#change")).toBeDisabled();
    await expect(page.locator("#reset")).toBeDisabled();
    await expect(page.locator("#squash-demo")).toBeDisabled();
    for (const action of await page.locator(".row-action").all())
      await expect(action).toBeDisabled();
    await expect(target).toHaveText("rwpxovrz");
    await page.locator("#scenario").selectOption("default");
  }
  await page.locator("#squash-demo").click();
  await expect(page.locator("#status")).toContainText("no repository writes");

  // Preview bundle is independently usable, with no font/asset failure.
  await page.goto(
    new URL("../.planka-artifacts/index.html", import.meta.url).href,
  );
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() => document.fonts.check("13px Source")),
    true,
  );
  await expect(page.locator("#destination-id")).toHaveText("pqxvqmoo");
  // Exercise the same self-contained document displayed by output_iframe.
  await page.goto(
    new URL("../.planka-artifacts/interactive-mockups.html", import.meta.url)
      .href,
  );
  await page.evaluate(() => document.fonts.ready);
  assert.equal(
    await page.evaluate(() => document.fonts.check("13px Source")),
    true,
  );
  await expectCompactGraph(page);
  await page
    .getByRole("button", { name: "Set destination rwpxovrz", exact: true })
    .click();
  await expect(page.locator("#destination-id")).toHaveText("rwpxovrz");
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
    "narrow preview should not overflow",
  );
  await expectCompactGraph(page);
  assert.equal(
    await page
      .locator("#log-list")
      .evaluate((log) => log.scrollWidth > log.clientWidth),
    true,
    "long monospace lines scroll inside the log instead of wrapping or truncating",
  );
  await page.locator('[data-concept="search"]').click();
  await page.locator("#change").click();
  await expect(page.locator("#search")).toBeVisible();
  await page.locator("#search").fill("types");
  await page
    .getByRole("button", { name: "Choose ksuunvyp", exact: true })
    .click();
  await expect(page.locator("#destination-id")).toHaveText("ksuunvyp");

  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.deepEqual(
    requests,
    [],
    "mockups must not call APIs or external services",
  );
  console.log(
    "PASS: compact monospace/normal-line-height graph across A/B/C and mobile, inline source/target controls, destination choice, selection preservation, reset, keyboard, cancellation, search, unavailable rows, queue lock, external target, standalone bundle; zero page errors or HTTP requests.",
  );
} finally {
  await browser.close();
}
