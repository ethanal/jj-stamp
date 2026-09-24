import { languageForPath, type LanguageId } from "./hunk-context-language";
export { supportsHunkContext } from "./hunk-context-language";
import { Language, Parser, type Node } from "web-tree-sitter";
import type { FileDiffLoadedFiles } from "@pierre/diffs";
import type { Hunk } from "./types";

const MAX_CONTEXT_LENGTH = 140;
const MAX_PARSE_BYTES = 2 * 1024 * 1024;

export interface TreeSitterAssets {
  core: string;
  languages: Record<LanguageId, string>;
}

export interface HunkScope {
  label: string;
  oldLine?: number;
  newLine?: number;
}

export interface HunkContext {
  scopes: HunkScope[];
}

interface ScopeLocation {
  label: string;
  startLine: number;
  type: string;
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

function scopeLocation(
  source: string,
  node: Node,
  body: Node,
  rule: ScopeRule,
): ScopeLocation | undefined {
  const display = displayNode(node, rule);
  if (!display || display.startIndex >= body.startIndex) return;
  let header = source.slice(display.startIndex, body.startIndex);
  const opener = source.slice(body.startIndex, body.startIndex + 1);
  const label = compact(`${header}${opener === "{" ? " {" : ""}`);
  return label
    ? { label, startLine: display.startPosition.row + 1, type: node.type }
    : undefined;
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
): ScopeLocation[] {
  const contexts: ScopeLocation[] = [];
  const row = line - 1;
  const lineStart = starts[row];
  if (lineStart === undefined) return [];
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
      if (body && !body.hasError && !body.isMissing) {
        const context = scopeLocation(source, node, body, rule);
        if (context) contexts.push(context);
      }
    }
    node = node.parent;
  }
  return contexts;
}

function targetLine(hunk: Hunk, side: "old" | "new"): number | undefined {
  const first = hunk.rows.findIndex(
    (row) => row.raw[0] === "+" || row.raw[0] === "-",
  );
  if (first < 0) return;
  let last = first;
  while (
    last + 1 < hunk.rows.length &&
    (hunk.rows[last + 1].raw[0] === "+" || hunk.rows[last + 1].raw[0] === "-")
  )
    last++;
  const coordinate = side === "old" ? "oldLine" : "newLine";
  const marker = side === "old" ? "-" : "+";
  for (let index = first; index <= last; index++)
    if (hunk.rows[index].raw[0] === marker) return hunk.rows[index][coordinate];
  for (let index = last + 1; index < hunk.rows.length; index++) {
    const line = hunk.rows[index][coordinate];
    if (line !== undefined) return line;
  }
  for (let index = first - 1; index >= 0; index--) {
    const line = hunk.rows[index][coordinate];
    if (line !== undefined) return line + 1;
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
): Promise<Record<string, ScopeLocation[]>> {
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
        return context.length ? [[id, context]] : [];
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
): Promise<Record<string, HunkContext>> {
  const languageId = languageForPath(path);
  if (!languageId) return {};
  const pair = files as {
    oldFile: { contents: string } | null;
    newFile: { contents: string } | null;
  };
  const oldTargets: Target[] = [];
  const newTargets: Target[] = [];
  for (const hunk of hunks) {
    const oldLine = targetLine(hunk, "old");
    const newLine = targetLine(hunk, "new");
    if (oldLine !== undefined) oldTargets.push({ id: hunk.id, line: oldLine });
    if (newLine !== undefined) newTargets.push({ id: hunk.id, line: newLine });
  }
  const [oldContexts, newContexts] = await Promise.all([
    pair.oldFile && oldTargets.length
      ? contextsForSource(languageId, pair.oldFile.contents, oldTargets)
      : ({} as Record<string, ScopeLocation[]>),
    pair.newFile && newTargets.length
      ? contextsForSource(languageId, pair.newFile.contents, newTargets)
      : ({} as Record<string, ScopeLocation[]>),
  ]);
  return Object.fromEntries(
    hunks.flatMap((hunk) => {
      const changed = firstChangedRow(hunk);
      if (!changed) return [];
      const oldScopes = oldContexts[hunk.id] ?? [];
      const newScopes = newContexts[hunk.id] ?? [];
      const primaryScopes = changed.raw[0] === "-" ? oldScopes : newScopes;
      if (!primaryScopes.length) return [];
      return [
        [
          hunk.id,
          {
            scopes: primaryScopes.map((primary) => {
              const sameScope = (candidate: ScopeLocation) =>
                candidate.type === primary.type &&
                candidate.label === primary.label;
              const oldScope = oldScopes.find(sameScope);
              const newScope = newScopes.find(sameScope);
              return {
                label: primary.label,
                ...(oldScope ? { oldLine: oldScope.startLine } : {}),
                ...(newScope ? { newLine: newScope.startLine } : {}),
              };
            }),
          },
        ],
      ];
    }),
  );
}
