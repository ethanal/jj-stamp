import assert from "node:assert/strict";
import test from "node:test";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import { parseFile } from "../server/diff.ts";
import {
  inferHunkContext,
  inferVisibleHunkContext,
} from "../src/hunk-context.ts";
import type { Hunk } from "../src/types.ts";

function hunk(body: string, path = "example.ts"): Hunk {
  const parsed = parseFile(
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}\n`,
    path,
  ).hunks[0];
  return { ...parsed, id: "hunk" };
}

function files(name: string, contents: string): FileDiffLoadedFiles {
  return {
    oldFile: { name, contents },
    newFile: { name, contents },
  };
}

test("uses declarations already present in patch context without loading a file", () => {
  assert.equal(
    inferVisibleHunkContext(
      "example.ts",
      hunk(
        "@@ -20,5 +20,5 @@\n export function formatSubject(value: string) {\n   if (value) {\n-    return value;\n+    return value.trim();\n   }\n }",
      ),
    ),
    "export function formatSubject(value: string) {",
  );
});

test("finds enclosing declarations beyond the rendered diff context", () => {
  const contents = `export async function deliverNotification(\n  notification: Notification,\n  send: Sender,\n): Promise<void> {\n  for (let attempt = 1; attempt <= 3; attempt++) {\n    const backoff = attempt * 100;\n    try {\n      await send(notification);\n    } catch (error) {\n      await delay(attempt);\n    }\n  }\n}\n`;
  assert.equal(
    inferHunkContext(
      "src/notifications.ts",
      hunk(
        "@@ -7,3 +7,3 @@\n     } catch (error) {\n-      await delay(1);\n+      await delay(attempt);\n     }",
      ),
      files("src/notifications.ts", contents),
    ),
    "export async function deliverNotification(",
  );
});

test("recognizes common language and test scopes without mistaking control flow", () => {
  const cases = [
    {
      path: "service.py",
      contents: "class DeliveryService:\n    if enabled:\n        send_old()\n",
      expected: "class DeliveryService:",
    },
    {
      path: "worker.go",
      contents:
        "func deliver(ctx context.Context) error {\n\tif ready {\n\t\treturn oldValue\n\t}\n}\n",
      expected: "func deliver(ctx context.Context) error {",
    },
    {
      path: "notifications.test.ts",
      contents:
        "describe('delivery', () => {\n  it('retries failures', () => {\n    expect(oldValue);\n  });\n});\n",
      expected: "it('retries failures', () => {",
    },
    {
      path: "guide.md",
      contents: "## Retry policy\n\nThe old behavior applies.\n",
      expected: "## Retry policy",
    },
  ];
  for (const { path, contents, expected } of cases) {
    const line = contents
      .split("\n")
      .findIndex((value) => value.includes("old"));
    assert.equal(
      inferHunkContext(
        path,
        hunk(
          `@@ -${line + 1} +${line + 1} @@\n-${contents.split("\n")[line]}\n+replacement`,
          path,
        ),
        files(path, contents),
      ),
      expected,
      path,
    );
  }
});
