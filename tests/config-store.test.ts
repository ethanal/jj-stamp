import test from "node:test";
import assert from "node:assert/strict";
import { ConfigStore } from "../src/config-store.ts";
import { defaultConfig, type Config } from "../src/config.ts";
import { RequestError } from "../src/api.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  let receive!: (config: Config) => void;
  let fail!: (message: string, code?: string) => void;
  let disconnects = 0;
  const requests: Partial<Config>[] = [];
  const responses: ReturnType<typeof deferred<Config>>[] = [];
  const resets: ReturnType<
    typeof deferred<{ config: Config; backup: string }>
  >[] = [];
  let nextRequest = deferred<void>();
  const store = new ConfigStore(
    {
      listen(onConfig, onError) {
        receive = onConfig;
        fail = onError;
        return () => disconnects++;
      },
      save(patch) {
        requests.push({ ...patch });
        const response = deferred<Config>();
        responses.push(response);
        nextRequest.resolve();
        nextRequest = deferred<void>();
        return response.promise;
      },
      resetInvalid() {
        const response = deferred<{ config: Config; backup: string }>();
        resets.push(response);
        return response.promise;
      },
    },
    0,
  );
  const unsubscribe = store.subscribe(() => {});
  return {
    store,
    requests,
    responses,
    receive: (patch: Partial<Config>) =>
      receive({ ...defaultConfig, ...patch }),
    fail: (message: string, code?: string) => fail(message, code),
    resets,
    nextRequest: () => nextRequest.promise,
    disconnects: () => disconnects,
    unsubscribe,
  };
}

test("initial/default and incoming disk snapshots never write preferences back", () => {
  const f = fixture();
  assert.equal(f.store.getSnapshot().loaded, false);
  f.receive({ "font-size": 19, "vim-mode": true, "diff-style": "split" });
  assert.equal(f.store.getSnapshot().loaded, true);
  assert.equal(f.store.getSnapshot().config["font-size"], 19);
  f.receive({ "files-expanded": false });
  assert.equal(f.store.getSnapshot().config["font-size"], 13);
  assert.equal(f.store.getSnapshot().config["files-expanded"], false);
  assert.deepEqual(f.requests, []);
  f.unsubscribe();
  assert.equal(f.disconnects(), 1);
});

test("coalesces explicit edits, supports updater functions, and sends only changed keys", async () => {
  const f = fixture();
  f.receive({ "font-size": 18 });
  const started = f.nextRequest();
  f.store.set("files-expanded", (value) => !value);
  f.store.set("files-width", 300);
  f.store.set("files-width", 320);
  assert.equal(f.store.getSnapshot().config["files-width"], 320);
  assert.equal(f.store.getSnapshot().saving, true);
  await started;
  assert.deepEqual(f.requests, [
    { "files-expanded": false, "files-width": 320 },
  ]);
  f.responses[0].resolve({
    ...defaultConfig,
    "font-size": 18,
    "files-expanded": false,
    "files-width": 320,
  });
  await f.responses[0].promise;
  assert.equal(f.store.getSnapshot().saving, false);
  assert.equal(f.store.getSnapshot().config["font-size"], 18);
  assert.equal(f.store.getSnapshot().config["files-width"], 320);
  f.unsubscribe();
});

test("remote snapshots cannot clobber in-flight/newer local edits, and saves serialize", async () => {
  const f = fixture();
  let started = f.nextRequest();
  f.store.set("font-size", 15);
  await started;
  f.receive({ "font-size": 15, "color-scheme": "light" });
  started = f.nextRequest();
  f.store.set("font-size", 20);
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.getSnapshot().config["font-size"], 20);
  assert.equal(f.store.getSnapshot().config["color-scheme"], "light");
  // An old response must not overwrite the newer SSE snapshot.
  f.responses[0].resolve({ ...defaultConfig, "font-size": 15 });
  await started;
  assert.deepEqual(f.requests[1], { "font-size": 20 });
  f.responses[1].resolve({
    ...defaultConfig,
    "font-size": 20,
    "color-scheme": "light",
  });
  await f.responses[1].promise;
  assert.equal(f.store.getSnapshot().config["font-size"], 20);
  assert.equal(f.store.getSnapshot().config["color-scheme"], "light");
  f.unsubscribe();
});

test("failed writes revert their overlay, report unsaved settings, and never retry", async () => {
  const f = fixture();
  f.receive({ "font-size": 16 });
  const started = f.nextRequest();
  f.store.set("font-size", 22);
  await started;
  f.responses[0].reject(new Error("The config file is invalid."));
  await assert.rejects(f.responses[0].promise);
  assert.equal(f.store.getSnapshot().config["font-size"], 16);
  assert.equal(f.store.getSnapshot().saving, false);
  assert.match(
    f.store.getSnapshot().error,
    /Settings save could not be confirmed:.*invalid/,
  );
  f.receive({ "font-size": 17 });
  assert.equal(f.requests.length, 1);
  assert.equal(f.store.getSnapshot().config["font-size"], 17);
  f.unsubscribe();
});

test("stream errors preserve the last valid settings and clear after reconnection", () => {
  const f = fixture();
  f.receive({ "vim-mode": true });
  f.fail("Invalid config file.");
  assert.equal(f.store.getSnapshot().config["vim-mode"], true);
  assert.equal(f.store.getSnapshot().error, "Invalid config file.");
  f.receive({ "vim-mode": false });
  assert.equal(f.store.getSnapshot().error, "");
  assert.equal(f.store.getSnapshot().config["vim-mode"], false);
  const unsubscribe2 = f.store.subscribe(() => {});
  f.unsubscribe();
  assert.equal(f.disconnects(), 0);
  unsubscribe2();
  assert.equal(f.disconnects(), 1);
});

test("repairing an invalid file clears the stale save failure without replaying the failed edit", async () => {
  const f = fixture();
  f.receive({ "font-size": 16 });
  f.fail("Invalid config file.", "CONFIG_INVALID");
  assert.equal(f.store.getSnapshot().canReset, true);
  const started = f.nextRequest();
  f.store.set("font-size", 22);
  assert.equal(f.store.getSnapshot().canReset, false);
  await started;
  f.responses[0].reject(
    new RequestError("Invalid config.", 409, "CONFIG_INVALID"),
  );
  await assert.rejects(f.responses[0].promise);
  assert.equal(f.store.getSnapshot().canReset, true);
  f.receive({ "font-size": 17 });
  assert.equal(f.store.getSnapshot().error, "");
  assert.equal(f.store.getSnapshot().canReset, false);
  assert.equal(f.store.getSnapshot().config["font-size"], 17);
  assert.equal(f.requests.length, 1);
  f.unsubscribe();
});

test("explicit invalid-file reset applies defaults, returns backup name, and allows subsequent edits", async () => {
  const f = fixture();
  f.receive({ "color-scheme": "light" });
  await assert.rejects(f.store.resetInvalid());
  assert.equal(f.resets.length, 0);
  f.fail("Invalid config file.", "CONFIG_INVALID");
  const reset = f.store.resetInvalid();
  assert.equal(f.resets.length, 1);
  assert.equal(f.store.getSnapshot().saving, true);
  assert.equal(f.store.getSnapshot().canReset, false);
  await assert.rejects(f.store.resetInvalid());
  // A later stream update must win over the reset HTTP response.
  f.receive({ "font-size": 18 });
  f.resets[0].resolve({
    config: defaultConfig,
    backup: "config.json.test.invalid.bak",
  });
  assert.equal(await reset, "config.json.test.invalid.bak");
  assert.equal(f.store.getSnapshot().config["font-size"], 18);
  assert.equal(f.store.getSnapshot().error, "");
  assert.equal(f.store.getSnapshot().saving, false);
  const started = f.nextRequest();
  f.store.set("vim-mode", true);
  await started;
  f.responses[0].resolve({
    ...defaultConfig,
    "font-size": 18,
    "vim-mode": true,
  });
  await f.responses[0].promise;
  assert.equal(f.store.getSnapshot().config["vim-mode"], true);
  f.unsubscribe();
});

test("failed recovery preserves the confirmed snapshot and is not retried", async () => {
  const f = fixture();
  f.receive({ "font-size": 19 });
  f.fail("Invalid config file.", "CONFIG_INVALID");
  const reset = f.store.resetInvalid();
  f.resets[0].reject(new RequestError("Backup failed.", 500, "CONFIG_IO"));
  await assert.rejects(reset, /Backup failed/);
  assert.equal(f.store.getSnapshot().config["font-size"], 19);
  assert.match(
    f.store.getSnapshot().error,
    /Settings reset could not be confirmed/,
  );
  assert.equal(f.store.getSnapshot().saving, false);
  assert.equal(f.resets.length, 1);
  assert.deepEqual(f.requests, []);
  f.unsubscribe();
});

test("reset response restores defaults even before the stream delivers recovery", async () => {
  const f = fixture();
  f.receive({ "font-size": 20, "vim-mode": true });
  f.fail("Invalid config file.", "CONFIG_INVALID");
  const reset = f.store.resetInvalid();
  f.resets[0].resolve({
    config: defaultConfig,
    backup: "config.json.test.invalid.bak",
  });
  await reset;
  assert.deepEqual(f.store.getSnapshot().config, defaultConfig);
  assert.equal(f.store.getSnapshot().error, "");
  assert.equal(f.store.getSnapshot().canReset, false);
  assert.equal(f.store.getSnapshot().saving, false);
  assert.deepEqual(f.requests, []);
  f.unsubscribe();
});
