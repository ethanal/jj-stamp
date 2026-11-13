// Run from the repository root: node design/capture-revision-jump.mjs
import { chromium } from "@playwright/test";
import { resolve } from "node:path";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  await page.goto(`file://${resolve("design/revision-jump-options.html")}`);
  await page.evaluate(() => document.fonts.ready);
  for (const id of ["inline", "dialog"]) {
    await page
      .locator(`#${id}`)
      .screenshot({ path: `design/revision-jump-${id}.png` });
  }
} finally {
  await browser.close();
}
