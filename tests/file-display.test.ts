import assert from "node:assert/strict";
import test from "node:test";
import { unsupportedFileLabel } from "../src/file-display.ts";
import type { DiffFile } from "../src/types";

const file = (patch: string, unsupported = "Unsupported patch"): DiffFile => ({
  path: "asset.png",
  patch,
  unsupported,
  additions: 0,
  deletions: 0,
  hunks: [],
});

test("binary labels use patch metadata, including added and deleted files", () => {
  for (const marker of [
    "Binary files a/asset.png and b/asset.png differ",
    "Binary files /dev/null and b/asset.png differ",
    "Binary files a/asset.png and /dev/null differ",
    "GIT binary patch",
  ]) {
    assert.equal(
      unsupportedFileLabel(
        file(`diff --git a/asset.png b/asset.png\n${marker}\n`),
      ),
      "Binary",
    );
  }
});

test("other unsupported patches are not mislabeled as binary", () => {
  for (const patch of [
    "old mode 100644\nnew mode 100755\n",
    "new file mode 120000\n",
    "@@@ -1 +1 @@@\n",
    "--- a/asset.png\n+++ b/asset.png\n@@ -1 +1 @@\n-Binary files a and b differ\n+GIT binary patch\n",
  ]) {
    assert.equal(unsupportedFileLabel(file(patch)), "Read-only");
  }
});

test("supported files keep ordinary counts, regardless of their name", () => {
  assert.equal(unsupportedFileLabel(file("", "")), undefined);
  assert.equal(
    unsupportedFileLabel({
      ...file("GIT binary patch\n"),
      unsupported: undefined,
    }),
    undefined,
  );
});
