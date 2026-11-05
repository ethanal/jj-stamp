import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PrReviewStore, type PrMetadata } from "../server/pr-review-store.ts";
import type { PrRepository } from "../src/pr-review-types.ts";

function repository(host = "github.com"): PrRepository {
  return {
    owner: "Test-Owner",
    name: "Test-Repo",
    nameWithOwner: "Test-Owner/Test-Repo",
    url: `https://${host}/Test-Owner/Test-Repo`,
  };
}

function metadata(repo: PrRepository): PrMetadata {
  const sourceChangeId = "k".repeat(32);
  const reviewedChangeId = "l".repeat(32);
  return {
    schema: 2,
    repository: repo,
    pullRequest: {
      number: 7,
      title: "Archived review",
      url: `${repo.url}/pull/7`,
      state: "OPEN",
      isDraft: false,
      headRefName: "feature",
      baseRefName: "main",
      headRefOid: "a".repeat(40),
      baseRefOid: "b".repeat(40),
      author: { login: "reviewer" },
    },
    mergeBaseOid: "c".repeat(40),
    headTreeOid: "d".repeat(40),
    sourceChangeId,
    reviewedChangeId,
    branches: [
      { codeChangeId: sourceChangeId, commentsChangeId: "m".repeat(32) },
      { codeChangeId: reviewedChangeId, commentsChangeId: "n".repeat(32) },
    ],
  };
}

function key(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

test("legacy github.com archives retain their exact keys and reservation filenames", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const store = new PrReviewStore(dataHome);
  const repo = repository();
  const legacyIdentity = "test-owner/test-repo#7";
  const legacyKey = key(legacyIdentity);
  const directory = path.join(store.root, legacyKey);
  const workspace = path.join(directory, "workspace");
  const marker = path.join(store.root, ".known", legacyKey);
  const archived = `${JSON.stringify(metadata(repo), null, 2)}\n`;
  await mkdir(workspace, { recursive: true });
  await mkdir(path.dirname(marker));
  await writeFile(marker, `${legacyIdentity}\n`);
  await writeFile(path.join(directory, "review.json"), archived);
  await writeFile(path.join(workspace, "comments.txt"), "existing comments\n");

  const archive = await store.acquire(repo, 7);
  try {
    assert.equal(archive.fresh, false);
    assert.equal(archive.directory, directory);
    assert.deepEqual(await archive.read(), metadata(repo));
    assert.equal(await readFile(marker, "utf8"), `${legacyIdentity}\n`);
    assert.equal(
      await readFile(path.join(directory, "review.json"), "utf8"),
      archived,
    );
    assert.equal(
      await readFile(path.join(workspace, "comments.txt"), "utf8"),
      "existing comments\n",
    );
    await assert.rejects(store.acquire(repo, 7), /locked/);
  } finally {
    await archive.release();
  }

  const fresh = await store.acquire(repo, 8);
  try {
    assert.equal(fresh.fresh, true);
    assert.equal(
      fresh.directory,
      path.join(store.root, key("test-owner/test-repo#8")),
    );
    assert.equal(
      await readFile(
        path.join(store.root, ".known", key("test-owner/test-repo#8")),
        "utf8",
      ),
      "test-owner/test-repo#8\n",
    );
  } finally {
    await fresh.release();
  }
});

test("public GitHub and two enterprise hosts keep identical PR names in distinct archives and locks", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const store = new PrReviewStore(dataHome);
  const hosts = ["github.com", "ghe-one.example.com", "ghe-two.example.com"];
  const archives = [];
  try {
    for (const host of hosts) {
      const repo = repository(host);
      const archive = await store.acquire(repo, 7);
      archives.push(archive);
      assert.equal(archive.fresh, true);
      const identity = `${host === "github.com" ? "" : `${host}/`}test-owner/test-repo#7`;
      assert.equal(archive.directory, path.join(store.root, key(identity)));
      assert.equal(
        await readFile(path.join(store.root, ".known", key(identity)), "utf8"),
        `${identity}\n`,
      );
      await mkdir(archive.workspace);
      await archive.create(metadata(repo));
      await writeFile(path.join(archive.workspace, "comments.txt"), host);
      assert.deepEqual(await archive.read(), metadata(repo));
    }
    assert.equal(new Set(archives.map((archive) => archive.directory)).size, 3);
    for (const host of hosts)
      await assert.rejects(store.acquire(repository(host), 7), /locked/);
    for (const archive of archives)
      assert.equal(
        await readFile(path.join(archive.directory, "active.lock"), "utf8"),
        `${process.pid}\n`,
      );
  } finally {
    for (const archive of archives) await archive.release();
  }
  assert.equal((await readdir(path.join(store.root, ".known"))).length, 3);
  for (const host of hosts) {
    const archive = await store.acquire(repository(host), 7);
    try {
      assert.equal(archive.fresh, false);
      assert.deepEqual(await archive.read(), metadata(repository(host)));
      assert.equal(
        await readFile(path.join(archive.workspace, "comments.txt"), "utf8"),
        host,
      );
    } finally {
      await archive.release();
    }
  }
});

test("foreign-host archive metadata fails closed even when both URLs consistently identify the foreign host", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const store = new PrReviewStore(dataHome);
  for (const host of ["github.com", "ghe-one.example.com"]) {
    const repo = repository(host);
    const archive = await store.acquire(repo, 7);
    await mkdir(archive.workspace);
    const original = metadata(repo);
    await archive.create(original);
    const comments = path.join(archive.workspace, "comments.txt");
    await writeFile(comments, "irreplaceable review comments\n");
    await archive.release();

    const metadataPath = path.join(archive.directory, "review.json");
    // Both records remain schema-valid and internally consistent. Only their
    // host is foreign to the requested archive identity.
    const foreign = metadata(repository("ghe-two.example.com"));
    const corrupted = `${JSON.stringify(foreign, null, 2)}\n`;
    await writeFile(metadataPath, corrupted);
    for (let attempt = 0; attempt < 2; attempt++) {
      const reopened = await store.acquire(repo, 7);
      try {
        assert.equal(reopened.fresh, false);
        assert.equal(reopened.directory, archive.directory);
        await assert.rejects(reopened.read(), /corrupt.*not recreated/);
        assert.equal(await readFile(metadataPath, "utf8"), corrupted);
        assert.equal(
          await readFile(comments, "utf8"),
          "irreplaceable review comments\n",
        );
        await assert.rejects(reopened.create(original), { code: "EEXIST" });
      } finally {
        await reopened.release();
      }
    }
    // Manual restoration, not an automatic reset, makes the original usable.
    await writeFile(metadataPath, `${JSON.stringify(original, null, 2)}\n`);
    const restored = await store.acquire(repo, 7);
    try {
      assert.deepEqual(await restored.read(), original);
      assert.equal(
        await readFile(comments, "utf8"),
        "irreplaceable review comments\n",
      );
    } finally {
      await restored.release();
    }
  }
});

test("invalid repository identities are rejected before creating storage or reservations", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const store = new PrReviewStore(dataHome);
  for (const repo of [
    { ...repository(), url: "not a URL" },
    { ...repository(), url: "http://github.com/Test-Owner/Test-Repo" },
    { ...repository(), url: `${repository().url}?query` },
    { ...repository(), nameWithOwner: "different/repo" },
  ]) {
    await assert.rejects(store.acquire(repo, 7));
    await assert.rejects(lstat(store.root), { code: "ENOENT" });
  }
});
