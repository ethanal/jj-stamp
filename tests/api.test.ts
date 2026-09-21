import assert from "node:assert/strict";
import test from "node:test";
import { api, RequestError, errorDetails } from "../src/api.ts";

test("API failures preserve the code and complete multiline tool output", async (t) => {
  const output =
    "Inspecting file\npatch: hunk FAILED at 42\n<error>literal text</error>\n";
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: string, options: RequestInit) => {
      assert.equal(options.method, "POST");
      assert.equal(
        (options.headers as Record<string, string>)["X-Fold-Request"],
        "1",
      );
      return new Response(
        JSON.stringify({
          error: "Squash failed.",
          code: "TOOL_FAILED",
          output,
        }),
        { status: 500 },
      );
    },
  );
  await assert.rejects(
    api("squash-lines", { version: "test" }),
    (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.message, "Squash failed.");
      assert.equal(error.status, 500);
      assert.deepEqual(errorDetails(error, "Squash"), [
        { label: "Squash", code: "TOOL_FAILED", output },
      ]);
      return true;
    },
  );
});

test("plain-text HTTP failures preserve their response rather than reporting a JSON parse error", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("Proxy connection failed\nMore detail", { status: 502 }),
  );
  await assert.rejects(api("squash-lines", {}), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.match(error.message, /HTTP 502/);
    assert.equal(error.output, "Proxy connection failed\nMore detail");
    return true;
  });
});

test("malformed error fields use a meaningful fallback and never coerce objects into diagnostics", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response(
        JSON.stringify({ error: {}, code: [], output: { private: "value" } }),
        { status: 500 },
      ),
  );
  await assert.rejects(api("squash-lines", {}), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.match(error.message, /HTTP 500/);
    assert.deepEqual(errorDetails(error), []);
    return true;
  });
});

test("successful HTTP responses still require valid JSON", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () => new Response("not json", { status: 200 }),
  );
  await assert.rejects(api("state"), (error: unknown) => {
    assert.ok(error instanceof RequestError);
    assert.equal(error.message, "Invalid JSON response from state.");
    assert.equal(error.status, 200);
    assert.equal(error.output, "not json");
    assert.deepEqual(errorDetails(error), [
      { label: "Request", code: undefined, output: "not json" },
    ]);
    return true;
  });
});

test("API successes and network errors keep their normal behavior", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(JSON.stringify({ ok: true })),
  );
  assert.deepEqual(await api("state"), { ok: true });
  const offline = new TypeError("Failed to fetch");
  fetch.mock.mockImplementation(async () => {
    throw offline;
  });
  await assert.rejects(api("state"), (error) => error === offline);
  assert.deepEqual(errorDetails(offline), []);
});
