import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (name: string) =>
  readFile(new URL(`../${name}`, import.meta.url), "utf8");

const [launcher, flake, build, cli, editor, runner] = await Promise.all([
  source("nix/package.nix"),
  source("flake.nix"),
  source("scripts/build.mjs"),
  source("cli.ts"),
  source("server/diff-editor.ts"),
  source("server/process.ts"),
]);

test("runtime packaging does not depend on jj-hunk-tool or GNU patch", () => {
  for (const text of [launcher, flake, build, cli, editor, runner]) {
    assert.doesNotMatch(text, /jj-hunk-tool|JJ_STAMP_HUNK_TOOL|gnupatch/);
  }
  assert.match(cli, /for \(const command of \["jj"\]\)/);
  assert.doesNotMatch(editor, /(?:spawn|execFile|run)\(\s*["']patch["']/);
});

test("Nix launcher pins jj for execution and error diagnostics", () => {
  assert.match(launcher, /--set JJ_STAMP_JJ \$\{lib\.getExe jujutsu\}/);
  assert.match(
    runner,
    /command === "jj" \? env\.JJ_STAMP_JJ \|\| command : command/,
  );
  assert.match(runner, /spawn\(executable, args/);
  assert.match(runner, /new ProcessError\(executable, args/);
});

test("build and Nix installation include the standalone native callback", () => {
  assert.match(build, /entryPoints: \["server\/diff-editor-cli\.ts"\]/);
  assert.match(build, /outfile: "dist\/diff-editor\.cjs"/);
  assert.match(build, /bundle: true/);
  assert.match(
    launcher,
    /cp dist\/cli\.cjs dist\/diff-editor\.cjs "\$out\/lib\/jj-stamp\/"/,
  );
  assert.match(editor, /path\.join\(__dirname, "diff-editor\.cjs"\)/);
  assert.match(
    editor,
    /merge-tools\.jj-stamp\.program=\$\{JSON\.stringify\(process\.execPath\)\}/,
  );
  assert.match(
    editor,
    /JSON\.stringify\(\[script, manifest, "\$left", "\$right"\]\)/,
  );
});
