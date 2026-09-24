import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import { parseFile } from "../server/diff.ts";
import {
  inferHunkContexts,
  setTreeSitterAssetsForTesting,
  type TreeSitterAssets,
} from "../src/hunk-context.ts";
import type { Hunk } from "../src/types.ts";

const grammar = (directory: string, file = directory) =>
  path.resolve(
    `node_modules/tree-sitter-wasm/out/${directory}/tree-sitter-${file}.wasm`,
  );
setTreeSitterAssetsForTesting({
  core: path.resolve("node_modules/web-tree-sitter/web-tree-sitter.wasm"),
  languages: {
    bash: grammar("bash"),
    c: grammar("c"),
    cpp: grammar("cpp"),
    cSharp: grammar("c_sharp"),
    go: grammar("go"),
    java: grammar("java"),
    javascript: grammar("javascript"),
    php: grammar("php"),
    python: grammar("python"),
    ruby: grammar("ruby"),
    rust: grammar("rust"),
    tsx: grammar("tsx"),
    typescript: grammar("typescript"),
  },
} satisfies TreeSitterAssets);

function hunk(body: string, filePath = "example.ts"): Hunk {
  const parsed = parseFile(
    `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${body}\n`,
    filePath,
  ).hunks[0];
  return { ...parsed, id: "hunk" };
}

function files(
  name: string,
  oldContents: string,
  newContents = oldContents,
): FileDiffLoadedFiles {
  return {
    oldFile: { name, contents: oldContents },
    newFile: { name, contents: newContents },
  };
}

async function context(
  filePath: string,
  patch: string,
  oldContents: string,
  newContents = oldContents,
): Promise<string | undefined> {
  return (
    await inferHunkContexts(
      filePath,
      [hunk(patch, filePath)],
      files(filePath, oldContents, newContents),
    )
  ).hunk?.label;
}

test("does not name a declaration introduced by the hunk itself", async () => {
  const oldContents = `fn snapshot() {\n    work();\n}\n`;
  const newContents = `${oldContents}\nstruct SnapshotWaiter<B: BaseView> {\n    min_version: TableCursor,\n    sender: Sender<B>,\n}\n`;
  assert.equal(
    await context(
      "src/view.rs",
      "@@ -2,2 +2,7 @@\n     work();\n }\n+\n+struct SnapshotWaiter<B: BaseView> {\n+    min_version: TableCursor,\n+    sender: Sender<B>,\n+}",
      oldContents,
      newContents,
    ),
    undefined,
  );
});

test("returns the active Rust ancestor, never a preceding closed function", async () => {
  const contents = `impl<B: BaseView> PartitionData<B> {\n    fn hydration_task_mut(&mut self) -> Option<&mut HydrationTask<B>> {\n        None\n    }\n\n    fn publish_partition(&mut self) {\n        old_value();\n    }\n}\n`;
  assert.equal(
    await context(
      "src/view.rs",
      "@@ -6,3 +6,3 @@\n     fn publish_partition(&mut self) {\n-        old_value();\n+        new_value();\n     }",
      contents,
    ),
    "fn publish_partition(&mut self) {",
  );

  const oldContents = `impl<B: BaseView> PartitionData<B> {\n    fn hydration_task_mut(&mut self) {\n        work();\n    }\n`;
  const newContents = `${oldContents}}\n\nimpl<B: BaseView> ViewData<B> {\n}\n`;
  assert.equal(
    await context(
      "src/view.rs",
      "@@ -3,2 +3,5 @@\n         work();\n     }\n+}\n+\n+impl<B: BaseView> ViewData<B> {",
      oldContents,
      newContents,
    ),
    "impl<B: BaseView> PartitionData<B> {",
  );
});

test("returns no scope after the preceding Rust item has closed", async () => {
  const oldContents = `fn hydration_task_mut() {\n    work();\n}\n`;
  const newContents = `${oldContents}\nstruct Added;\n`;
  assert.equal(
    await context(
      "src/view.rs",
      "@@ -2,2 +2,4 @@\n     work();\n }\n+\n+struct Added;",
      oldContents,
      newContents,
    ),
    undefined,
  );
});

test("finds complete TypeScript, Python, and Go ancestors", async () => {
  const cases = [
    {
      path: "src/notifications.ts",
      contents: `export async function deliverNotification(\n  notification: Notification,\n): Promise<void> {\n  if (notification.ready) {\n    oldValue();\n  }\n}\n`,
      patch:
        "@@ -4,3 +4,3 @@\n   if (notification.ready) {\n-    oldValue();\n+    newValue();\n   }",
      expected:
        "export async function deliverNotification( notification: Notification, ): Promise<void> {",
    },
    {
      path: "service.py",
      contents:
        "class DeliveryService:\n    def send(self):\n        old_value()\n",
      patch:
        "@@ -1,3 +1,3 @@\n class DeliveryService:\n     def send(self):\n-        old_value()\n+        new_value()",
      expected: "def send(self):",
    },
    {
      path: "worker.go",
      contents:
        "type Worker struct{}\n\nfunc (w *Worker) Deliver() {\n\toldValue()\n}\n",
      patch:
        "@@ -3,3 +3,3 @@\n func (w *Worker) Deliver() {\n-\toldValue()\n+\tnewValue()\n }",
      expected: "func (w *Worker) Deliver() {",
    },
  ];
  for (const item of cases)
    assert.equal(
      await context(item.path, item.patch, item.contents),
      item.expected,
      item.path,
    );
});

test("handles Unicode offsets and named TypeScript expression scopes", async () => {
  const unicode = `// 😀 recipient\nexport function deliver() {\n  oldValue();\n}\n`;
  assert.equal(
    await context(
      "unicode.ts",
      "@@ -2,3 +2,3 @@\n export function deliver() {\n-  oldValue();\n+  newValue();\n }",
      unicode,
    ),
    "export function deliver() {",
  );

  const arrow = `export const deliver = () => {\n  oldValue();\n};\n`;
  assert.equal(
    await context(
      "arrow.ts",
      "@@ -1,3 +1,3 @@\n export const deliver = () => {\n-  oldValue();\n+  newValue();\n };",
      arrow,
    ),
    "export const deliver = () => {",
  );

  const namespace = `export namespace Delivery {\n  let oldValue = 1;\n}\n`;
  assert.equal(
    await context(
      "namespace.ts",
      "@@ -1,3 +1,3 @@\n export namespace Delivery {\n-  let oldValue = 1;\n+  let newValue = 1;\n }",
      namespace,
    ),
    "export namespace Delivery {",
  );
});

test("supports the documented Tree-sitter language set", async () => {
  const cases = [
    {
      path: "Example.java",
      contents: "class Example {\n  int value() {\n    oldValue();\n  }\n}\n",
      patch:
        "@@ -2,3 +2,3 @@\n   int value() {\n-    oldValue();\n+    newValue();\n   }",
      expected: "int value() {",
    },
    {
      path: "example.c",
      contents: "int value(void) {\n  old_value();\n}\n",
      patch:
        "@@ -1,3 +1,3 @@\n int value(void) {\n-  old_value();\n+  new_value();\n }",
      expected: "int value(void) {",
    },
    {
      path: "example.cpp",
      contents: "class Example {\n  int value() {\n    old_value();\n  }\n};\n",
      patch:
        "@@ -2,3 +2,3 @@\n   int value() {\n-    old_value();\n+    new_value();\n   }",
      expected: "int value() {",
    },
    {
      path: "Example.cs",
      contents: "class Example {\n  int Value() {\n    OldValue();\n  }\n}\n",
      patch:
        "@@ -2,3 +2,3 @@\n   int Value() {\n-    OldValue();\n+    NewValue();\n   }",
      expected: "int Value() {",
    },
    {
      path: "example.rb",
      contents: "class Example\n  def value\n    old_value\n  end\nend\n",
      patch:
        "@@ -2,3 +2,3 @@\n   def value\n-    old_value\n+    new_value\n   end",
      expected: "def value",
    },
    {
      path: "example.php",
      contents:
        "<?php\nclass Example {\n  function value() {\n    old_value();\n  }\n}\n",
      patch:
        "@@ -3,3 +3,3 @@\n   function value() {\n-    old_value();\n+    new_value();\n   }",
      expected: "function value() {",
    },
    {
      path: "example.sh",
      contents: "value() {\n  old_value\n}\n",
      patch: "@@ -1,3 +1,3 @@\n value() {\n-  old_value\n+  new_value\n }",
      expected: "value() {",
    },
  ];
  for (const item of cases)
    assert.equal(
      await context(item.path, item.patch, item.contents),
      item.expected,
      item.path,
    );
});

test("returns no label for unsupported or syntactically invalid files", async () => {
  assert.deepEqual(
    await inferHunkContexts(
      "guide.md",
      [hunk("@@ -1 +1 @@\n-old\n+new", "guide.md")],
      files("guide.md", "old\n", "new\n"),
    ),
    {},
  );
  assert.equal(
    await context(
      "partly-broken.rs",
      "@@ -1,3 +1,3 @@\n fn valid() {\n-    old_value();\n+    new_value();\n }",
      "fn valid() {\n    old_value();\n}\nfn broken( {\n",
    ),
    undefined,
  );
});
