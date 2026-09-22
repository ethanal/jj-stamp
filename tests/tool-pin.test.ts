import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const hunkPackage = await readFile(
  new URL("../nix/jj-hunk-tool.nix", import.meta.url),
  "utf8",
);
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");

test("hunk tool source and Cargo dependencies are fixed, not moving targets", () => {
  assert.match(hunkPackage, /rev = "[a-f0-9]{40}";/);
  assert.match(hunkPackage, /\bhash = "sha256-[A-Za-z0-9+/]{43}=";/);
  assert.match(hunkPackage, /\bcargoHash = "sha256-[A-Za-z0-9+/]{43}=";/);
});

test("non-Nix install guidance uses the same locked revision and custom source patch", () => {
  const revision = hunkPackage.match(/rev = "([a-f0-9]{40})";/)?.[1];
  assert.ok(revision, "Nix must pin a full commit ID");
  const checkout = readme.match(
    /git -C "\$hunk_src" checkout --detach ([a-f0-9]{40})/,
  );
  assert.ok(checkout, "document the exact upstream checkout");
  assert.equal(checkout[1], revision);
  assert.match(
    readme,
    /cargo install --path "\$hunk_src" --locked jj-hunk-tool/,
  );
  assert.match(
    readme,
    /git -C "\$hunk_src" apply "\$stamp_checkout\/nix\/jj-hunk-tool-context\.patch"/,
  );
  assert.match(hunkPackage, /patches = \[ \.\/jj-hunk-tool-context\.patch \];/);
});

test("Nix launcher pins the same wrapped hunk tool used in error diagnostics", async () => {
  const launcher = await readFile(
    new URL("../nix/package.nix", import.meta.url),
    "utf8",
  );
  assert.match(
    launcher,
    /--set JJ_STAMP_HUNK_TOOL \$\{lib\.getExe jj-hunk-tool\}/,
  );
});
