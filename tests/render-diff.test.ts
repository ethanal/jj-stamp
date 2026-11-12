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

test("jj rename metadata without similarity index retains both renderer paths", () => {
  for (const modified of [true, false]) {
    const file = {
      path: "src/new.ts",
      oldPath: "src/old.ts",
      additions: modified ? 1 : 0,
      deletions: modified ? 1 : 0,
      hunks: modified
        ? [
            {
              id: "rename",
              header: "@@ -1 +1 @@",
              rows: [
                { index: 1, raw: "-old", oldLine: 1 },
                { index: 2, raw: "+new", newLine: 1 },
              ],
            },
          ]
        : [],
      patch: [
        "diff --git a/src/old.ts b/src/new.ts",
        "rename from src/old.ts",
        "rename to src/new.ts",
        ...(modified
          ? [
              "index abc123..def456 100644",
              "--- a/src/old.ts",
              "+++ b/src/new.ts",
              "@@ -1 +1 @@",
              "-old",
              "+new",
            ]
          : []),
        "",
      ].join("\n"),
    };
    const original = structuredClone(file);
    const rendered = parseRenderDiff(file)!;
    assert.equal(rendered.name, file.path);
    assert.equal(rendered.prevName, file.oldPath);
    assert.equal(rendered.type, modified ? "rename-changed" : "rename-pure");
    assert.equal(rendered.deletionLines.join(""), modified ? "old\n" : "");
    assert.equal(rendered.additionLines.join(""), modified ? "new\n" : "");
    assert.deepEqual(file, original);
  }
});
