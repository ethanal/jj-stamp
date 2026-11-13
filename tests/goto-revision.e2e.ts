// Component + actual CodeDiff keyboard regression: npx tsx tests/goto-revision.e2e.ts
import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createBrowserFixture } from "./browser-fixture.ts";

declare global {
  interface Window {
    gotoFixture: {
      setDisabled: (disabled: boolean) => void;
      setVimMode: (vimMode: boolean) => void;
    };
    settleGoto: (result: boolean | string) => void;
  }
}

const fixture = await createBrowserFixture({
  entry: "/tests/goto-revision.fixture.tsx",
});
const { page, url, errors } = fixture;
const trigger = page.getByRole("button", { name: "Go to", exact: true });
const dialog = page.getByRole("dialog", { name: "Go to revision" });
const input = page.getByRole("textbox", { name: "ID or revset" });
const previous = page.locator("#previous");
const surface = page.locator(".code-surface");
const cursor = page.locator("[data-line][data-fold-vim-cursor]");

try {
  await page.goto(url);
  await expect(page.locator("[data-line]").first()).toBeVisible();
  await previous.focus();
  await page.keyboard.press("g");
  await expect(input).toBeFocused();
  await input.fill("  abc123  ");
  await input.press("Enter");
  await expect(page.locator("#requests")).toHaveText('["abc123"]');
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("  abc123  ");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("readonly", "");
  await page.evaluate(() => window.settleGoto(false));
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("  abc123  ");
  await input.press("Enter");
  await page.evaluate(() => window.settleGoto("Unknown revision: abc123"));
  await expect(dialog.getByRole("alert")).toHaveText(
    "Unknown revision: abc123",
  );
  await expect(input).toHaveValue("  abc123  ");
  await input.press("Enter");
  await page.evaluate(() => window.settleGoto(true));
  await expect(dialog).toHaveCount(0);
  await expect(previous).toBeFocused();

  // Button opens the same compact input; Escape restores the trigger.
  await trigger.click();
  await expect(input).toBeFocused();
  await input.fill("  ");
  await input.press("Enter");
  await expect(page.locator("#requests")).toHaveText(
    '["abc123","abc123","abc123"]',
  );
  await input.fill("not-submitted");
  for (const key of ["Control+Enter", "Meta+Enter", "Alt+Enter", "Shift+Enter"])
    await input.press(key);
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page.locator("#requests")).toHaveText(
    '["abc123","abc123","abc123"]',
  );
  await input.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // The toolbar has more controls to the right: never overflow small viewports.
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({ width, height: 700 });
    await trigger.click();
    const bounds = await dialog.boundingBox();
    assert(bounds);
    assert(bounds.x >= 12, `popover left edge at ${width}px`);
    assert(
      bounds.x + bounds.width <= width - 12,
      `popover right edge at ${width}px`,
    );
    await input.press("Escape");
  }

  // Typing, modifiers, composing input, and modal dialogs never invoke g.
  for (const target of [
    page.getByRole("textbox", { name: "Other input" }),
    page.getByLabel("Editable text"),
  ]) {
    await target.focus();
    await page.keyboard.press("g");
    await expect(dialog).toHaveCount(0);
  }
  await previous.focus();
  for (const key of ["Control+g", "Meta+g", "Alt+g", "Shift+g"]) {
    await page.keyboard.press(key);
    await expect(dialog).toHaveCount(0);
  }
  await previous.evaluate((element) => {
    for (const options of [
      { isComposing: true },
      { keyCode: 229 },
      { repeat: true },
    ])
      element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "g",
          bubbles: true,
          cancelable: true,
          ...options,
        }),
      );
  });
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("dialog", { name: "Other modal", includeHidden: true })
    .evaluate((element) => {
      (element as HTMLDialogElement).showModal();
    });
  await page.keyboard.press("g");
  await expect(dialog).toHaveCount(0);
  await page
    .getByRole("dialog", { name: "Other modal" })
    .evaluate((element) => {
      (element as HTMLDialogElement).close();
    });
  await page.evaluate(() => window.gotoFixture.setDisabled(true));
  await expect(trigger).toBeDisabled();
  await previous.focus();
  await page.keyboard.press("g");
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.gotoFixture.setDisabled(false));

  // Actual CodeDiff handles gg whether its bubbling listener precedes ours or
  // not. A lone g opens after the prefix window and restores the code surface.
  await page.evaluate(() => window.gotoFixture.setVimMode(true));
  await expect(surface).toHaveAttribute("aria-description", /Vim mode/);
  await surface.focus();
  await page.keyboard.press("Shift+G");
  await expect(cursor).toHaveAttribute("data-line", "8");
  await page.keyboard.press("g");
  await page.keyboard.press("g");
  await expect(cursor).toHaveAttribute("data-line", "1");
  await page.waitForTimeout(400);
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("g");
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(surface).toBeFocused();
  await page.keyboard.press("g");
  await page.keyboard.press("j");
  await page.waitForTimeout(400);
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("g");
  await previous.click();
  await page.waitForTimeout(400);
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press("g");
  await page.evaluate(() => window.gotoFixture.setDisabled(true));
  await page.waitForTimeout(400);
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.gotoFixture.setDisabled(false));

  // Escape works while parent-disabled; a late result cannot resurrect the form.
  await trigger.click();
  await input.fill("old-request");
  await input.press("Enter");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("readonly", "");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => window.gotoFixture.setDisabled(false));
  await page.evaluate(() => window.settleGoto(false));
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(input).toBeFocused();
  await input.press("Escape");

  // Success opened from the trigger restores it after the parent's pending
  // disabled state is committed away, not while that button is still disabled.
  await trigger.click();
  await input.fill("trigger-success");
  await input.press("Enter");
  await expect(trigger).toBeDisabled();
  await expect(input).toBeFocused();
  await page.evaluate(() => window.settleGoto(true));
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeEnabled();
  await expect(trigger).toBeFocused();
  assert.deepEqual(errors, []);
  console.log("Go to revision component keyboard and async regressions passed");
} finally {
  await fixture.close();
}
