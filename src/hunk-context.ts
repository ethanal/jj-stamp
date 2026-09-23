import { Language, Parser, type Node } from "web-tree-sitter";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { Hunk } from "./types";

const MAX_CONTEXT_LENGTH = 140;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

type LanguageId =
  | "bash"
  | "c"
  | "cpp"
  | "cSharp"
  | "go"
  | "java"
  | "javascript"
  | "php"
  | "python"
  | "ruby"
  | "rust"
  | "tsx"
  | "typescript";

export interface TreeSitterAssets {
  core: string;
  languages: Record<LanguageId, string>;
}

interface ScopeRule {
  type: string;
  bodyFields?: string[];
  bodyTypes?: string[];
  displayParentTypes?: string[];
  requireDisplayParent?: boolean;
}

const COMMON_BODY_FIELDS = ["body"];
const SPECS: Record<LanguageId, ScopeRule[]> = {
  rust: [
    "function_item",
    "impl_item",
    "struct_item",
    "enum_item",
    "union_item",
    "trait_item",
    "mod_item",
  ].map((type) => ({ type })),
  javascript: [
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
  ]
    .map<ScopeRule>((type) => ({
      type,
      displayParentTypes: ["export_statement"],
    }))
    .concat([
      {
        type: "arrow_function",
        displayParentTypes: [
          "variable_declarator",
          "lexical_declaration",
          "export_statement",
        ],
        requireDisplayParent: true,
      },
      {
        type: "function_expression",
        displayParentTypes: [
          "variable_declarator",
          "lexical_declaration",
          "export_statement",
        ],
        requireDisplayParent: true,
      },
    ]),
  typescript: [
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
    "module",
    "internal_module",
  ]
    .map<ScopeRule>((type) => ({
      type,
      displayParentTypes: ["export_statement"],
    }))
    .concat([
      {
        type: "arrow_function",
        displayParentTypes: [
          "variable_declarator",
          "lexical_declaration",
          "export_statement",
        ],
        requireDisplayParent: true,
      },
      {
        type: "function_expression",
        displayParentTypes: [
          "variable_declarator",
          "lexical_declaration",
          "export_statement",
        ],
        requireDisplayParent: true,
      },
    ]),
  tsx: [
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "enum_declaration",
    "module",
    "internal_module",
  ]
    .map<ScopeRule>((type) => ({
      type,
      displayParentTypes: ["export_statement"],
    }))
    .concat([
      {
        type: "arrow_function",
        displayParentTypes: [
          "variable_declarator",
          "lexical_declaration",
          "export_statement",
        ],
        requireDisplayParent: true,
      },
      {
        type: "function_expression",
        displayParentTypes: [
          "variable_declarator",
          "lexical_declaration",
          "export_statement",
        ],
        requireDisplayParent: true,
      },
    ]),
  python: ["function_definition", "class_definition"].map((type) => ({
    type,
  })),
  go: [
    { type: "function_declaration" },
    { type: "method_declaration" },
    {
      type: "type_spec",
      bodyTypes: ["field_declaration_list"],
      displayParentTypes: ["type_declaration"],
    },
  ],
  java: [
    "method_declaration",
    "constructor_declaration",
    "class_declaration",
    "interface_declaration",
    "enum_declaration",
    "record_declaration",
    "annotation_type_declaration",
  ].map((type) => ({ type })),
  c: [
    "function_definition",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
  ].map((type) => ({ type })),
  cpp: [
    "function_definition",
    "class_specifier",
    "struct_specifier",
    "union_specifier",
    "enum_specifier",
    "namespace_definition",
  ].map((type) => ({ type })),
  cSharp: [
    "method_declaration",
    "constructor_declaration",
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "record_declaration",
    "enum_declaration",
    "namespace_declaration",
  ].map((type) => ({ type })),
  ruby: [
    "method",
    "singleton_method",
    "class",
    "singleton_class",
    "module",
  ].map((type) => ({ type })),
  php: [
    "function_definition",
    "method_declaration",
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "enum_declaration",
    "namespace_definition",
  ].map((type) => ({ type })),
  bash: [{ type: "function_definition" }],
};

const RULES = Object.fromEntries(
  Object.entries(SPECS).map(([language, rules]) => [
    language,
    new Map(rules.map((rule) => [rule.type, rule])),
  ]),
) as Record<LanguageId, Map<string, ScopeRule>>;

let assetProvider = async (): Promise<TreeSitterAssets> =>
  (await import("./tree-sitter-assets")).treeSitterAssets;
let runtimePromise: Promise<TreeSitterAssets> | undefined;
const languagePromises = new Map<LanguageId, Promise<Language>>();

/** Test-only hook: install filesystem paths before the first parser request. */
export function setTreeSitterAssetsForTesting(assets: TreeSitterAssets): void {
  if (runtimePromise)
    throw new Error("Tree-sitter was already initialized before test setup.");
  assetProvider = async () => assets;
}

async function runtime(): Promise<TreeSitterAssets> {
  runtimePromise ??= assetProvider()
    .then(async (assets) => {
      await Parser.init({ locateFile: () => assets.core });
      return assets;
    })
    .catch((error) => {
      runtimePromise = undefined;
      languagePromises.clear();
      throw error;
    });
  return runtimePromise;
}

async function language(id: LanguageId): Promise<Language> {
  let pending = languagePromises.get(id);
  if (!pending) {
    pending = runtime()
      .then((assets) => Language.load(assets.languages[id]))
      .catch((error) => {
        languagePromises.delete(id);
        throw error;
      });
    languagePromises.set(id, pending);
  }
  return pending;
}

function languageForPath(path: string): LanguageId | undefined {
  const name = path.split("/").at(-1)?.toLowerCase() ?? "";
  if (name === "rakefile") return "ruby";
  const extension = name.includes(".") ? name.split(".").at(-1) : undefined;
  switch (extension) {
    case "rs":
      return "rust";
    case "ts":
    case "mts":
    case "cts":
      return "typescript";
    case "tsx":
      return "tsx";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "py":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    case "c":
      return "c";
    case "cc":
    case "cpp":
    case "cxx":
    case "hh":
    case "hpp":
    case "hxx":
      return "cpp";
    case "cs":
      return "cSharp";
    case "rb":
    case "rake":
      return "ruby";
    case "php":
    case "phtml":
      return "php";
    case "sh":
    case "bash":
      return "bash";
    default:
      return;
  }
}

export function supportsHunkContext(path: string): boolean {
  return languageForPath(path) !== undefined;
}

function compact(value: string): string {
  const line = value.trim().replace(/\s+/g, " ");
  return line.length <= MAX_CONTEXT_LENGTH
    ? line
    : `${line.slice(0, MAX_CONTEXT_LENGTH - 1)}…`;
}

function firstChangedRow(hunk: Hunk) {
  return hunk.rows.find((row) => row.raw[0] === "+" || row.raw[0] === "-");
}

function bodyFor(node: Node, rule: ScopeRule, boundary: number): Node | null {
  for (const field of rule.bodyFields ?? COMMON_BODY_FIELDS) {
    const body = node.childForFieldName(field);
    if (body && body.startIndex <= boundary && body.endIndex > boundary)
      return body;
  }
  for (const type of rule.bodyTypes ?? []) {
    for (const body of node.descendantsOfType(type))
      if (body.startIndex <= boundary && body.endIndex > boundary) return body;
  }
  return null;
}

function displayNode(node: Node, rule: ScopeRule): Node | null {
  const allowed = new Set(rule.displayParentTypes ?? []);
  let display = node;
  while (display.parent && allowed.has(display.parent.type))
    display = display.parent;
  return rule.requireDisplayParent && display.equals(node) ? null : display;
}

function headerText(
  source: string,
  node: Node,
  body: Node,
  rule: ScopeRule,
): string | undefined {
  const display = displayNode(node, rule);
  if (!display || display.startIndex >= body.startIndex) return;
  let header = source.slice(display.startIndex, body.startIndex);
  const opener = source.slice(body.startIndex, body.startIndex + 1);
  header = compact(`${header}${opener === "{" ? " {" : ""}`);
  return header || undefined;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index++)
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  return starts;
}

function contextAtLine(
  root: Node,
  source: string,
  starts: number[],
  line: number,
  rules: Map<string, ScopeRule>,
): string | undefined {
  const row = line - 1;
  const lineStart = starts[row];
  if (lineStart === undefined) return;
  const lineEnd = starts[row + 1] ?? source.length;
  let point = lineStart;
  while (
    point < lineEnd &&
    (source.charCodeAt(point) === 32 || source.charCodeAt(point) === 9)
  )
    point++;
  if (point >= source.length) point = Math.max(0, source.length - 1);
  let node = root.descendantForIndex(point);
  while (node) {
    const rule = rules.get(node.type);
    if (
      rule &&
      node.startIndex < lineStart &&
      !node.hasError &&
      !node.isMissing
    ) {
      const body = bodyFor(node, rule, point);
      if (body && !body.hasError && !body.isMissing)
        return headerText(source, node, body, rule);
    }
    node = node.parent;
  }
}

interface Target {
  id: string;
  line: number;
}

async function contextsForSource(
  languageId: LanguageId,
  contents: string,
  targets: Target[],
): Promise<Record<string, string>> {
  const bytes = new TextEncoder().encode(contents);
  if (bytes.length > MAX_PARSE_BYTES) return {};
  const loadedLanguage = await language(languageId);
  const parser = new Parser();
  let tree;
  try {
    parser.setLanguage(loadedLanguage);
    tree = parser.parse(contents);
    if (!tree || tree.rootNode.hasError) return {};
    const starts = lineStarts(contents);
    const rules = RULES[languageId];
    return Object.fromEntries(
      targets.flatMap(({ id, line }) => {
        const context = contextAtLine(
          tree!.rootNode,
          contents,
          starts,
          line,
          rules,
        );
        return context ? [[id, context]] : [];
      }),
    );
  } finally {
    tree?.delete();
    parser.delete();
  }
}

/** Parse complete pinned file contents and return only confident enclosing scopes. */
export async function inferHunkContexts(
  path: string,
  hunks: Hunk[],
  files: FileDiffLoadedFiles,
): Promise<Record<string, string>> {
  const languageId = languageForPath(path);
  if (!languageId) return {};
  const pair = files as {
    oldFile: { contents: string } | null;
    newFile: { contents: string } | null;
  };
  const oldTargets: Target[] = [];
  const newTargets: Target[] = [];
  for (const hunk of hunks) {
    const changed = firstChangedRow(hunk);
    if (!changed) continue;
    if (changed.raw[0] === "-" && changed.oldLine !== undefined)
      oldTargets.push({ id: hunk.id, line: changed.oldLine });
    else if (changed.raw[0] === "+" && changed.newLine !== undefined)
      newTargets.push({ id: hunk.id, line: changed.newLine });
  }
  const [oldContexts, newContexts] = await Promise.all([
    pair.oldFile && oldTargets.length
      ? contextsForSource(languageId, pair.oldFile.contents, oldTargets)
      : {},
    pair.newFile && newTargets.length
      ? contextsForSource(languageId, pair.newFile.contents, newTargets)
      : {},
  ]);
  return { ...oldContexts, ...newContexts };
}
