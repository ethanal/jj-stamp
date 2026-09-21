// Run with: npx tsx tests/copy-selection.e2e.ts
import assert from "node:assert/strict";
import express from "express";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";
import { chromium, expect } from "@playwright/test";

const app = express();
const server = createServer(app);
const vite = await createVite({
  server: { middlewareMode: true, hmr: false },
  appType: "custom",
});
app.get("/", async (_req, res) =>
  res.send(
    await vite.transformIndexHtml(
      "/",
      '<html><body style="margin:0"><div id="root"></div><script type="module" src="/tests/code-diff.fixture.tsx"></script></body></html>',
    ),
  ),
);
app.use(vite.middlewares);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1200, height: 700 } });
// Permission is only used by this test to READ results. Application copy must
// use the trusted copy event, never navigator.clipboard.writeText().
await page.context().grantPermissions(["clipboard-read"]);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const line = (n: number, deletion = false) =>
  page
    .locator(
      deletion
        ? `[data-deletions] [data-line="${n}"], [data-line="${n}"][data-line-type="change-deletion"]`
        : `[data-line="${n}"]:not([data-line-type="change-deletion"])`,
    )
    .last();
const copy = async () => {
  await page.keyboard.press("Control+c");
  return page.evaluate(() => navigator.clipboard.readText());
};
const expected = (start: number, end: number) =>
  Array.from({ length: end - start + 1 }, (_, i) => {
    const n = start + i;
    return `${n % 20 === 10 ? "updated" : "unchanged"} fixture line ${n}\n`;
  }).join("");

try {
  for (const style of ["unified", "split"] as const) {
    await page.goto(`http://127.0.0.1:${address.port}`);
    await expect(line(10)).toBeVisible();
    if (style === "split")
      await page.getByText("Layout", { exact: true }).click();
    await page.evaluate(() => {
      navigator.clipboard.writeText = async () => {
        throw new Error("Async clipboard writing is forbidden");
      };
    });
    await line(10).click();
    assert.equal(
      await copy(),
      expected(10, 10),
      `${style}: single selected new line`,
    );

    await line(9).click();
    await line(12).click({ modifiers: ["Shift"] });
    assert.equal(
      await copy(),
      expected(9, 12),
      `${style}: context and additions, no deleted code/gutters`,
    );

    await line(12).click();
    await line(9).click({ modifiers: ["Shift"] });
    assert.equal(await copy(), expected(9, 12), `${style}: reversed span`);

    await line(11).click();
    await line(12).click({ modifiers: ["Shift"] });
    await expect(page.locator("#selection")).toHaveText("{}");
    assert.equal(
      await copy(),
      expected(11, 12),
      `${style}: context-only range`,
    );

    await line(10, true).click();
    if (style === "split") {
      assert.equal(
        await copy(),
        expected(10, 10),
        "split: left selection copies aligned new code",
      );
    } else {
      const result = await page.locator(".code-surface").evaluate((root) => {
        const clipboardData = new DataTransfer();
        const event = new ClipboardEvent("copy", {
          bubbles: true,
          cancelable: true,
          clipboardData,
        });
        root.dispatchEvent(event);
        return {
          cancelled: event.defaultPrevented,
          text: clipboardData.getData("text/plain"),
        };
      });
      assert.deepEqual(
        result,
        { cancelled: false, text: "" },
        "unified: deletion-only range leaves clipboard untouched",
      );
    }

    await line(10).click();
    const selectionBefore = await page.locator("#selection").textContent();
    const box = await line(10).boundingBox();
    assert(box);
    await page.keyboard.down("Alt");
    await page.mouse.move(box.x + 30, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + 170, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
    const nativeText = await page.evaluate(() =>
      window.getSelection()?.toString(),
    );
    assert(
      nativeText && nativeText.length > 2,
      `${style}: real Alt-drag text selection`,
    );
    assert.equal(
      await copy(),
      nativeText,
      `${style}: native partial text wins over line selection`,
    );
    await expect(page.locator("#selection")).toHaveText(selectionBefore!);
    // Choose a different row: clicking the already-selected single row toggles
    // its logical selection off, so there would intentionally be nothing to copy.
    await line(11).click();
    assert.equal(
      await page.evaluate(() => window.getSelection()?.toString() ?? ""),
      "",
      `${style}: line gesture removes native text selection`,
    );
    assert.deepEqual(
      JSON.parse((await page.locator("#range").textContent())!),
      { start: 11, side: "additions", end: 11, endSide: "additions" },
      `${style}: different row establishes a new logical range`,
    );
    assert.equal(
      await copy(),
      expected(11, 11),
      `${style}: new line gesture clears stale native selection`,
    );

    for (const kind of ["textarea", "input", "contenteditable"] as const) {
      await page.locator(".code-surface").evaluate((root, kind) => {
        const field = document.createElement(
          kind === "contenteditable" ? "div" : kind,
        );
        field.id = "copy-field";
        root.append(field);
        if (
          field instanceof HTMLInputElement ||
          field instanceof HTMLTextAreaElement
        ) {
          field.value = "editable text";
          field.focus();
          field.select();
        } else {
          field.contentEditable = "true";
          field.textContent = "editable text";
          field.focus();
          const range = document.createRange();
          range.selectNodeContents(field);
          document.getSelection()?.removeAllRanges();
          document.getSelection()?.addRange(range);
        }
      }, kind);
      assert.equal(
        await copy(),
        "editable text",
        `${style}: ${kind} keeps native copy`,
      );
      await page.locator("#copy-field").evaluate((field) => field.remove());
    }

    await page.locator("[data-expand-up]").first().click();
    await expect(line(20)).toBeVisible();
    await line(10).click();
    await line(20).click({ modifiers: ["Shift"] });
    assert.equal(
      await copy(),
      expected(10, 20),
      `${style}: expanded context from hydrated contents`,
    );
  }
  assert.deepEqual(errors, []);
  console.log(
    "copy-selection browser checks passed (unified/split, native/editable, expanded context)",
  );
} finally {
  await browser.close();
  await vite.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
