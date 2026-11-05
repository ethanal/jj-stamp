import test from "node:test";
import assert from "node:assert/strict";
import {
  containsReviewMarkers,
  parseReviewComments,
} from "../src/review-comments.ts";
import {
  mutateReviewComments,
  validateCommentMutation,
} from "../server/review-comments.ts";
import { projectCommentsFile } from "../server/comments-layer.ts";

const id = "12345678-1234-1234-1234-123456789abc";
const other = "12345678-1234-1234-1234-123456789abd";
const start = (body = "Please fix", uuid = id) =>
  `// JJ-STAMP(${uuid}): ${body}`;
const end = (uuid = id) => `// JJ-STAMP(${uuid})`;
const input = { version: "a".repeat(64), path: "main.ts" };

test("shared parser exposes physical single/multiline/range coordinates and CRLF bodies", () => {
  const contents = [
    "let a = 1;",
    start("First"),
    start("Second"),
    "let b = 2;",
    "let c = 3;",
    end(),
    start("One line", other),
    "let d = 4;",
    "",
  ].join("\r\n");
  const result = parseReviewComments("main.ts", contents);
  assert.equal(result.editable, true);
  assert.deepEqual(result.comments, [
    {
      id,
      body: "First\nSecond",
      markerLines: [2, 3, 6],
      startLine: 2,
      anchorLine: 4,
      endAnchorLine: 5,
      endMarkerLine: 6,
    },
    {
      id: other,
      body: "One line",
      markerLines: [7],
      startLine: 7,
      anchorLine: 8,
      endAnchorLine: 8,
    },
  ]);
});

test("malformed, duplicate, noncontiguous UUID, empty-anchor and unmatched end fail closed", () => {
  for (const contents of [
    "// JJ-STAMP(not-a-uuid): text\ncode\n",
    `//JJ-STAMP(${id}): text\ncode\n`,
    `${start()}\ncode\n${start()}\ncode\n`,
    `${start()}\ncode\n${start("continued")}\ncode\n`,
    `${end()}\ncode\n`,
    `${start()}\n${end()}\n`,
    `${start()}\n`,
    `${start()}\ncode\n${end()}\n${end()}\n`,
    `${start()}\n${start("x", other)}\ncode\n`,
  ]) {
    const result = parseReviewComments("main.go", contents);
    assert.equal(result.editable, false, contents);
    assert.ok(result.issues.length, contents);
    assert.deepEqual(result.comments, []);
  }
});

test("reserved whole-line markers are parsed regardless of surrounding source syntax", () => {
  const contents = [
    `const x = "${start()}";`,
    "/*",
    start("Inside block", other),
    "block contents",
    "*/",
    `const y = 1; ${start()}`,
    "// Ordinary JJ-STAMP text is not reserved.",
    start(),
    "const z = 1;",
    "",
  ].join("\n");
  const result = parseReviewComments("main.ts", contents);
  assert.equal(result.editable, true);
  assert.deepEqual(
    result.comments.map((comment) => comment.startLine),
    [3, 8],
  );
  assert.equal(containsReviewMarkers(contents), true);
  assert.equal(containsReviewMarkers("ordinary source"), false);
  assert.equal(containsReviewMarkers("const name = 'JJ-STAMP';\n"), false);
  assert.equal(containsReviewMarkers("// Ordinary JJ-STAMP prose\n"), false);
  for (const separator of ["\u2028", "\u2029"])
    assert.equal(
      containsReviewMarkers(`text${separator}// JJ-STAMP(bad)\n`),
      false,
      "Unicode separators do not introduce a physical annotation line",
    );
  assert.equal(containsReviewMarkers("  //JJ-STAMP(bad): reserved\n"), true);
  assert.equal(
    containsReviewMarkers("const x = `example\n// JJ-STAMP(bad)\n`;\n"),
    true,
  );
});

const syntaxCases = [
  [
    "main.rs",
    `fn borrow<'a>(value: &'a str) -> &'a str {\n    let raw = r##"first\nsecond"##;\n    /* nested /* comment */ contents */\n    let half = 2 / 3;\n    value\n}\n`,
  ],
  [
    "main.ts",
    "const x = `template\ntext`;\nconst pattern = /regex/;\nconst half = 2 / 3;\n",
  ],
  ["main.tsx", "<div>\n  text\n</div>\n"],
  [
    "main.cpp",
    'auto x = R"(raw\nstring)";\n// continued\\\ncode\n// C trigraph ??/\n',
  ],
  ["main.py", 'text = """first\nsecond\n"""\n# comment\n'],
  ["script.sh", "cat <<EOF\nheredoc contents\nEOF\n"],
  ["data.json", '{\n  "key": "value"\n}\n'],
  ["README.md", "# Markdown\n```rust\nlet value = 1;\n```\n"],
  ["Makefile", "target:\n\tprintf 'hello'\n"],
  ["no-extension", "text with \u2028 and \u2029 separators\n"],
  ["unknown.xyz", '"unterminated\n/* unterminated\n'],
];

for (const [file, contents] of syntaxCases) {
  test(`annotation CRUD and projection are source-syntax agnostic: ${file}`, () => {
    const original = Buffer.from(contents);
    const body =
      '```rust\n\tlet raw = r#"*/\u2028\u2029"#; // ??/\ntrailing \\\n```';
    assert.equal(parseReviewComments(file, contents).editable, true);
    // Exercise insertion inside literals, block comments and every other line,
    // not just at a syntax-neutral file boundary.
    for (let line = 1; line <= contents.split("\n").length - 1; line++) {
      const mutation = {
        ...input,
        path: file,
        action: "add" as const,
        line,
        body,
      };
      validateCommentMutation(mutation);
      const added = mutateReviewComments(file, original, mutation);
      const projected = projectCommentsFile(file, added);
      assert.deepEqual(projected.clean, original);
      assert.equal(projected.cleanComments[0].body, body);
      assert.equal(projected.cleanComments[0].startLine, line);
      const id = projected.cleanComments[0].id;
      const edited = mutateReviewComments(file, added, {
        ...input,
        path: file,
        action: "edit",
        id,
        body: "Changed \\",
      });
      assert.equal(
        projectCommentsFile(file, edited).cleanComments[0].body,
        "Changed \\",
      );
      const removed = mutateReviewComments(file, edited, {
        ...input,
        path: file,
        action: "remove",
        id,
      });
      assert.deepEqual(removed, original);
    }
  });
}

test("comment bodies accept tabs and Unicode text but reject controls and lossy surrogate encoding", () => {
  for (const body of [
    "",
    " \t\n",
    "nul\0",
    "control\b",
    "CR\r\n",
    "\ud800",
    "\udc00",
  ])
    assert.throws(() =>
      validateCommentMutation({ ...input, action: "add", line: 1, body }),
    );
  validateCommentMutation({
    ...input,
    action: "add",
    line: 1,
    body: "Tabs\tand Unicode\u2028\u2029 😀",
  });
});

test("CRUD preserves source bytes, CRLF, body lines, indentation and paired range end", () => {
  const original = Buffer.from("  const a = 1;\r\n  const b = 2;\r\n");
  const added = mutateReviewComments(input.path, original, {
    ...input,
    action: "add",
    line: 1,
    endLine: 2,
    body: "First\nSecond",
  });
  const comment = parseReviewComments(input.path, added.toString()).comments[0];
  assert.ok(comment);
  assert.equal(comment.endAnchorLine, 4);
  assert.equal(added.toString().replaceAll("\r\n", "").includes("\n"), false);
  const edited = mutateReviewComments(input.path, added, {
    ...input,
    action: "edit",
    id: comment.id,
    body: "Changed",
  });
  assert.equal(
    parseReviewComments(input.path, edited.toString()).comments[0].body,
    "Changed",
  );
  const removed = mutateReviewComments(input.path, edited, {
    ...input,
    action: "remove",
    id: comment.id,
  });
  assert.deepEqual(removed, original);
});

test("mutation rejects lossy bytes, mixed newlines, marker targets and overlapping annotations", () => {
  for (const bytes of [
    Buffer.from([0xff, 0x0a]),
    Buffer.from("code\0\n"),
    Buffer.from("\ufeffcode\n"),
    Buffer.from("code"),
    Buffer.from("code\r\ncode\n"),
  ]) {
    assert.throws(() =>
      mutateReviewComments(input.path, bytes, {
        ...input,
        action: "add",
        line: 1,
        body: "Review",
      }),
    );
  }
  const annotated = Buffer.from(`${start()}\ncode\n`);
  for (const line of [1, 2])
    assert.throws(() =>
      mutateReviewComments(input.path, annotated, {
        ...input,
        action: "add",
        line,
        body: "Overlapping",
      }),
    );
  const malformed = Buffer.from(`// JJ-STAMP(bad): keep this\ncode\n`);
  assert.throws(() =>
    mutateReviewComments(input.path, malformed, {
      ...input,
      action: "remove",
      id,
    }),
  );
  assert.equal(malformed.toString(), "// JJ-STAMP(bad): keep this\ncode\n");
});
