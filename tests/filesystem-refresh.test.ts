import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  FilesystemRefresh,
  parseRepositoryChange,
} from "../src/filesystem-refresh.ts";

const a = "a".repeat(128);
const b = "b".repeat(128);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000 });
  let eligible = true;
  let operation = a;
  const reads: { resolve(value: boolean): void; reject(error: Error): void }[] =
    [];
  const controller = new FilesystemRefresh({
    eligible: () => eligible,
    operation: () => operation,
    refresh: () =>
      new Promise<boolean>((resolve, reject) =>
        reads.push({ resolve, reject }),
      ),
  });
  t.after(() => controller.dispose());
  return {
    controller,
    reads,
    setEligible(value: boolean) {
      eligible = value;
      controller.wake();
    },
    setOperation(value: string) {
      operation = value;
      controller.wake();
    },
    async advance(ms: number) {
      t.mock.timers.tick(ms);
      await tick();
    },
  };
}

test("idle pages never read; filesystem bursts use trailing one-second debounce", async (t) => {
  const { controller, reads, advance } = fixture(t);
  controller.wake();
  await advance(60_000);
  assert.equal(reads.length, 0);
  controller.changed({ workspace: true, heads: null });
  await advance(900);
  controller.changed({ workspace: true, heads: null });
  await advance(999);
  assert.equal(reads.length, 0);
  await advance(1);
  assert.equal(reads.length, 1);
  reads[0].resolve(true);
  await tick();
  await advance(60_000);
  assert.equal(reads.length, 1, "completion must not arm a periodic refresh");
});

test("acknowledged operation heads skip reads, but workspace/unknown/divergent hints do not", async (t) => {
  const { controller, reads, advance, setOperation } = fixture(t);
  controller.changed({ workspace: false, heads: [a] });
  await advance(1_000);
  assert.equal(reads.length, 0);
  for (const change of [
    { workspace: true, heads: [a] },
    { workspace: false, heads: null },
    { workspace: false, heads: [] },
    { workspace: false, heads: [a, b] },
    { workspace: false, heads: [b] },
  ]) {
    const before: number = reads.length;
    controller.changed(change);
    await advance(1_000);
    assert.equal(reads.length, before + 1);
    reads.at(-1)!.resolve(true);
    await tick();
  }
  controller.changed({ workspace: false, heads: [b] });
  setOperation(b); // Squash ACK arrives during the debounce.
  await advance(1_000);
  assert.equal(reads.length, 5);
});

test("events while ineligible remain dirty without timer polling, and wake when safe", async (t) => {
  const { controller, reads, advance, setEligible } = fixture(t);
  setEligible(false);
  controller.changed({ workspace: true, heads: null });
  await advance(60_000);
  assert.equal(reads.length, 0);
  setEligible(true);
  await advance(0);
  assert.equal(reads.length, 1);
  reads[0].resolve(true);
  await tick();
  controller.changed({ workspace: true, heads: null });
  await advance(500);
  setEligible(false);
  await advance(5_000);
  assert.equal(reads.length, 1);
  setEligible(true);
  await advance(0);
  assert.equal(reads.length, 2);
});

test("slow reads serialize events and retain workspace hints through later history events", async (t) => {
  const { controller, reads, advance } = fixture(t);
  controller.changed({ workspace: true, heads: null });
  await advance(1_000);
  controller.changed({ workspace: true, heads: null });
  controller.changed({ workspace: false, heads: [a] });
  await advance(60_000);
  assert.equal(reads.length, 1, "never overlap quiet reads");
  reads[0].resolve(true);
  await tick();
  await advance(0);
  assert.equal(
    reads.length,
    2,
    "a matching operation cannot erase a workspace edit",
  );
  reads[1].resolve(true);
  await tick();
  await advance(60_000);
  assert.equal(reads.length, 2);
});

test("a snapshot's own head event is consumed using the new acknowledged operation", async (t) => {
  const { controller, reads, advance, setOperation } = fixture(t);
  controller.changed({ workspace: true, heads: [a] });
  await advance(1_000);
  controller.changed({ workspace: false, heads: [b] });
  setOperation(b);
  reads[0].resolve(true);
  await tick();
  await advance(60_000);
  assert.equal(reads.length, 1);
});

test("an overtaken read retains its invalidation rather than dropping a saved edit", async (t) => {
  const { controller, reads, advance, setEligible } = fixture(t);
  controller.changed({ workspace: true, heads: null });
  await advance(1_000);
  setEligible(false);
  reads[0].resolve(false);
  await tick();
  await advance(60_000);
  assert.equal(reads.length, 1);
  setEligible(true);
  await advance(0);
  assert.equal(reads.length, 2);
  reads[1].resolve(true);
  await tick();
  await advance(60_000);
  assert.equal(reads.length, 2);
});

test("failed reads never retry on a timer, but newer events still get checked", async (t) => {
  const { controller, reads, advance } = fixture(t);
  controller.changed({ workspace: true, heads: null });
  await advance(1_000);
  reads[0].reject(new Error("temporary failure"));
  await tick();
  controller.wake();
  await advance(60_000);
  assert.equal(reads.length, 1);
  controller.changed({ workspace: true, heads: null });
  await advance(1_000);
  controller.changed({ workspace: true, heads: null });
  reads[1].reject(new Error("another failure"));
  await tick();
  await advance(1_000);
  assert.equal(reads.length, 3);
});

test("disposing cancels debounce and prevents late completions from scheduling more work", async (t) => {
  const { controller, reads, advance } = fixture(t);
  controller.changed({ workspace: true, heads: null });
  await advance(1_000);
  controller.changed({ workspace: true, heads: null });
  controller.dispose();
  reads[0].resolve(false);
  await tick();
  controller.changed({ workspace: true, heads: null });
  await advance(60_000);
  assert.equal(reads.length, 1);
});

test("change messages accept bounded history hints and reject malformed data", () => {
  for (const value of [
    { workspace: true, heads: null },
    { workspace: false, heads: [a] },
    { workspace: false, heads: [] },
  ])
    assert.deepEqual(parseRepositoryChange(JSON.stringify(value)), value);
  for (const value of [
    null,
    {},
    [],
    { workspace: 1, heads: null },
    { workspace: true },
    { workspace: false, heads: "not an array" },
    { workspace: true, heads: [null] },
    { workspace: true, heads: ["../lock"] },
    { workspace: true, heads: Array(65).fill(a) },
  ])
    assert.equal(parseRepositoryChange(JSON.stringify(value)), null);
  assert.equal(parseRepositoryChange("not json"), null);
});
