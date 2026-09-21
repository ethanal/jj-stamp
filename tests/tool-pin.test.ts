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

test("non-Nix install guidance uses the same locked hunk-tool revision", () => {
  const revision = hunkPackage.match(/rev = "([a-f0-9]{40})";/)?.[1];
  assert.ok(revision, "Nix must pin a full commit ID");
  const install = readme.match(
    /cargo install --git https:\/\/github\.com\/mvzink\/jj-hunk-tool \\\n\s*--rev ([a-f0-9]{40}) --locked jj-hunk-tool/,
  );
  assert.ok(install, "document a locked, revision-pinned Cargo installation");
  assert.equal(install[1], revision);
});
