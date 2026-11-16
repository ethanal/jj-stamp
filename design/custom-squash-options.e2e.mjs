// Design fixtures only. Generates five actual browser screenshots and the
// self-contained Shelley presentation; no app/API server or repository writes.
import assert from "node:assert/strict";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

await mkdir(".planka-artifacts", { recursive: true });
const html = await readFile(
  new URL("./custom-squash-options.html", import.meta.url),
  "utf8",
);
const font = await readFile(
  new URL("../src/fonts/SourceCodePro.ttf", import.meta.url),
);
await writeFile(
  ".planka-artifacts/squash-options.html",
  html.replace("../src/fonts/SourceCodePro.ttf", "SourceCodePro.ttf"),
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

const designs = [
  [1, "dropdown"],
  [2, "segments"],
  [3, "summary"],
  [4, "direct"],
  [5, "stacked"],
];
const instance = (page, id, mode = "parent") =>
  page.locator(`[data-instance="option-${id}-${mode}"]`);
const destination = (root) => root.locator(".topbar .destination").first();
const opener = (root, id) =>
  root.locator(`[data-action="${id === 2 ? "pick" : "trigger"}"]`);
async function openPicker(root, id, keyboard = false) {
  const button = opener(root, id);
  if (keyboard) {
    await button.focus();
    await button.press("Enter");
  } else await button.click();
  if (![2, 4].includes(id)) {
    await expect(root.getByRole("menu")).toBeVisible();
    if (keyboard) {
      await root.getByRole("menuitemradio").press("ArrowDown");
      await root
        .getByRole("menuitem", { name: "Choose revision in log…" })
        .press("Enter");
    } else
      await root
        .getByRole("menuitem", { name: "Choose revision in log…" })
        .click();
  }
  await expect(root.locator(".pick-panel")).toBeVisible();
  await expect(
    root.getByRole("button", {
      name: "Choose destination pqxvqmoo",
      exact: true,
    }),
  ).toBeFocused();
}
async function expectCompactGraph(root, target = "pqxvqmoo") {
  const graph = root.locator(".graph");
  await expect(graph).toHaveCSS("line-height", "normal");
  await expect(graph).toHaveCSS("white-space", "pre");
  const geometry = await graph.evaluate((log) => {
    const probe = document.createElement("div");
    probe.textContent = "@  normal";
    probe.style.cssText = "font:inherit;line-height:normal";
    log.append(probe);
    const normal = probe.getBoundingClientRect().height;
    probe.remove();
    return {
      normal,
      rows: [...log.querySelectorAll(".revision")].map((row) => {
        const bounds = row.getBoundingClientRect(),
          prefix = row.querySelector(".prefix"),
          button = row.querySelector("button"),
          title = row.querySelector(".title");
        return {
          top: bounds.top,
          bottom: bounds.bottom,
          height: bounds.height,
          prefix: prefix.textContent,
          prefixWidth: prefix.getBoundingClientRect().width,
          idOffset:
            button.getBoundingClientRect().left -
            prefix.getBoundingClientRect().left,
          titleTop: title.getBoundingClientRect().top,
          idTop: button.getBoundingClientRect().top,
          size: getComputedStyle(button).fontSize,
          lineHeight: getComputedStyle(button).lineHeight,
        };
      }),
    };
  });
  assert.equal(geometry.rows.length, 6);
  for (const [index, row] of geometry.rows.entries()) {
    assert.equal(row.height, geometry.normal, "no tall/padded graph rows");
    assert.equal(row.prefix.length, 3);
    assert.equal(row.idOffset, row.prefixWidth);
    assert.equal(row.titleTop, row.idTop);
    assert.equal(row.size, "13px");
    assert.equal(row.lineHeight, "normal");
    if (index)
      assert.equal(row.top, geometry.rows[index - 1].bottom, "no row gaps");
  }
  await expect(root.locator(".revision.current")).toHaveAttribute(
    "data-revision",
    "vqkqszmu",
  );
  await expect(root.locator(".revision").first().locator(".prefix")).toHaveText(
    "@  ",
  );
  await expect(root.locator(".revision.target")).toHaveAttribute(
    "data-revision",
    target,
  );
  await expect(root.locator("svg circle, svg ellipse, svg marker")).toHaveCount(
    0,
  );
  const route = await root.locator(".route").evaluate((svg, targetId) => {
    const scope = svg.closest(".graph-viewport"),
      source = scope.querySelector(".revision.current").getBoundingClientRect(),
      target = scope
        .querySelector(`[data-revision="${targetId}"]`)
        .getBoundingClientRect(),
      bounds = svg.getBoundingClientRect();
    return {
      start: Math.abs(bounds.top + 6 - source.top - source.height / 2),
      end: Math.abs(bounds.bottom - 6 - target.top - target.height / 2),
      gutter:
        bounds.right <=
        scope.querySelector(".graph").getBoundingClientRect().left,
    };
  }, target);
  assert.ok(
    route.start < 0.1,
    "plain arrow source aligns with reviewed source",
  );
  assert.ok(route.end < 0.1, "arrowhead aligns with destination");
  assert.equal(route.gutter, true);
}
async function expectClosed(root, id) {
  await expect(root.locator(".pick-panel")).toBeHidden();
  await expect(root.locator(".menu")).toHaveCount(0);
  await expect(root.locator(".context")).toHaveText("Log hidden");
  await expect(destination(root)).toHaveText(id);
}
async function resetParent(root, id) {
  if (id === 2) await root.locator('[data-action="parent"]').click();
  else if (id === 4) {
    await opener(root, id).click();
    await root.getByRole("button", { name: "Use parent", exact: true }).click();
  } else {
    await opener(root, id).click();
    await root.getByRole("menuitemradio").click();
  }
  await expectClosed(root, "pqxvqmoo");
}

const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({
    viewport: { width: 1040, height: 1100 },
  });
  const errors = [],
    requests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url())) requests.push(request.url());
  });
  await page.goto(
    new URL("./custom-squash-options.html", import.meta.url).href,
  );
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator(".option")).toHaveCount(5);
  await expect(page.locator(".preview")).toHaveCount(10);
  await expect(
    page.locator("input, textarea, [contenteditable=true]"),
  ).toHaveCount(0);
  for (const [id, kind] of designs) {
    const root = instance(page, id),
      custom = instance(page, id, "custom");
    await expectClosed(root, "pqxvqmoo");
    await expectClosed(custom, "rwpxovrz");
    for (const preview of [root, custom]) {
      await expect(preview.locator(".squash-label")).toHaveText(
        "Squash into →",
      );
      assert.equal(
        (await preview.locator(".topbar").boundingBox()).height,
        44,
        "uses existing toolbar height",
      );
      assert.equal(
        await preview
          .locator(".topbar")
          .evaluate((bar) => bar.scrollWidth <= bar.clientWidth),
        true,
      );
      assert.equal(
        await opener(preview, id).evaluate(
          (button) => button.getBoundingClientRect().height <= 28,
        ),
        true,
      );
      if (id !== 1) {
        assert.equal(
          await destination(preview).evaluate(
            (node) => !!node.closest("button, a, [role=button]"),
          ),
          false,
        );
        await destination(preview).click();
        await expect(preview.locator(".pick-panel")).toBeHidden();
        await expect(preview.locator(".menu")).toHaveCount(0);
      } else
        await expect(opener(preview, id)).toHaveAttribute(
          "aria-haspopup",
          "menu",
        );
    }
    await page.locator(`#option-${id}`).screenshot({
      path: `.planka-artifacts/squash-options-0${id}-${kind}.png`,
    });
  }
  for (const [id] of designs) {
    const root = instance(page, id);
    if (![2, 4].includes(id)) {
      await opener(root, id).click();
      await page.keyboard.press("Escape");
      await expectClosed(root, "pqxvqmoo");
      await expect(opener(root, id)).toBeFocused();
    }
    await openPicker(root, id);
    await expectCompactGraph(root);
    for (const revision of ["xmturvkn", "vqkqszmu", "zzzzzzzz"])
      await expect(
        root.getByRole("button", {
          name: `Choose destination ${revision}`,
          exact: true,
        }),
      ).toBeDisabled();
    await root.locator('[data-revision="zzzzzzzz"] .title').click();
    await expect(root.locator(".pick-panel")).toBeVisible();
    await root.locator('[data-revision="rwpxovrz"] .title').hover();
    await expectCompactGraph(root, "rwpxovrz");
    await expect(destination(root)).toHaveText(
      "pqxvqmoo",
      "hover does not apply the target",
    );
    await root.getByRole("button", { name: "Cancel", exact: true }).click();
    await expectClosed(root, "pqxvqmoo");
    await expect(opener(root, id)).toBeFocused();
    await openPicker(root, id, true);
    await page.keyboard.press("ArrowUp");
    await expectCompactGraph(root);
    await page.keyboard.press("ArrowDown");
    await expectCompactGraph(root, "rwpxovrz");
    await page.keyboard.press("Enter");
    await expectClosed(root, "rwpxovrz");
    await expect(opener(root, id)).toBeFocused();
    // Reopen from Custom, cancel, then choose another ID by clicking the title.
    await opener(root, id).click();
    if (![2, 4].includes(id))
      await root
        .getByRole("menuitem", { name: "Choose revision in log…" })
        .click();
    await page.keyboard.press("Escape");
    await expectClosed(root, "rwpxovrz");
    await opener(root, id).click();
    if (![2, 4].includes(id))
      await root
        .getByRole("menuitem", { name: "Choose revision in log…" })
        .click();
    await root.locator('[data-revision="ksuunvyp"] .title').click();
    await expectClosed(root, "ksuunvyp");
    await resetParent(root, id);
    // The side-by-side custom sample is independent.
    await expectClosed(instance(page, id, "custom"), "rwpxovrz");
  }
  const direct = instance(page, 4);
  await openPicker(direct, 4);
  await expect(direct.locator(".context")).toHaveText(
    "Main log stays hidden · local picker",
  );
  await expect(direct.getByRole("dialog")).toBeVisible();
  await direct
    .locator(".pick-panel")
    .screenshot({ path: ".planka-artifacts/squash-options-04-picker.png" });
  await page.locator("h1").click();
  await expectClosed(direct, "pqxvqmoo");
  for (const name of ["squash-options.html", "interactive-mockups.html"]) {
    await page.goto(
      new URL(`../.planka-artifacts/${name}`, import.meta.url).href,
    );
    await page.evaluate(() => document.fonts.ready);
    assert.equal(
      await page.evaluate(() => document.fonts.check("13px Source")),
      true,
    );
    for (const [id] of designs) {
      const root = instance(page, id);
      await openPicker(root, id);
      await root
        .getByRole("button", {
          name: "Choose destination rwpxovrz",
          exact: true,
        })
        .click();
      await expectClosed(root, "rwpxovrz");
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [id] of designs) {
    const root = instance(page, id);
    await resetParent(root, id);
    await openPicker(root, id);
    await expectCompactGraph(root);
    const svgLeft = (await root.locator(".route").boundingBox()).x;
    await root.locator(".graph").evaluate((log) => {
      log.scrollLeft = 120;
    });
    await expectCompactGraph(root);
    assert.equal(
      (await root.locator(".route").boundingBox()).x,
      svgLeft,
      "scroll does not move the arrow gutter",
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.keyboard.press("Escape");
    await expectClosed(root, "pqxvqmoo");
  }
  assert.deepEqual(errors, [], "zero browser errors");
  assert.deepEqual(requests, [], "no HTTP/API requests");
  console.log(
    "PASS: five distinct interactive options, default/custom comparisons, explicit actions, source-relative parent, click/keyboard selection, cancel/focus restore, fail-closed target eligibility, compact log/arrow geometry, direct popover, mobile and both standalone bundles; zero browser errors or HTTP requests.",
  );
} finally {
  await browser.close();
}
