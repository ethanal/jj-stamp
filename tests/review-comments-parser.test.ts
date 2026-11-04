import test from "node:test";
import assert from "node:assert/strict";
import {
  commentSyntax,
  containsReviewMarkers,
  parseReviewComments,
} from "../src/review-comments.ts";
import { mutateReviewComments } from "../server/review-comments.ts";

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

test("only whole-line canonical opt-in markers outside strings/blocks are cards", () => {
  const contents = [
    `const x = "${start()}";`,
    "/*",
    start(),
    "*/",
    `const y = 1; ${start()}`,
    "// Ordinary JJ-STAMP text is not reserved.",
    start(),
    "const z = 1;",
    "",
  ].join("\n");
  const result = parseReviewComments("main.ts", contents);
  assert.equal(result.editable, true);
  assert.equal(result.comments.length, 1);
  assert.equal(result.comments[0].startLine, 7);
  assert.equal(containsReviewMarkers(contents), true);
  assert.equal(containsReviewMarkers("ordinary source"), false);
  assert.equal(containsReviewMarkers("const name = 'JJ-STAMP';\n"), false);
  assert.equal(containsReviewMarkers("// Ordinary JJ-STAMP prose\n"), false);
  assert.equal(containsReviewMarkers("  //JJ-STAMP(bad): reserved\n"), true);
  assert.equal(
    containsReviewMarkers("const x = `example\n// JJ-STAMP(bad)\n`;\n"),
    true,
  );
});

test("uncertain lexical constructs and unsupported languages disable editing rather than guessing", () => {
  for (const contents of [
    "const x = `template\ntext`;\n",
    "const x = /regex/;\n",
    "const x = 2 / 3;\n",
    'const x = "unterminated\n',
    "// continued\\\ncode\n",
    'const x = R"(raw\nstring)";\n',
    'let x = r#"raw"#;\n',
    "/* unterminated\n",
    "// C trigraph ??/\ncode\n",
    "const x = 1;\u2028code\n",
  ]) {
    const result = parseReviewComments("main.ts", contents);
    assert.equal(result.lexicalSafe, false, contents);
    assert.equal(result.editable, false);
    assert.deepEqual(result.comments, []);
  }
  assert.equal(
    parseReviewComments("main.tsx", "<div>text</div>\n").lexicalSafe,
    false,
  );
  for (const file of ["file.py", "script.sh", "data.json", "README.md"])
    assert.equal(commentSyntax(file), null);
  for (const file of [
    "file.ts",
    "file.mjs",
    "file.go",
    "file.rs",
    "file.cpp",
    "file.java",
  ])
    assert.equal(commentSyntax(file), "//");
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

test("mutation rejects lossy bytes, mixed newlines, marker targets, overlap and invisible block annotations", () => {
  for (const bytes of [
    Buffer.from([0xff, 0x0a]),
    Buffer.from("code\0\n"),
    Buffer.from("\ufeffcode\n"),
    Buffer.from("code"),
    Buffer.from("code\r\ncode\n"),
    Buffer.from("/*\ninside\n*/\n"),
  ]) {
    assert.throws(() =>
      mutateReviewComments(input.path, bytes, {
        ...input,
        action: "add",
        line: bytes.toString().startsWith("/*") ? 2 : 1,
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
