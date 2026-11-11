import type { DiffFile, Row } from "../src/types";

interface NewlineCase {
  name: string;
  before: string;
  after: string;
  header: string;
  body: string;
  markers: { unified: number; split: number };
}

/** Patch terminators and file terminators are independent. Never trim these. */
export const newlineCases = [
  {
    name: "terminated",
    before: "old\n",
    after: "new\n",
    header: "@@ -1 +1 @@",
    body: "-old\n+new",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "unterminated-both",
    before: "old",
    after: "new",
    header: "@@ -1 +1 @@",
    body: "-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file",
    markers: { unified: 2, split: 2 },
  },
  {
    name: "add-final-newline",
    before: "same",
    after: "same\n",
    header: "@@ -1 +1 @@",
    body: "-same\n\\ No newline at end of file\n+same",
    markers: { unified: 1, split: 1 },
  },
  {
    name: "remove-final-newline",
    before: "same\n",
    after: "same",
    header: "@@ -1 +1 @@",
    body: "-same\n+same\n\\ No newline at end of file",
    markers: { unified: 1, split: 1 },
  },
  {
    name: "trailing-blank-lines",
    before: "old\n\n\n",
    after: "new\n\n\n",
    header: "@@ -1,3 +1,3 @@",
    body: "-old\n+new\n \n ",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "add-blank-line",
    before: "same\n",
    after: "same\n\n",
    header: "@@ -1 +1,2 @@",
    body: " same\n+",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "remove-blank-line",
    before: "same\n\n",
    after: "same\n",
    header: "@@ -1,2 +1 @@",
    body: " same\n-",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "unterminated-context",
    before: "old\nlast",
    after: "new\nlast",
    header: "@@ -1,2 +1,2 @@",
    body: "-old\n+new\n last\n\\ No newline at end of file",
    markers: { unified: 1, split: 2 },
  },
  {
    name: "blank-file",
    before: "",
    after: "\n",
    header: "@@ -0,0 +1 @@",
    body: "+",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "delete-blank-file",
    before: "\n",
    after: "",
    header: "@@ -1 +0,0 @@",
    body: "-",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "unterminated-old-with-extra-new-lines",
    before: "same",
    after: "same\n\n\n",
    header: "@@ -1 +1,3 @@",
    body: "-same\n\\ No newline at end of file\n+same\n+\n+",
    markers: { unified: 1, split: 1 },
  },
  {
    name: "unterminated-new-with-extra-old-lines",
    before: "same\n\n\n",
    after: "same",
    header: "@@ -1,3 +1 @@",
    body: "-same\n-\n-\n+same\n\\ No newline at end of file",
    markers: { unified: 1, split: 1 },
  },
  {
    name: "crlf",
    before: "old\r\n",
    after: "new\r\n",
    header: "@@ -1 +1 @@",
    body: "-old\r\n+new\r",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "trailing-spaces",
    before: "old  \n",
    after: "new  \n",
    header: "@@ -1 +1 @@",
    body: "-old  \n+new  ",
    markers: { unified: 0, split: 0 },
  },
  {
    name: "literal-cr-at-eof",
    before: "old\r",
    after: "new\r",
    header: "@@ -1 +1 @@",
    body: "-old\r\n\\ No newline at end of file\n+new\r\n\\ No newline at end of file",
    markers: { unified: 2, split: 2 },
  },
  {
    name: "literal-cr-at-context-eof",
    before: "old\nlast\r",
    after: "new\nlast\r",
    header: "@@ -1,2 +1,2 @@",
    body: "-old\n+new\n last\r\n\\ No newline at end of file",
    markers: { unified: 1, split: 2 },
  },
  {
    name: "leading-and-trailing-blanks",
    before: "\nold\n\n",
    after: "\nnew\n\n\n",
    header: "@@ -1,3 +1,4 @@",
    body: " \n-old\n+new\n \n+",
    markers: { unified: 0, split: 0 },
  },
] as const;

export function newlineFile(
  scenario: NewlineCase,
  transportLF: boolean,
): DiffFile {
  const path = "newline-fixture.txt";
  let oldLine = 1,
    newLine = 1;
  const rows: Row[] = [];
  for (const raw of scenario.body.split("\n")) {
    if (raw.startsWith("\\")) {
      rows.at(-1)!.noNewline = true;
      continue;
    }
    rows.push({
      index: rows.length + 1,
      raw,
      ...(raw.startsWith("+") ? {} : { oldLine: oldLine++ }),
      ...(raw.startsWith("-") ? {} : { newLine: newLine++ }),
    });
  }
  return {
    path,
    additions: rows.filter((row) => row.raw.startsWith("+")).length,
    deletions: rows.filter((row) => row.raw.startsWith("-")).length,
    hunks: [{ id: "eof", header: scenario.header, rows }],
    patch: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${scenario.header}\n${scenario.body}${transportLF ? "\n" : ""}`,
  };
}
