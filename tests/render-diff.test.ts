import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRenderDiff } from "../src/render-diff.ts";
import { newlineCases, newlineFile } from "./newline-cases.ts";

for (const scenario of newlineCases) {
  for (const transportLF of [true, false]) {
    test(`render metadata: ${scenario.name}, transport LF=${transportLF}`, () => {
      const file = newlineFile(scenario, transportLF);
      const original = structuredClone(file);
      const parsed = parseRenderDiff(file, "newline-test")!;
      assert.equal(parsed.additionLines.join(""), scenario.after);
      assert.equal(parsed.deletionLines.join(""), scenario.before);
      assert.equal(
        parsed.hunks[0].noEOFCRAdditions,
        scenario.after !== "" && !scenario.after.endsWith("\n"),
      );
      assert.equal(
        parsed.hunks[0].noEOFCRDeletions,
        scenario.before !== "" && !scenario.before.endsWith("\n"),
      );
      assert.deepEqual(
        file,
        original,
        "canonical rows and patch stay unchanged",
      );
    });
  }
}
