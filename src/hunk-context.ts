import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { Hunk } from "./types";

const MAX_CONTEXT_LENGTH = 140;
const BRACE_EXTENSIONS =
  /^(?:js|jsx|mjs|cjs|ts|tsx|mts|cts|vue|svelte|go|rs|java|kt|kts|scala|cs|c|h|cc|cpp|cxx|hpp|m|mm|php|phtml|sh|bash|zsh|fish|css|scss|sass|less)$/;

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
      /^(?:(?:pub(?:\([^)]*\))?|unsafe|async|const|default)\s+)*(?:fn|struct|enum|trait|impl|mod|type)\b/.test(
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

function hasClosingQuote(line: string, start: number, quote: string): boolean {
  for (let index = start + 1; index < line.length; index++) {
    if (line[index] === "\\") index++;
    else if (line[index] === quote) return true;
  }
  return false;
}

type StructuralToken = "{" | "}" | ";";
interface LexState {
  blockComment: boolean;
  quote?: string;
}

/** Extract structural tokens while ignoring comments and quoted text. */
function structuralTokens(
  line: string,
  state: LexState,
  hashComments: boolean,
): StructuralToken[] {
  const tokens: StructuralToken[] = [];
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    const next = line[index + 1];
    if (state.blockComment) {
      if (char === "*" && next === "/") {
        state.blockComment = false;
        index++;
      }
      continue;
    }
    if (state.quote) {
      if (char === "\\") index++;
      else if (char === state.quote) state.quote = undefined;
      continue;
    }
    if (char === "/" && next === "*") {
      state.blockComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "/") break;
    if (hashComments && char === "#") break;
    if (
      (char === '"' || char === "`" || char === "'") &&
      (char !== "'" || hasClosingQuote(line, index, char))
    ) {
      state.quote = char;
      continue;
    }
    if (char === "{" || char === "}" || char === ";") tokens.push(char);
  }
  // Only template literals are meaningfully multiline in the supported brace
  // languages. An unmatched apostrophe in Rust is usually a lifetime.
  if (state.quote !== "`") state.quote = undefined;
  return tokens;
}

function braceContext(path: string, lines: string[]): string | undefined {
  const frames: { label?: string }[] = [];
  const state: LexState = { blockComment: false };
  const hashComments = /^(?:sh|bash|zsh|fish|php|phtml)$/.test(extension(path));
  let pending: { label: string; remaining: number } | undefined;
  for (const raw of lines) {
    const label = contextLine(path, raw);
    if (label) pending = { label, remaining: 12 };
    const tokens = structuralTokens(raw, state, hashComments);
    for (const token of tokens) {
      if (token === "{") {
        frames.push({ label: pending?.label });
        pending = undefined;
      } else if (token === "}") {
        frames.pop();
      } else if (pending) {
        pending = undefined;
      }
    }
    if (pending && raw.trim()) {
      pending.remaining--;
      if (pending.remaining <= 0) pending = undefined;
    }
  }
  return frames.findLast((frame) => frame.label)?.label;
}

function indentation(raw: string): number {
  let width = 0;
  for (const char of raw) {
    if (char === " ") width++;
    else if (char === "\t") width += 8 - (width % 8);
    else break;
  }
  return width;
}

function bracketDelta(raw: string): number {
  const stripped = raw.replace(/(['"]).*?\1/g, "").replace(/#.*/, "");
  let delta = 0;
  for (const char of stripped) {
    if (char === "(" || char === "[" || char === "{") delta++;
    if (char === ")" || char === "]" || char === "}") delta--;
  }
  return delta;
}

function indentedContext(
  path: string,
  lines: string[],
  targetProbe?: string,
): string | undefined {
  const scopes: { indent: number; label: string }[] = [];
  let continuation = 0;
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const continued = continuation > 0;
    const indent = indentation(raw);
    if (!continued)
      while (scopes.at(-1) && indent <= scopes.at(-1)!.indent) scopes.pop();
    const label = contextLine(path, raw);
    if (label) scopes.push({ indent, label });
    continuation = Math.max(0, continuation + bracketDelta(raw));
  }
  if (targetProbe?.trim()) {
    const indent = indentation(targetProbe);
    while (scopes.at(-1) && indent <= scopes.at(-1)!.indent) scopes.pop();
  }
  return scopes.at(-1)?.label;
}

function markdownContext(
  lines: string[],
  targetProbe?: string,
): string | undefined {
  const headings: { level: number; label: string }[] = [];
  let fence: string | undefined;
  for (const raw of lines) {
    const marker = /^\s*(```+|~~~+)/.exec(raw)?.[1];
    if (marker) {
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^\s*(#{1,6})\s+\S/.exec(raw);
    if (!match) continue;
    const level = match[1].length;
    while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
    headings.push({ level, label: compact(raw) });
  }
  const target = targetProbe && /^\s*(#{1,6})\s+\S/.exec(targetProbe);
  if (target) {
    const level = target[1].length;
    while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
  }
  return headings.at(-1)?.label;
}

function resolveContext(
  path: string,
  lines: string[],
  targetProbe?: string,
): string | undefined {
  const ext = extension(path);
  if (/^(?:md|mdx|markdown)$/.test(ext))
    return markdownContext(lines, targetProbe);
  if (/^(?:py|rb|rake|yaml|yml)$/.test(ext))
    return indentedContext(path, lines, targetProbe);
  if (ext === "toml") {
    for (let index = lines.length - 1; index >= 0; index--) {
      const label = contextLine(path, lines[index]);
      if (label?.startsWith("[")) return label;
    }
    return;
  }
  if (BRACE_EXTENSIONS.test(ext) || !ext) return braceContext(path, lines);
  return;
}

function firstChangedRow(hunk: Hunk) {
  return hunk.rows.find((row) => row.raw[0] === "+" || row.raw[0] === "-");
}

function firstChangedProbe(hunk: Hunk): string | undefined {
  const first = hunk.rows.findIndex(
    (row) => row.raw[0] === "+" || row.raw[0] === "-",
  );
  if (first < 0) return;
  for (let index = first; index < hunk.rows.length; index++) {
    const row = hunk.rows[index];
    if (row.raw[0] !== "+" && row.raw[0] !== "-") break;
    if (row.raw.slice(1).trim()) return row.raw.slice(1);
  }
}

export function inferVisibleHunkContext(
  path: string,
  hunk: Hunk,
): string | undefined {
  const firstChange = hunk.rows.findIndex(
    (row) => row.raw[0] === "+" || row.raw[0] === "-",
  );
  if (firstChange < 0) return;
  return resolveContext(
    path,
    hunk.rows.slice(0, firstChange).map((row) => row.raw.slice(1)),
    firstChangedProbe(hunk),
  );
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

/** Find the active language scope immediately before a hunk's first change. */
export function inferHunkContext(
  path: string,
  hunk: Hunk,
  files: FileDiffLoadedFiles,
): string | undefined {
  const changed = firstChangedRow(hunk);
  if (!changed) return;
  const pair = files as {
    oldFile: { contents: string } | null;
    newFile: { contents: string } | null;
  };
  const deleting = changed.raw[0] === "-";
  const file = deleting ? pair.oldFile : pair.newFile;
  const line = deleting ? changed.oldLine : changed.newLine;
  if (!file || line === undefined) return;
  const lines = file.contents.replace(/\r\n/g, "\n").split("\n");
  const targetIndex = line - 1;
  const targetProbe = lines.slice(targetIndex).find((raw) => raw.trim());
  return resolveContext(path, lines.slice(0, targetIndex), targetProbe);
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
