import assert from "node:assert/strict";
import test from "node:test";
import {
  clampTerminalHeight,
  terminalHeightFromKey,
  terminalPanelMaximum,
  TerminalExitPolicy,
} from "../src/terminal-panel-state.ts";

test("terminal sizing leaves review space and accounts for a mobile log row", () => {
  assert.equal(terminalPanelMaximum(900, 0), 820);
  assert.equal(terminalPanelMaximum(700, 175), 445);
  assert.equal(terminalPanelMaximum(700, 175, 67), 378);
  assert.equal(terminalPanelMaximum(260, 150), 96);
  assert.equal(clampTerminalHeight(240, 180), 180);
  assert.equal(clampTerminalHeight(-10, 600), 96);
  assert.equal(clampTerminalHeight(321.6, 600), 322);
  assert.equal(clampTerminalHeight(900, 600), 600);
});

test("terminal resize keys use the displayed height and honor bounds", () => {
  assert.equal(terminalHeightFromKey(240, 600, "ArrowUp", false), 250);
  assert.equal(terminalHeightFromKey(240, 600, "ArrowDown", true), 200);
  assert.equal(terminalHeightFromKey(240, 600, "Home", false), 96);
  assert.equal(terminalHeightFromKey(240, 600, "End", false), 600);
  assert.equal(terminalHeightFromKey(590, 600, "ArrowUp", true), 600);
  assert.equal(terminalHeightFromKey(100, 600, "ArrowDown", true), 96);
  assert.equal(terminalHeightFromKey(240, 600, "t", false), null);
});

test("rapid unattended exits stop after three respawns", () => {
  const policy = new TerminalExitPolicy();
  for (let i = 0; i < 3; i++) {
    policy.started(i * 200);
    assert.equal(policy.exited(i * 200 + 10), true);
  }
  policy.started(600);
  assert.equal(policy.exited(610), false);
});

test("user input and a stable session reset the quick-exit guard", () => {
  const policy = new TerminalExitPolicy();
  for (let i = 0; i < 10; i++) {
    policy.started(i * 200);
    policy.interacted();
    assert.equal(policy.exited(i * 200 + 10), true);
  }
  policy.started(2000);
  assert.equal(policy.exited(2010), true);
  policy.started(2200);
  assert.equal(policy.exited(2210), true);
  policy.started(2400);
  assert.equal(policy.exited(2410), false);
  policy.started(2600);
  assert.equal(policy.exited(4600), true);
});
