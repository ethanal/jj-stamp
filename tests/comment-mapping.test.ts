import test from "node:test";
import assert from "node:assert/strict";
import { unchangedCodeLines } from "../server/comment-mapping.ts";

const patch = (body: string) =>
  `diff --git a/main.ts b/main.ts\nindex 1111111..2222222 100644\n--- a/main.ts\n+++ b/main.ts\n${body}`;
test("exact code mapping covers CRLF identity, beginning/end insertions and replacement ranges", () => {
  assert.deepEqual(
    [...unchangedCodeLines("main.ts", "a\r\nb\r\n", "a\r\nb\r\n")],
    [
      [1, 1],
      [2, 2],
    ],
  );
  assert.deepEqual(
    [
      ...unchangedCodeLines(
        "main.ts",
        "a\r\nb\r\n",
        "start\r\na\r\nb\r\n",
        patch("@@ -1,2 +1,3 @@\n+start\r\n a\r\n b\r\n"),
      ),
    ],
    [
      [1, 2],
      [2, 3],
    ],
  );
  assert.deepEqual(
    [
      ...unchangedCodeLines(
        "main.ts",
        "a\nb\n",
        "a\nb\nend\n",
        patch("@@ -1,2 +1,3 @@\n a\n b\n+end\n"),
      ),
    ],
    [
      [1, 1],
      [2, 2],
    ],
  );
  const mapped = unchangedCodeLines(
    "main.ts",
    "a\nb\nc\nd\n",
    "a\nB\nextra\nc\nd\n",
    patch("@@ -1,4 +1,5 @@\n a\n-b\n+B\n+extra\n c\n d\n"),
  );
  assert.deepEqual(
    [...mapped],
    [
      [1, 1],
      [3, 4],
      [4, 5],
    ],
  );
  assert.equal(mapped.has(2), false);
  assert.throws(() => unchangedCodeLines("main.ts", "wrong\n", "a\n"));
});
