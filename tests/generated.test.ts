import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  generatedPaths,
  maxAttributeBytes,
  parseAttributeFiles,
} from "../server/generated.ts";
import { ReviewService } from "../server/service.ts";
import { jj } from "../server/process.ts";
import { createDemo } from "./fixtures.ts";

test("generated attributes obey root/nested/later precedence and true/false/unset states", () => {
  const paths = [
    "one.ts",
    "src/one.ts",
    "src/keep.ts",
    "src/unset.ts",
    "src/minus.ts",
    "src/deep/one.ts",
    "elsewhere/one.ts",
  ];
  assert.deepEqual(
    generatedPaths(paths, [
      {
        path: "src/.gitattributes",
        contents:
          "*.ts linguist-generated=true\nkeep.ts linguist-generated=false\nunset.ts !linguist-generated\nminus.ts -linguist-generated\n",
      },
      {
        path: ".gitattributes",
        contents: "*.ts linguist-generated\nelsewhere/** -linguist-generated\n",
      },
      {
        path: "src/deep/.gitattributes",
        contents: "*.ts linguist-generated=unknown\n",
      },
    ]),
    new Set(["one.ts", "src/one.ts"]),
  );
});

test("Git-style patterns include basename, anchors, globstar, escapes and ranges, not directory recursion", () => {
  const paths = [
    "a.gen",
    "a/a.gen",
    "root.txt",
    "a/root.txt",
    "dir/file",
    "dir/deep/file",
    "dir",
    "neg/one",
    "build/x/out.txt",
    "build/out.txt",
    "build/deep/x/out.txt",
    "escaped*.txt",
    "a1.txt",
    "aa.txt",
    "quoted.gen",
  ];
  const rules = `# comment
*.gen linguist-generated
/root.txt linguist-generated=true
dir/ linguist-generated
!neg/** linguist-generated
build/**/out.txt linguist-generated
escaped\\*.txt linguist-generated
a[0-9].txt linguist-generated
"quoted.gen" linguist-generated
`;
  assert.deepEqual(
    generatedPaths(paths, [{ path: ".gitattributes", contents: rules }]),
    new Set([
      "a.gen",
      "a/a.gen",
      "root.txt",
      "build/x/out.txt",
      "build/out.txt",
      "build/deep/x/out.txt",
      "escaped*.txt",
      "a1.txt",
      "quoted.gen",
    ]),
  );
});

test("unsupported attributes and resource bounds leave files visible", () => {
  for (const contents of [
    "* linguist-generated\n[attr]generated linguist-generated\n",
    "* linguist-generated\n[[:alpha:]] -linguist-generated\n",
    "* linguist-generated\n" + "x".repeat(maxAttributeBytes),
    "*".repeat(1025) + " linguist-generated\n",
  ]) {
    assert.deepEqual(
      generatedPaths(["output.txt"], [{ path: ".gitattributes", contents }]),
      new Set(),
    );
  }
  assert.deepEqual(parseAttributeFiles(["file:.gitattributes"]), [
    ".gitattributes",
  ]);
  assert.equal(parseAttributeFiles(["conflict:.gitattributes"]), null);
  assert.equal(parseAttributeFiles(["file:../.gitattributes"]), null);
  assert.equal(
    parseAttributeFiles(Array(257).fill("file:.gitattributes")),
    null,
  );
});

test("C-quoted octals/escapes and adversarial wildcard work stay bounded", () => {
  assert.deepEqual(
    generatedPaths(
      ["space name.gen", 'quote".gen', "é.gen", "tab\tname.gen"],
      [
        {
          path: ".gitattributes",
          contents:
            '"space\\040name.gen" linguist-generated\n' +
            '"quote\\".gen" linguist-generated\n' +
            '"\\303\\251.gen" linguist-generated\n' +
            '"tab\\tname.gen" linguist-generated\n',
        },
      ],
    ),
    new Set(["space name.gen", 'quote".gen', "é.gen", "tab\tname.gen"]),
  );
  const star = "*a".repeat(200) + "b";
  assert.deepEqual(
    generatedPaths(
      ["a".repeat(200) + "c"],
      [
        {
          path: ".gitattributes",
          contents: `${star} linguist-generated\n`,
        },
      ],
    ),
    new Set(),
  );
  assert.deepEqual(
    generatedPaths(
      ["visible"],
      [
        {
          path: ".gitattributes",
          contents: "* linguist-generated\n".repeat(4097),
        },
      ],
    ),
    new Set(),
  );
  // Exhaust the shared matching budget after a positive match: no partial
  // classification may survive an uncertain later override.
  assert.deepEqual(
    generatedPaths(
      ["a".repeat(200) + "c"],
      [
        {
          path: ".gitattributes",
          contents:
            "* linguist-generated\n" +
            `${star} -linguist-generated\n`.repeat(80),
        },
      ],
    ),
    new Set(),
  );
});

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "jj-generated-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return createDemo(dir);
}
function marked(content: { files: { path: string; generated?: boolean }[] }) {
  return content.files
    .filter((file) => file.generated)
    .map((file) => file.path)
    .sort();
}

test("real jj live attributes follow snapshots, nested overrides, and pinned history survives edits/rewrites", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, ".gitattributes"),
    "*.ts linguist-generated\n",
  );
  await writeFile(
    path.join(root, "src/.gitattributes"),
    "preferences.ts linguist-generated=false\n",
  );
  const calls: string[][] = [];
  const service = new ReviewService({
    repoPath: root,
    jjRunner: (cwd, args, limits) => {
      calls.push(args);
      return jj(cwd, args, limits);
    },
  });
  const first = await service.getState();
  const listing = calls.find(
    (args) => args[0] === "file" && args[1] === "list",
  )!;
  assert.ok(listing.includes("--ignore-working-copy"));
  assert.equal(
    listing[listing.indexOf("-r") + 1],
    `commit_id("${first.source.commitId}")`,
  );
  assert.deepEqual(listing.slice(listing.indexOf("--") + 1).sort(), [
    'root-file:".gitattributes"',
    'root-file:"src/.gitattributes"',
    'root-file:"tests/.gitattributes"',
  ]);
  assert.deepEqual(marked(first), [
    "src/notifications.ts",
    "tests/notifications.test.ts",
  ]);
  const coldHistory = await new ReviewService({ repoPath: root }).getCommit({
    commitId: first.source.commitId,
  });
  assert.deepEqual(coldHistory.files, first.files);
  calls.length = 0;
  assert.deepEqual(await service.getState(), first);
  assert.equal(calls.length, 4, "warm attributes and diff are commit-keyed");
  await writeFile(
    path.join(root, "src/.gitattributes"),
    "*.ts !linguist-generated\n",
  );
  await writeFile(
    path.join(root, ".gitattributes"),
    "*.ts linguist-generated=false\n",
  );
  const second = await service.getState();
  assert.notEqual(second.source.commitId, first.source.commitId);
  assert.deepEqual(marked(second), []);
  // A fresh service cannot accidentally reuse the prior classification/cache.
  const hiddenHistory = await new ReviewService({ repoPath: root }).getCommit({
    commitId: first.source.commitId,
  });
  assert.deepEqual(hiddenHistory.files, first.files);
  const selected = await service.selectRevision({
    version: second.version,
    changeId: first.parent!.changeId,
  });
  assert.deepEqual(
    marked(selected.state),
    [],
    "old source has no versioned attrs",
  );
});

test("deleted paths use source attributes; deleted attribute files are not resurrected from the parent", async (t) => {
  const root = await fixture(t);
  await writeFile(
    path.join(root, ".gitattributes"),
    "*.ts linguist-generated\n",
  );
  await jj(root, ["commit", "-m", "Attributes baseline"]);
  await rm(path.join(root, "src/notifications.ts"));
  const service = new ReviewService({ repoPath: root });
  const deleted = await service.getState();
  assert.deepEqual(marked(deleted), ["src/notifications.ts"]);
  assert.equal(
    (await service.getCommit({ commitId: deleted.source.commitId })).files.find(
      (file) => file.path === "src/notifications.ts",
    )?.generated,
    true,
  );
  await rm(path.join(root, ".gitattributes"));
  assert.deepEqual(marked(await service.getState()), []);
});

test("nested-only attributes, literal paths, symlink attrs and detection failures remain safe", async (t) => {
  const root = await fixture(t);
  await mkdir(path.join(root, "src/deep"));
  await writeFile(
    path.join(root, "src/deep/.gitattributes"),
    "*.ts linguist-generated\n",
  );
  await writeFile(path.join(root, "outside-attrs"), "* linguist-generated\n");
  await symlink("outside-attrs", path.join(root, ".gitattributes"));
  await writeFile(path.join(root, "src/deep/output.ts"), "generated\n");
  const service = new ReviewService({ repoPath: root });
  const state = await service.getState();
  assert.deepEqual(marked(state), ["src/deep/output.ts"]);
  const failed = new ReviewService({
    repoPath: root,
    jjRunner: (cwd, args, limits) => {
      if (args[0] === "file" && args[1] === "show")
        throw new Error("unavailable attribute read");
      return jj(cwd, args, limits);
    },
  });
  assert.deepEqual(marked(await failed.getState()), []);
});
