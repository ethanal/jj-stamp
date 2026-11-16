import assert from "node:assert/strict";
import test from "node:test";
import {
  squashDestination,
  type DestinationChoice,
} from "../src/squash-destination.ts";
import type { RepoState, Revision } from "../src/types.ts";

const revision = (changeId: string, commitId = changeId): Revision => ({
  changeId,
  commitId,
  description: changeId,
});
const parent = revision("parent");
const older = revision("older");
const state: RepoState = {
  repo: { name: "test", path: "/test" },
  source: revision("source"),
  parent,
  targets: [parent, older],
  version: "version",
  operation: "operation",
  files: [],
  canUndo: false,
};
const choice: DestinationChoice = {
  sourceId: "source",
  mode: "custom",
  custom: older,
};

test("Parent is the actual reviewed source parent, independent of target ordering", () => {
  const result = squashDestination(
    { ...state, targets: [older, parent] },
    null,
  );
  assert.equal(result.mode, "parent");
  assert.equal(result.target, parent);
  assert.equal(result.error, "");
});

test("custom destination follows its full change ID across rewrites", () => {
  const rewritten = revision("older", "rewritten-tree");
  const result = squashDestination(
    { ...state, targets: [parent, rewritten] },
    choice,
  );
  assert.equal(result.mode, "custom");
  assert.equal(result.target, rewritten);
  assert.equal(result.custom, rewritten);
});

test("a missing custom destination is retained for explanation, never replaced", () => {
  const result = squashDestination({ ...state, targets: [parent] }, choice);
  assert.equal(result.mode, "custom");
  assert.equal(result.target, null);
  assert.equal(result.custom, older);
  assert.match(result.error, /no longer.*ancestor/);
});

test("Parent discards Custom; another source starts at Parent", () => {
  const result = squashDestination(state, { ...choice, mode: "parent" });
  assert.equal(result.target, parent);
  assert.equal(result.custom, null);
  const nextParent = revision("next-parent");
  const next = squashDestination(
    { ...state, source: revision("other-source"), parent: nextParent },
    choice,
  );
  assert.equal(next.target, nextParent);
  assert.equal(next.mode, "parent");
  assert.equal(next.custom, null);
});

test("source eligibility blocks custom destinations too", () => {
  const result = squashDestination(
    { ...state, squashUnavailable: "The reviewed revision is immutable." },
    choice,
  );
  assert.equal(result.target, null);
  assert.match(result.error, /immutable/);
});
