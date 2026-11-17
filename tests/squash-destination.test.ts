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

test("a descendant remains selectable without an eligible default parent", () => {
  const descendant = revision("descendant");
  const forward = { ...state, parent: null, targets: [descendant] };
  assert.equal(squashDestination(forward, null).target, null);
  assert.match(
    squashDestination(forward, null).parentReason,
    /no single eligible mutable parent/,
  );
  const result = squashDestination(forward, {
    sourceId: state.source.changeId,
    mode: "custom",
    custom: descendant,
  });
  assert.equal(result.target, descendant);
  assert.equal(result.error, "");
  const rewritten = revision(descendant.changeId, "rewritten-descendant");
  assert.equal(
    squashDestination(
      { ...forward, targets: [rewritten] },
      { sourceId: state.source.changeId, mode: "custom", custom: descendant },
    ).target,
    rewritten,
  );
});

test("a missing custom destination is retained for explanation, never replaced", () => {
  const result = squashDestination({ ...state, targets: [parent] }, choice);
  assert.equal(result.mode, "custom");
  assert.equal(result.target, null);
  assert.equal(result.custom, older);
  assert.match(result.error, /no longer.*destination/);
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

test("a merge has no default destination even with eligible direct parents", () => {
  const merge = { ...state, parent: null };
  const result = squashDestination(merge, null);
  assert.equal(result.mode, "parent");
  assert.equal(result.target, null);
  assert.equal(
    result.parentReason,
    "Choose a destination in the log; this revision has no single eligible mutable parent.",
  );
  assert.equal(result.error, result.parentReason);
  for (const target of merge.targets) {
    const selected = squashDestination(merge, {
      sourceId: merge.source.changeId,
      mode: "custom",
      custom: target,
    });
    assert.equal(selected.target, target);
    assert.equal(selected.error, "");
  }
});

test("missing defaults retain global safety errors and unavailable wording", () => {
  const unavailable = squashDestination(
    {
      ...state,
      parent: null,
      squashUnavailable: "The reviewed revision contains conflicts.",
    },
    null,
  );
  assert.equal(
    unavailable.parentReason,
    "The reviewed revision contains conflicts.",
  );
  assert.equal(
    squashDestination({ ...state, parent: null, targets: [] }, null)
      .parentReason,
    "No mutable immediate parent is available.",
  );
});
