import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { shellExecutable } from "../server/shell.ts";

function environment(t: TestContext, value: string | undefined) {
  const previous = process.env.SHELL;
  if (value === undefined) delete process.env.SHELL;
  else process.env.SHELL = value;
  t.after(() => {
    if (previous === undefined) delete process.env.SHELL;
    else process.env.SHELL = previous;
  });
}

test("explicit executable wins; default uses backend SHELL literally without account lookup", (t) => {
  environment(t, "/backend/env shell");
  t.mock.method(os, "userInfo", () => {
    throw new Error("account lookup must not be used");
  });
  assert.equal(shellExecutable("/configured/shell"), "/configured/shell");
  assert.equal(shellExecutable(""), "/backend/env shell");
});

test("unset and empty SHELL use the backend account shell", (t) => {
  environment(t, undefined);
  t.mock.method(os, "userInfo", () => ({ shell: "/account/login-shell" }));
  assert.equal(shellExecutable(""), "/account/login-shell");
  process.env.SHELL = "";
  assert.equal(shellExecutable(""), "/account/login-shell");
});

test("missing or unavailable account shell uses /bin/sh", (t) => {
  environment(t, undefined);
  const account = t.mock.method(os, "userInfo", () => ({ shell: "" }));
  assert.equal(shellExecutable(""), "/bin/sh");
  account.mock.mockImplementation(() => {
    throw new Error("no passwd entry");
  });
  assert.equal(shellExecutable(""), "/bin/sh");
});

test("invalid explicit, environment and account values error rather than fall back", (t) => {
  environment(t, "/bin/sh");
  const account = t.mock.method(os, "userInfo", () => ({ shell: "/bin/sh" }));
  for (const value of [
    "bad\nshell",
    "bad\rshell",
    "bad\0shell",
    "x".repeat(4097),
  ]) {
    assert.throws(() => shellExecutable(value), /Invalid shell executable/);
    process.env.SHELL = value.includes("\0") ? "bad\nshell" : value;
    assert.throws(() => shellExecutable(""), /Invalid shell executable/);
    delete process.env.SHELL;
    account.mock.mockImplementation(() => ({ shell: value }));
    assert.throws(() => shellExecutable(""), /Invalid shell executable/);
  }
});
