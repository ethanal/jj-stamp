import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { Hunk } from "./types";

const MAX_CONTEXT_LENGTH = 140;

function compact(line: string): string {
  const value = line.trim().replace(/\s+/g, " ");
  return value.length <= MAX_CONTEXT_LENGTH
    ? value
    : `${value.slice(0, MAX_CONTEXT_LENGTH - 1)}…`;
}

function extension(path: string): string {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (/^(?:makefile|dockerfile|jenkinsfile)$/.test(name)) return name;
  return name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
}

function javascriptContext(line: string, indented: boolean): boolean {
  if (
    /^(?:(?:export|declare)\s+)*(?:default\s+)?(?:(?:abstract|async)\s+)*(?:class|interface|enum|namespace|module|type|function)\b/.test(
      line,
    )
  )
    return true;
  if (
    /^(?:(?:export|declare)\s+)+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/.test(
      line,
    ) ||
    (!indented &&
      /^(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/.test(line))
  )
    return true;
  if (/^(?:describe|context|suite|test|it)\s*\(/.test(line)) return true;
  const method =
    /^(?:(?:public|private|protected|static|abstract|async|override|readonly|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]+>)?\s*\(/.exec(
      line,
    );
  return (
    !!method &&
    !/^(?:if|for|while|switch|catch|with)$/.test(method[1]) &&
    (line.endsWith("(") || /\)\s*(?::[^=]+)?\s*\{?$/.test(line)) &&
    !line.endsWith(";")
  );
}

function cLikeContext(line: string): boolean {
  if (
    /^(?:(?:public|private|protected|internal|static|final|abstract|sealed|open|data|export)\s+)*(?:class|interface|enum|record|struct|union|namespace|trait|impl|object)\b/.test(
      line,
    )
  )
    return true;
  if (
    /^(?:template\s*<.*>\s*)?(?:[\w:*&<>\[\],?]+\s+)+[~\w:]+\s*\([^;]*\)\s*(?:const\s*)?(?:\{|$)/.test(
      line,
    )
  )
    return !/^(?:if|for|while|switch|catch)\b/.test(line);
  return false;
}

function contextLine(path: string, raw: string): string | undefined {
  const indented = /^\s/.test(raw);
  const line = compact(raw);
  if (!line || /^(?:\/\/|\/\*|\*|--\s)/.test(line)) return;
  const ext = extension(path);
  let matches = false;
  if (/^(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte)$/.test(ext))
    matches = javascriptContext(line, indented);
  else if (ext === "py")
    matches = /^(?:async\s+)?(?:def|class)\s+\w+/.test(line);
  else if (/^(?:rb|rake)$/.test(ext))
    matches = /^(?:class|module|def)\b/.test(line);
  else if (ext === "go") matches = /^(?:func|type)\b/.test(line);
  else if (ext === "rs")
    matches =
      /^(?:(?:pub|unsafe|async|const)\s+)*(?:fn|struct|enum|trait|impl|mod)\b/.test(
        line,
      );
  else if (/^(?:java|kt|kts|scala|cs|c|h|cc|cpp|cxx|hpp|m|mm)$/.test(ext))
    matches = cLikeContext(line);
  else if (/^(?:php|phtml)$/.test(ext))
    matches =
      /^(?:(?:abstract|final|public|protected|private|static)\s+)*(?:class|interface|trait|enum|function)\b/.test(
        line.replace(/^<\?php\s*/, ""),
      );
  else if (/^(?:sh|bash|zsh|fish)$/.test(ext))
    matches = /^(?:function\s+)?[A-Za-z_][\w-]*(?:\s*\(\))?\s*\{?$/.test(line);
  else if (/^(?:md|mdx|markdown)$/.test(ext))
    matches = /^#{1,6}\s+\S/.test(line);
  else if (/^(?:css|scss|sass|less)$/.test(ext))
    matches = /^(?:@(?:media|supports|layer|keyframes)\b|[^@{}][^{]*\{)$/.test(
      line,
    );
  else if (/^(?:yaml|yml|toml)$/.test(ext))
    matches = /^(?:\[[^\]]+\]|[A-Za-z_][\w.-]*:)\s*/.test(line);
  else
    matches =
      javascriptContext(line, indented) ||
      /^(?:async\s+)?(?:def|class|func|fn)\b/.test(line) ||
      cLikeContext(line);
  return matches ? line : undefined;
}

function targetLine(hunk: Hunk, usingNewFile: boolean): number | undefined {
  const changed = hunk.rows.find(
    (row) =>
      row.raw[0] === (usingNewFile ? "+" : "-") &&
      (usingNewFile ? row.newLine : row.oldLine) !== undefined,
  );
  const any = hunk.rows.find(
    (row) => (usingNewFile ? row.newLine : row.oldLine) !== undefined,
  );
  return usingNewFile
    ? (changed?.newLine ?? any?.newLine)
    : (changed?.oldLine ?? any?.oldLine);
}

export function inferVisibleHunkContext(
  path: string,
  hunk: Hunk,
): string | undefined {
  const firstChange = hunk.rows.findIndex(
    (row) => row.raw[0] === "+" || row.raw[0] === "-",
  );
  if (firstChange < 0) return;
  let end = firstChange;
  while (
    end + 1 < hunk.rows.length &&
    (hunk.rows[end + 1].raw[0] === "+" || hunk.rows[end + 1].raw[0] === "-")
  )
    end++;
  for (let index = end; index >= 0; index--) {
    const context = contextLine(path, hunk.rows[index].raw.slice(1));
    if (context) return context;
  }
}

export function inferVisibleHunkContexts(
  path: string,
  hunks: Hunk[],
): Record<string, string> {
  return Object.fromEntries(
    hunks.flatMap((hunk) => {
      const context = inferVisibleHunkContext(path, hunk);
      return context ? [[hunk.id, context]] : [];
    }),
  );
}

/** Find the nearest language-level declaration above a hunk's first change. */
export function inferHunkContext(
  path: string,
  hunk: Hunk,
  files: FileDiffLoadedFiles,
): string | undefined {
  const file = files.newFile ?? files.oldFile;
  if (!file) return;
  const usingNewFile = files.newFile !== null;
  const target = targetLine(hunk, usingNewFile);
  if (target === undefined) return;
  const lines = file.contents.replace(/\r\n/g, "\n").split("\n");
  for (
    let index = Math.min(target - 1, lines.length - 1);
    index >= 0;
    index--
  ) {
    const context = contextLine(path, lines[index]);
    if (context) return context;
  }
}

export function inferHunkContexts(
  path: string,
  hunks: Hunk[],
  files: FileDiffLoadedFiles,
): Record<string, string> {
  return Object.fromEntries(
    hunks.flatMap((hunk) => {
      const context = inferHunkContext(path, hunk, files);
      return context ? [[hunk.id, context]] : [];
    }),
  );
}
