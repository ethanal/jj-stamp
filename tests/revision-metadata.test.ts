import assert from "node:assert/strict";
import test from "node:test";
import {
  parseGraphRevisionRecord,
  parseRevisionRecord,
  revisionFieldsTemplate,
  revisionTemplate,
} from "../server/revision.ts";

const identity = [
  "kkkkkkkkkkkk",
  "a".repeat(40),
  "description",
  "Author",
  "kkkkkkkk",
];
const row = (...values: unknown[]) =>
  values.map((value) => JSON.stringify(value)).join("\t");

test("revision metadata parsing shares one strict identity contract", () => {
  assert.deepEqual(
    parseRevisionRecord(row(...identity, true, false), 2, "identity", "flags"),
    {
      revision: {
        changeId: identity[0],
        commitId: identity[1],
        description: identity[2],
        author: identity[3],
        changeIdPrefix: identity[4],
      },
      flags: [true, false],
    },
  );
  assert.throws(
    () =>
      parseRevisionRecord(
        row("invalid", ...identity.slice(1), true, false),
        2,
        "identity",
        "flags",
      ),
    /identity/,
  );
  assert.throws(
    () => parseRevisionRecord(row(...identity, true), 2, "identity", "flags"),
    /flags/,
  );
  assert.throws(
    () =>
      parseRevisionRecord(
        row(...identity, true, "false"),
        2,
        "identity",
        "flags",
      ),
    /flags/,
  );
});

test("revision templates compose fields without string surgery", () => {
  assert.equal(revisionTemplate, revisionFieldsTemplate + ' ++ "\\n"');
  assert.match(revisionFieldsTemplate, /^json\(change_id\)/);
  assert.doesNotMatch(revisionFieldsTemplate, /\\n/);
});

test("graph bookmark metadata is a strict string list separate from revision identity", () => {
  for (const bookmarks of [
    [],
    ["main", "ethan/feature*", "topic@origin", '<tag>\t"quoted"'],
  ]) {
    const parsed = parseGraphRevisionRecord(
      row(...identity, true, false, false, bookmarks),
    );
    assert.deepEqual(parsed.bookmarks, bookmarks);
    assert.deepEqual(parsed.flags, [true, false, false]);
    assert.deepEqual(
      parsed.revision,
      parseRevisionRecord(row(...identity), 0, "identity").revision,
    );
  }
  for (const bookmarks of [null, "main", {}, [42], [null], [""]])
    assert.throws(
      () =>
        parseGraphRevisionRecord(
          row(...identity, true, false, false, bookmarks),
        ),
      /Unrecognized bookmarks/,
    );
  assert.throws(() =>
    parseGraphRevisionRecord(row(...identity, true, false, false)),
  );
  assert.throws(() =>
    parseGraphRevisionRecord(row(...identity, true, false, "false", [])),
  );
});
