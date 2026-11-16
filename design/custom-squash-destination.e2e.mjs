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
async function captureWorkspace(page, filename) {
  await page.locator(".app").screenshot({
    path: `.planka-artifacts/${filename}`,
  });
}
async function expectTopBar(page, collapsed = false) {
  const trigger = page.locator("#destination-toggle");
  await expect(page.locator("#destination-label")).toHaveText("Squash into →");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
  await expect(trigger).toHaveAccessibleName(/Squash into/);
  await expect(trigger.locator("#destination-mode")).toBeVisible();
  await expect(trigger.locator("#destination-id")).toBeVisible();
  await expect(trigger.locator("#destination-id")).toHaveJSProperty(
    "tagName",
    "OUTPUT",
  );
  await expect(
    page.locator("#destination-control > #destination-label"),
  ).toHaveCount(1);
  await expect(
    page.locator("select#destination-mode, #change-custom"),
  ).toHaveCount(0);
  await expect(
    page.locator(".log .destination-control, .destination-bar"),
  ).toHaveCount(0);
  await expect(page.locator(".log")).toBeVisible({ visible: !collapsed });
  await expect(page.locator("#log-rail")).toBeVisible({ visible: collapsed });
  const geometry = await page.locator(".app-header").evaluate((header) => {
    const bounds = header.getBoundingClientRect();
    const control = document
      .querySelector("#destination-control")
      .getBoundingClientRect();
    return {
      headerHeight: bounds.height,
      controlHeight: control.height,
      controlWidth: control.width,
      fits:
        control.left >= bounds.left &&
        control.right <= bounds.right &&
        control.top >= bounds.top &&
        control.bottom <= bounds.bottom,
      overflow: header.scrollWidth > header.clientWidth,
    };
  });
  assert.equal(geometry.controlHeight, 26, "one compact combined control");
  assert.ok(
    geometry.controlWidth <= 295,
    "destination control is at most 295px wide",
  );
  assert.equal(geometry.fits, true, "destination stays inside the top bar");
  assert.equal(geometry.overflow, false, "top bar must not overflow");
  if (page.viewportSize().width > 800)
    assert.equal(geometry.headerHeight, 44, "no extra desktop toolbar row");
  else assert.ok(geometry.headerHeight <= 80, "narrow header wraps compactly");
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
async function expectClosedMenu(page) {
  await expect(page.locator("#destination-menu")).toBeHidden();
  await expect(page.locator("#destination-toggle")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
}
async function openMenu(page) {
  const trigger = page.locator("#destination-toggle");
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#destination-menu")).toBeVisible();
  await expect(page.locator("#destination-menu")).toHaveAttribute(
    "role",
    "menu",
  );
  await expect(page.locator("#choose-parent")).toHaveAttribute(
    "role",
    "menuitemradio",
  );
  await expect(page.locator("#use-custom")).toHaveAttribute(
    "role",
    "menuitemradio",
  );
  await expect(page.locator("#choose-custom")).toHaveAttribute(
    "role",
    "menuitem",
  );
  await expect(page.locator("#choose-custom")).toContainText(
    "Choose revision in log…",
  );
  assert.equal(
    await page
      .locator("#destination-menu")
      .evaluate((menu) => getComputedStyle(menu).position),
    "fixed",
    "popup is not clipped by workspace/header overflow",
  );
}
async function menuChoice(page, id) {
  await openMenu(page);
  await page.locator(`#${id}`).click();
  await expectClosedMenu(page);
}
async function startPicking(page) {
  await menuChoice(page, "choose-custom");
  await expect(page.locator("#destination-mode")).toHaveText("Choosing…");
  await expect(page.locator("#pick-help")).toBeVisible();
  await expect(page.locator("#cancel-custom")).toBeVisible();
  await expect(page.locator("#selection-state")).toHaveText(
    "Preview destination",
  );
  await expect(page.locator("#squash-demo")).toBeDisabled();
  await expect(page.locator("#destination-toggle")).toBeEnabled();
}
async function expectCommitted(page, mode, id, collapsed = false) {
  await expectTopBar(page, collapsed);
  await expect(page.locator("#destination-mode")).toHaveText(mode);
  await expect(page.locator("#destination-id")).toHaveText(id);
  await expect(page.locator("#selection-target")).toHaveText(id);
  await expect(page.locator("#footer-destination")).toHaveText(id);
  await expect(page.locator("#selection-state")).toHaveText("3 lines selected");
  await expect(page.locator("#pick-help")).toBeHidden();
  await expect(page.locator(".line.sel")).toHaveCount(3);
  await expectClosedMenu(page);
}
async function expectMenuFits(page) {
  const geometry = await page.locator("#destination-menu").evaluate((menu) => {
    const b = menu.getBoundingClientRect();
    return {
      left: b.left,
      right: b.right,
      top: b.top,
      bottom: b.bottom,
      width: innerWidth,
      height: innerHeight,
      overflowY: getComputedStyle(menu).overflowY,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
    };
  });
  assert.ok(
    geometry.left >= 0 && geometry.right <= geometry.width,
    "fixed menu fits viewport horizontally",
  );
  assert.ok(
    geometry.top >= 0 && geometry.bottom <= geometry.height,
    "menu flips or scrolls to stay inside viewport vertically",
  );
  if (geometry.scrollHeight > geometry.clientHeight)
    assert.ok(
      ["auto", "scroll"].includes(geometry.overflowY),
      "clipped menu must scroll",
    );
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
  const trigger = page.locator("#destination-toggle"),
    mode = page.locator("#destination-mode"),
    target = page.locator("#destination-id"),
    source = page.locator(".revision.current .review-id"),
    squash = page.locator("#squash-demo");
  const reset = async (scenario = "default") => {
    await page.locator("#scenario").selectOption(scenario);
    await expectClosedMenu(page);
  };
  const row = (id) => page.locator(`[data-revision="${id}"] .row-title`);
  const chooseRow = (id) =>
    page
      .getByRole("button", {
        name: `Choose destination ${id}`,
        exact: true,
      })
      .click();

  // A single clearly labelled action combines mode, read-only output and menu.
  await expectClickOnly(page);
  await expectCommitted(page, "Parent", "pqxvqmoo");
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
  await openMenu(page);
  await expect(page.locator("#choose-parent")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("#parent-destination")).toHaveText("pqxvqmoo");
  await expect(page.locator("#use-custom")).toBeHidden();
  for (const [id, primary] of [
    ["choose-parent", "Parent"],
    ["choose-custom", "Choose revision in log…"],
  ]) {
    const text = (await page.locator(`#${id}`).innerText())
      .replace(/\s+/g, " ")
      .trim();
    assert.ok(
      text.replace("pqxvqmoo", "").trim().length > primary.length,
      `${id} explains the choice beyond its title and revision ID`,
    );
  }
  await expectMenuFits(page);
  await trigger.click();
  await expectClosedMenu(page);
  // The nested output is part of this labelled trigger, not a second action.
  await target.click();
  await expect(page.locator("#destination-menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expectClosedMenu(page);
  await expect(trigger).toBeFocused();

  // Menu keyboard navigation and dismissals do not start picking or squash.
  await trigger.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Home");
  await expect(page.locator("#choose-parent")).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#choose-custom")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#choose-parent")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("#choose-custom")).toBeFocused();
  await page.keyboard.press("Tab");
  await expectClosedMenu(page);
  await expectCommitted(page, "Parent", "pqxvqmoo");
  await openMenu(page);
  await page.locator(".app-header .app-title").click();
  await expectClosedMenu(page);
  await expectCommitted(page, "Parent", "pqxvqmoo");

  // Default uses the reviewed source's real parent, never @ or visible adjacency.
  await page.locator("#move-working-copy").click();
  await expect(source).toHaveText("vqkqszmu");
  await expectRoute(page, "pqxvqmoo");
  await expectCompactGraph(page, 6);
  await reset();
  await page.locator("#review-parent").click();
  await expect(source).toHaveText("pqxvqmoo");
  await expect(page.locator(".app-header .blue")).toHaveText("pqxvqmoo");
  await expect(page.locator('[data-revision="vqkqszmu"] .graph')).toHaveText(
    "@  ",
  );
  await expectRoute(page, "rwpxovrz");
  await expectCompactGraph(page);
  await captureWorkspace(page, "design-a-01-default.png");
  await page.locator("#hide-log").click();
  await expectCommitted(page, "Parent", "rwpxovrz", true);
  await openMenu(page);
  await expect(page.locator("#parent-destination")).toHaveText("rwpxovrz");
  await captureWorkspace(page, "design-a-02-menu.png");
  await menuChoice(page, "choose-custom");
  await row("ksuunvyp").hover();
  await expectRoute(page, "ksuunvyp", true);
  await expect(mode).toHaveText("Choosing…");
  await expect(target).toHaveText("ksuunvyp");
  await expect(page.locator("#selection-state")).toHaveText(
    "Preview destination",
  );
  await expect(squash).toBeDisabled();
  await expectCompactGraph(page);
  await captureWorkspace(page, "design-a-03-picking.png");
  await row("ksuunvyp").click();
  await expectCommitted(page, "Custom", "ksuunvyp", true);
  await expect(trigger).toBeFocused();
  await expect(source).toHaveText("pqxvqmoo");
  await captureWorkspace(page, "design-a-04-custom.png");
  await page
    .locator("#destination-control")
    .screenshot({ path: ".planka-artifacts/design-a-control.png" });

  await reset("filtered");
  await expect(mode).toHaveText("Parent");
  await expect(target).toHaveText("pqxvqmoo");
  await expect(page.locator('[data-revision="pqxvqmoo"]')).toHaveCount(0);
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(squash).toBeEnabled();
  await expectCompactGraph(page, 4);
  await openMenu(page);
  await expect(page.locator("#parent-destination")).toHaveText("pqxvqmoo");
  await page.keyboard.press("Escape");

  // Picker is click-only, previews in the same trigger, and skips invalid rows.
  await reset();
  await openMenu(page);
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectClosedMenu(page);
  await expect(mode).toHaveText("Choosing…");
  await expect(page.locator("#selection-state")).toHaveText(
    "Preview destination",
  );
  await expectClickOnly(page);
  for (const id of ["vqkqszmu", "zzzzzzzz"])
    await expect(
      page.getByRole("button", {
        name: `Choose destination ${id}`,
        exact: true,
      }),
    ).toBeDisabled();
  await row("zzzzzzzz").click();
  await expect(mode).toHaveText("Choosing…");
  await expect(squash).toBeDisabled();
  await row("rwpxovrz").hover();
  await expectRoute(page, "rwpxovrz", true);
  await expect(target).toHaveText("rwpxovrz");
  await expect(page.locator("#footer-destination")).toHaveText("rwpxovrz");
  await page.keyboard.press("Escape");
  await expectCommitted(page, "Parent", "pqxvqmoo");
  await expect(trigger).toBeFocused();
  await expectRoute(page, "pqxvqmoo");
  await startPicking(page);
  await row("rwpxovrz").click();
  await expectCommitted(page, "Custom", "rwpxovrz");
  await expect(trigger).toBeFocused();
  await expectRoute(page, "rwpxovrz");
  await expect(squash).toBeEnabled();
  await expect(source).toHaveText("vqkqszmu");

  // Remembered custom is a fixed ID, not a shortcut that restarts the picker.
  await openMenu(page);
  await expect(page.locator("#choose-parent")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page.locator("#use-custom")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("#use-custom")).toBeEnabled();
  await expect(page.locator("#custom-destination")).toHaveText("rwpxovrz");
  await menuChoice(page, "choose-parent");
  await expectCommitted(page, "Parent", "pqxvqmoo");
  await expect(trigger).toBeFocused();
  await openMenu(page);
  await expect(page.locator("#choose-parent")).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.locator("#use-custom")).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#use-custom")).toBeFocused();
  await page.keyboard.press("Enter");
  await expectCommitted(page, "Custom", "rwpxovrz");
  await expect(trigger).toBeFocused();
  await expectRoute(page, "rwpxovrz");
  await page.locator("#move-working-copy").click();
  await expectRoute(page, "rwpxovrz");
  await expect(source).toHaveText("vqkqszmu");

  // The arrow remains a direct picker affordance; keyboard rows retain graph metrics.
  await reset();
  await page.locator("#route-handle").focus();
  await page.keyboard.press("Enter");
  await expect(mode).toHaveText("Choosing…");
  await page.keyboard.press("ArrowUp");
  await expectRoute(page, "pqxvqmoo", true);
  await page.keyboard.press("ArrowDown");
  await expectRoute(page, "rwpxovrz", true);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expectRoute(page, "ksuunvyp", true);
  await expectCompactGraph(page);
  await page.keyboard.press("Enter");
  await expectCommitted(page, "Custom", "ksuunvyp");
  await expect(trigger).toBeFocused();
  await expectRoute(page, "ksuunvyp");

  // Hidden-log picks temporarily open it. Menu access never loses the transaction.
  await reset();
  const openDiffWidth = (await page.locator(".diff").boundingBox()).width;
  const openControl = await page.locator("#destination-control").boundingBox();
  await page.locator("#hide-log").click();
  await expectCommitted(page, "Parent", "pqxvqmoo", true);
  await expect(page.locator("#show-log")).toBeFocused();
  assert.equal(
    (await page.locator("#destination-control").boundingBox()).x,
    openControl.x,
    "hiding log does not move the destination control",
  );
  assert.ok(
    (await page.locator(".diff").boundingBox()).width > openDiffWidth + 400,
    "diff reclaims hidden log space",
  );
  await openMenu(page);
  await expectTopBar(page, true);
  await expect(squash).toBeEnabled();
  await menuChoice(page, "choose-custom");
  await expectTopBar(page);
  await row("rwpxovrz").hover();
  await expectRoute(page, "rwpxovrz", true);
  await openMenu(page);
  await page.keyboard.press("Tab");
  await expectClosedMenu(page);
  await expect(page.locator("#pick-help")).toBeVisible();
  await expect(mode).toHaveText("Choosing…");
  await expectRoute(page, "rwpxovrz", true);
  await openMenu(page);
  await page.locator(".app-header .app-title").click();
  await expectClosedMenu(page);
  await expect(page.locator("#pick-help")).toBeVisible();
  await expect(mode).toHaveText("Choosing…");
  await expectRoute(page, "rwpxovrz", true);
  await openMenu(page);
  await expect(mode).toHaveText("Choosing…");
  await expect(target).toHaveText("rwpxovrz");
  await page.keyboard.press("Escape");
  await expectClosedMenu(page);
  await expect(trigger).toBeFocused();
  await expectTopBar(page);
  await expect(page.locator("#pick-help")).toBeVisible();
  await expect(mode).toHaveText("Choosing…");
  await page.keyboard.press("Escape");
  await expectCommitted(page, "Parent", "pqxvqmoo", true);
  await expect(trigger).toBeFocused();
  await startPicking(page);
  await row("rwpxovrz").hover();
  await openMenu(page);
  await menuChoice(page, "choose-custom"); // Resume, don't replace restoreCollapsed.
  await expectRoute(page, "rwpxovrz", true);
  await chooseRow("rwpxovrz");
  await expectCommitted(page, "Custom", "rwpxovrz", true);
  await expect(trigger).toBeFocused();
  await startPicking(page);
  await row("ksuunvyp").hover();
  await page.locator("#cancel-custom").click();
  await expectCommitted(page, "Custom", "rwpxovrz", true);
  await expect(trigger).toBeFocused();
  await startPicking(page);
  await row("ksuunvyp").hover();
  await menuChoice(page, "use-custom");
  await expectCommitted(page, "Custom", "rwpxovrz", true);
  await expect(trigger).toBeFocused();
  await startPicking(page);
  await row("ksuunvyp").hover();
  await menuChoice(page, "choose-parent");
  await expectCommitted(page, "Parent", "pqxvqmoo", true);
  await expect(trigger).toBeFocused();

  // An explicitly open log stays open on confirm, cancel and mode selection.
  await page.locator("#show-log").click();
  await startPicking(page);
  await chooseRow("pqxvqmoo");
  await expectCommitted(page, "Custom", "pqxvqmoo");
  await startPicking(page);
  await page.locator("#cancel-custom").click();
  await expectCommitted(page, "Custom", "pqxvqmoo");
  await startPicking(page);
  await menuChoice(page, "choose-parent");
  await expectCommitted(page, "Parent", "pqxvqmoo");
  // Hiding the log during picking cancels; subsequent errors stay above the diff.
  await startPicking(page);
  await chooseRow("pqxvqmoo");
  await startPicking(page);
  await row("rwpxovrz").hover();
  await page.locator("#hide-log").click();
  await expectCommitted(page, "Custom", "pqxvqmoo", true);
  await expect(squash).toBeEnabled();
  await page.locator("#review-parent").click();
  await expectTopBar(page, true);
  await expect(mode).toHaveText("Custom");
  await expect(page.locator("#destination-error")).toContainText(
    "reviewed source",
  );
  await expect(target).toHaveText("—");
  await expect(squash).toBeDisabled();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(page.locator(".revision.target")).toHaveCount(0);
  await openMenu(page);
  await expect(page.locator("#custom-destination")).toHaveText("pqxvqmoo");
  await expect(page.locator("#use-custom")).toBeDisabled();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#choose-custom")).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(page.locator("#choose-parent")).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.locator("#choose-custom")).toBeFocused();
  await page.keyboard.press("Enter");
  await page.locator("#cancel-custom").click();
  await expectTopBar(page, true);
  await expect(target).toHaveText("—");
  await expect(page.locator("#destination-error")).toBeVisible();
  await menuChoice(page, "choose-parent");
  await expectCommitted(page, "Parent", "rwpxovrz", true);
  await expect(page.locator("#destination-error")).toBeHidden();
  await expect(squash).toBeEnabled();
  await reset("invalid");
  await startPicking(page);
  await chooseRow("ksuunvyp");
  await expectCommitted(page, "Custom", "ksuunvyp");
  await expectRoute(page, "ksuunvyp");
  await expect(page.locator("#destination-error")).toBeHidden();

  // Source navigation can invalidate a pending row; a later valid hover clears
  // all result-derived diagnostics without committing or rebuilding the graph.
  await reset();
  await page.mouse.move(2, 2);
  await trigger.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await page.locator("#review-parent").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#destination-error")).toBeVisible();
  await expect(page.locator("#destination-control")).toHaveAttribute(
    "data-invalid",
    "true",
  );
  await row("rwpxovrz").hover();
  await expect(page.locator("#destination-error")).toBeHidden();
  await expect(page.locator("#destination-control")).toHaveAttribute(
    "data-invalid",
    "false",
  );
  await expect(page.locator("#log-tip")).toContainText("Preview only");
  await expectRoute(page, "rwpxovrz", true);
  await expect(squash).toBeDisabled();
  await page.locator("#cancel-custom").click();
  await expectCommitted(page, "Parent", "rwpxovrz");

  // Off-filter custom IDs remain fixed, with a notice and no invented arrow.
  await reset("hidden");
  await expectCommitted(page, "Custom", "nukxtrvy");
  await expect(page.locator("#outside")).toBeVisible();
  await expect(page.locator("#route-handle")).toBeHidden();
  await expect(squash).toBeEnabled();
  await menuChoice(page, "choose-parent");
  await menuChoice(page, "use-custom");
  await expectCommitted(page, "Custom", "nukxtrvy");
  await expect(page.locator("#route-handle")).toBeHidden();
  await page.mouse.move(2, 2);
  await trigger.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Enter");
  await expect(page.locator("#outside")).toBeVisible();
  await row("rwpxovrz").hover();
  await expect(page.locator("#outside")).toBeHidden();
  await expectRoute(page, "rwpxovrz", true);
  await page.locator("#cancel-custom").click();
  await expectCommitted(page, "Custom", "nukxtrvy");
  await expect(page.locator("#outside")).toBeVisible();
  await startPicking(page);
  await chooseRow("rwpxovrz");
  await expectRoute(page, "rwpxovrz");
  await expect(page.locator("#outside")).toBeHidden();

  // Queued work pins source/destination, but hiding/showing the log is safe.
  await reset("queued");
  await expectCommitted(page, "Parent", "pqxvqmoo");
  await expectRoute(page, "pqxvqmoo");
  for (const id of [
    "destination-toggle",
    "route-handle",
    "squash-demo",
    "move-working-copy",
    "review-parent",
  ])
    await expect(page.locator(`#${id}`)).toBeDisabled();
  await expect(page.locator("#locked")).toContainText("pinned to pqxvqmoo");
  for (const id of [
    "destination-toggle",
    "route-handle",
    "move-working-copy",
    "review-parent",
  ])
    await page.locator(`#${id}`).dispatchEvent("click");
  await expectClosedMenu(page);
  await expect(target).toHaveText("pqxvqmoo");
  await expect(source).toHaveText("vqkqszmu");
  await page.locator("#hide-log").click();
  await expectTopBar(page, true);
  await expect(page.locator("#locked")).toBeVisible();
  await expect(page.locator("#show-log")).toBeEnabled();
  await page.locator("#show-log").click();
  await expectTopBar(page);
  await expectRoute(page, "pqxvqmoo");
  await reset();
  await squash.click();
  await expect(page.locator("#status")).toContainText("no repository writes");

  // Both deliverables work offline with the same font, dropdown and layout restore.
  for (const name of ["index.html", "interactive-mockups.html"]) {
    await page.goto(
      new URL(`../.planka-artifacts/${name}`, import.meta.url).href,
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(() => document.fonts.check("13px Source")),
      true,
    );
    await expectCommitted(page, "Parent", "pqxvqmoo");
    await expectClickOnly(page);
    await expectCompactGraph(page);
    await expectRoute(page, "pqxvqmoo");
    await page.locator("#hide-log").click();
    await openMenu(page);
    await expectTopBar(page, true);
    await expectMenuFits(page);
    await menuChoice(page, "choose-custom");
    await chooseRow("rwpxovrz");
    await expectCommitted(page, "Custom", "rwpxovrz", true);
    await menuChoice(page, "choose-parent");
    await menuChoice(page, "use-custom");
    await expectCommitted(page, "Custom", "rwpxovrz", true);
    await expect(trigger).toBeFocused();
    await reset();
  }

  for (const width of [390, 360]) {
    await page.setViewportSize({ width, height: 844 });
    await reset();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `${width}px page has no horizontal overflow`,
    );
    await expectTopBar(page);
    await expectCompactGraph(page);
    const beforeScroll = await page.locator("#route-handle").boundingBox();
    await page.locator("#log-list").evaluate((log) => {
      log.scrollLeft = 100;
    });
    await expectRoute(page, "pqxvqmoo");
    assert.equal(
      (await page.locator("#route-handle").boundingBox()).x,
      beforeScroll.x,
      "horizontal graph scroll never shifts the route gutter",
    );
    await openMenu(page);
    await expectMenuFits(page);
    await page.keyboard.press("Escape");
    await startPicking(page);
    await chooseRow("rwpxovrz");
    await expectCommitted(page, "Custom", "rwpxovrz");
    await expectRoute(page, "rwpxovrz");
    await expectCompactGraph(page);
    await expectClickOnly(page);
    await page.locator("#hide-log").click();
    await openMenu(page);
    await expectMenuFits(page);
    await page.keyboard.press("Escape");
    await startPicking(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expectCommitted(page, "Custom", "ksuunvyp", true);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );

    // Put the actual trigger near the viewport bottom: exercise placement without
    // changing app state or substituting a synthetic popup/geometry calculation.
    await page.locator("#destination-control").evaluate((control) => {
      control.style.position = "fixed";
      control.style.left = "8px";
      control.style.top = `${innerHeight - 34}px`;
      control.style.zIndex = "50";
    });
    await openMenu(page);
    await expectMenuFits(page);
    const popup = await page.locator("#destination-menu").boundingBox();
    const button = await trigger.boundingBox();
    assert.ok(
      popup.y + popup.height <= button.y + button.height,
      "near-bottom menu flips above the combined trigger",
    );
    await page.locator("#destination-control").evaluate((control) => {
      control.style.top = "-50px";
      window.dispatchEvent(new Event("scroll"));
    });
    await expectClosedMenu(page);
    await expect(mode).toHaveText("Custom");
    await expect(target).toHaveText("ksuunvyp");
    await page
      .locator("#destination-control")
      .evaluate((control) => control.removeAttribute("style"));
    await expectTopBar(page, true);
  }
  assert.deepEqual(errors, [], "no uncaught browser errors");
  assert.deepEqual(requests, [], "no HTTP/API requests");
  console.log(
    "PASS: A combined destination dropdown; accessible radio menu, keyboard/dismissal/memory, preview/commit/cancel/focus, source-relative parent and fixed custom, hidden-log layout restore, no-fallback errors/off-filter/queue locks, compact graph/route/header, 360px/390px viewport-fit and bottom-flip menus, both offline bundles; zero page errors or HTTP requests.",
  );
} finally {
  await browser.close();
}
