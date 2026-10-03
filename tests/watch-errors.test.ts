import assert from "node:assert/strict";
import test from "node:test";
import { WatchError, watchFailure } from "../server/watch-errors.ts";

test("expected watcher failures carry their actionable diagnosis", () => {
  const error = new WatchError(
    "WATCH_DIRECTORY_LIMIT",
    "Directory limit 4096 exceeded.",
  );
  assert.deepEqual(watchFailure(error), {
    code: "WATCH_DIRECTORY_LIMIT",
    message: "Directory limit 4096 exceeded.",
  });
});

test("filesystem errors expose allowlisted codes, never raw error paths or messages", () => {
  for (const code of [
    "ENOSPC",
    "EMFILE",
    "ENFILE",
    "ENOENT",
    "ENOTDIR",
    "EACCES",
    "EPERM",
    "ELOOP",
    "ENOSYS",
    "ENOTSUP",
    "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM",
  ]) {
    const failure = watchFailure(
      Object.assign(new Error("private/path/secret"), {
        code,
        path: "/private/path",
      }),
    );
    assert.equal(failure.code, code);
    assert.ok(failure.message.length > 20);
    assert.doesNotMatch(JSON.stringify(failure), /private|secret/);
  }
});

test("unknown thrown values get a stable safe fallback, not arbitrary error content", () => {
  for (const value of [
    undefined,
    null,
    "private error",
    17,
    new Error("private path"),
    { code: "__proto__", message: "private path" },
    { code: "PRIVATE_CODE", path: "/secret" },
  ]) {
    const failure = watchFailure(value);
    assert.equal(failure.code, "WATCH_UNAVAILABLE");
    assert.match(failure.message, /terminal/);
    assert.doesNotMatch(JSON.stringify(failure), /private|PRIVATE|secret/);
  }
});
