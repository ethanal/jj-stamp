import type { Hunk } from "../src/types";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import {
  inferCachedHunkContexts,
  peekCachedHunkContexts,
  hunkContextCacheStats,
} from "../src/hunk-context-client";

export async function run() {
  const hunks: Hunk[] = [
    {
      id: "hunk",
      header: "@@ -2 +2 @@",
      rows: [
        { index: 1, raw: "-  old();", oldLine: 2 },
        { index: 2, raw: "+  changed();", newLine: 2 },
      ],
    },
  ];
  const files: FileDiffLoadedFiles = {
    oldFile: { name: "file.ts", contents: "function scope() {\n  old();\n}\n" },
    newFile: {
      name: "file.ts",
      contents: "function scope() {\n  changed();\n}\n",
    },
  };
  const identity = "repo/full-source-commit/full-base-commit/patch";
  const cold = await inferCachedHunkContexts(identity, "file.ts", hunks, files);
  const warm = await inferCachedHunkContexts(identity, "file.ts", hunks, files);
  const peek = peekCachedHunkContexts(identity, "file.ts");
  const invalid: FileDiffLoadedFiles = {
    oldFile: { name: "file.ts", contents: "function { syntax error" },
    newFile: { name: "file.ts", contents: "function { syntax error" },
  };
  const empty = await inferCachedHunkContexts(
    "invalid",
    "file.ts",
    hunks,
    invalid,
  );
  await inferCachedHunkContexts("invalid", "file.ts", hunks, invalid);
  const absent = await inferCachedHunkContexts("absent", "file.ts", hunks, {
    oldFile: null,
    newFile: files.newFile,
  } as FileDiffLoadedFiles);
  return { cold, warm, peek, empty, absent, stats: hunkContextCacheStats() };
}
