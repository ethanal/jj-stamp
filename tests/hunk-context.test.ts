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

test("does not name declarations introduced by the hunk itself", () => {
  assert.equal(
    inferVisibleHunkContext(
      "src/view.rs",
      hunk(
        "@@ -40,1 +40,8 @@\n }\n+\n+struct SnapshotWaiter<B: BaseView> {\n+    min_version: TableCursor,\n+    sender: Sender<B>,\n+}\n+\n+type SnapshotResult<B> = Result<ViewSnapshot<B>, HydrateError>;",
        "src/view.rs",
      ),
    ),
    undefined,
  );
});

test("returns the active Rust scope, never a preceding closed function", () => {
  const insideImpl = `impl<B: BaseView> PartitionData<B> {\n    fn hydration_task_mut(&mut self) -> Option<&mut HydrationTask<B>> {\n        match self {\n            Self::Hydrating { task } => Some(task),\n            _ => None,\n        }\n    }\n\n    fn publish_partition(&mut self) {\n        old_value();\n    }\n}\n`;
  assert.equal(
    inferHunkContext(
      "src/view.rs",
      hunk(
        "@@ -9,4 +9,4 @@\n     fn publish_partition(&mut self) {\n-        old_value();\n+        new_value();\n     }\n }",
        "src/view.rs",
      ),
      files("src/view.rs", insideImpl),
    ),
    "fn publish_partition(&mut self) {",
  );

  const betweenMethods = `impl<B: BaseView> PartitionData<B> {\n    fn hydration_task_mut(&mut self) -> Option<&mut HydrationTask<B>> {\n        None\n    }\n\n    old_value();\n}\n`;
  assert.equal(
    inferHunkContext(
      "src/view.rs",
      hunk(
        "@@ -5,3 +5,3 @@\n \n-    old_value();\n+    new_value();\n }",
        "src/view.rs",
      ),
      files("src/view.rs", betweenMethods),
    ),
    "impl<B: BaseView> PartitionData<B> {",
  );
  assert.equal(
    inferHunkContext(
      "src/view.rs",
      hunk(
        "@@ -4,1 +4,4 @@\n     }\n+}\n+\n+impl<B: BaseView> ViewData<B> {",
        "src/view.rs",
      ),
      files(
        "src/view.rs",
        "impl<B: BaseView> PartitionData<B> {\n    fn hydration_task_mut(&mut self) {\n        work();\n    }\n}\n\nimpl<B: BaseView> ViewData<B> {\n",
      ),
    ),
    "impl<B: BaseView> PartitionData<B> {",
  );
});

test("returns no Rust context after the preceding scope has closed", () => {
  const contents = `fn hydration_task_mut() {\n    old_value();\n}\n\nstruct Next {\n    value: usize,\n}\n`;
  assert.equal(
    inferHunkContext(
      "src/view.rs",
      hunk(
        "@@ -4,4 +4,4 @@\n \n struct Next {\n-    value: usize,\n+    value: u64,\n }",
        "src/view.rs",
      ),
      files("src/view.rs", contents),
    ),
    "struct Next {",
  );
  assert.equal(
    inferHunkContext(
      "src/view.rs",
      hunk("@@ -3,1 +3,3 @@\n }\n+\n+struct Added;", "src/view.rs"),
      files("src/view.rs", "fn hydration_task_mut() {\n}\n\nstruct Added;\n"),
    ),
    undefined,
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
