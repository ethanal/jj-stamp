import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  metadataSchema,
  PrReviewStore,
  type PrMetadata,
} from "../server/pr-review-store.ts";
import type { PrRepository } from "../src/pr-review-types.ts";

function repository(host = "github.com"): PrRepository {
  return {
    owner: "Test-Owner",
    name: "Test-Repo",
    nameWithOwner: "Test-Owner/Test-Repo",
    url: `https://${host}/Test-Owner/Test-Repo`,
  };
}

function key(identity: string) {
  return createHash("sha256").update(identity).digest("hex");
}

function identity(repo = repository(), number = 7) {
  const host = new URL(repo.url).host;
  return `${host === "github.com" ? "" : `${host}/`}${repo.nameWithOwner.toLowerCase()}#${number}`;
}

function metadata(repo: PrRepository, sharedRepository: string): PrMetadata {
  const sourceChangeId = "k".repeat(32);
  const reviewedChangeId = "l".repeat(32);
  return {
    schema: 3,
    sharedRepository,
    workspaceName: `jj-stamp-pr-${key(identity(repo))}`,
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

async function sharedRepo(dataHome: string, clone = "clone") {
  const directory = path.join(dataHome, clone, ".jj", "repo");
  await mkdir(directory, { recursive: true });
  return directory;
}

async function fixture(t: TestContext) {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const sharedRepository = await sharedRepo(dataHome);
  return {
    dataHome,
    sharedRepository,
    store: new PrReviewStore(sharedRepository, dataHome),
    base: path.join(dataHome, "jj-stamp", "pr-reviews"),
  };
}

test("the same PR is scoped to each canonical shared repository, with private persistent reservations", async (t) => {
  const { dataHome, sharedRepository, store, base } = await fixture(t);
  const second = await sharedRepo(dataHome, "second-clone");
  const stores = [store, new PrReviewStore(second, dataHome)];
  const archives = [];
  try {
    for (const [index, current] of stores.entries()) {
      const shared = [sharedRepository, second][index];
      assert.equal(current.root, path.join(base, "workspaces", key(shared)));
      const archive = await current.acquire(repository(), 7);
      archives.push(archive);
      assert.equal(archive.fresh, true);
      assert.equal(archive.key, key("test-owner/test-repo#7"));
      assert.equal(archive.workspaceName, `jj-stamp-pr-${archive.key}`);
      assert.equal(archive.directory, path.join(current.root, archive.key));
      await mkdir(archive.workspace);
      await archive.create(metadata(repository(), shared));
      await writeFile(path.join(archive.workspace, "comments.txt"), shared);
      const marker = path.join(current.root, ".known", archive.key);
      assert.equal(await readFile(marker, "utf8"), "test-owner/test-repo#7\n");
      for (const file of [
        marker,
        path.join(archive.directory, "review.json"),
        path.join(archive.directory, "active.lock"),
      ])
        assert.equal((await lstat(file)).mode & 0o777, 0o600);
      assert.equal((await lstat(current.root)).mode & 0o777, 0o700);
      await assert.rejects(
        new PrReviewStore(shared, dataHome).acquire(repository(), 7),
        /locked/,
      );
    }
    assert.notEqual(archives[0].directory, archives[1].directory);
    await assert.rejects(lstat(path.join(base, ".known")), { code: "ENOENT" });
  } finally {
    for (const archive of archives) await archive.release();
  }
  for (const [index, current] of stores.entries()) {
    const shared = [sharedRepository, second][index];
    const resumed = await current.acquire(repository(), 7);
    try {
      assert.equal(resumed.fresh, false);
      assert.deepEqual(await resumed.read(), metadata(repository(), shared));
      assert.equal(
        await readFile(path.join(resumed.workspace, "comments.txt"), "utf8"),
        shared,
      );
    } finally {
      await resumed.release();
    }
  }
});

test("public GitHub and enterprise hosts retain distinct identity keys, reservations, and locks", async (t) => {
  const { store, sharedRepository } = await fixture(t);
  const hosts = ["github.com", "ghe-one.example.com", "ghe-two.example.com"];
  const archives = [];
  try {
    for (const host of hosts) {
      const repo = repository(host);
      const archive = await store.acquire(repo, 7);
      archives.push(archive);
      const expected = `${host === "github.com" ? "" : `${host}/`}test-owner/test-repo#7`;
      assert.equal(archive.fresh, true);
      assert.equal(archive.directory, path.join(store.root, key(expected)));
      assert.equal(
        await readFile(path.join(store.root, ".known", archive.key), "utf8"),
        `${expected}\n`,
      );
      await mkdir(archive.workspace);
      await archive.create(metadata(repo, sharedRepository));
      assert.deepEqual(await archive.read(), metadata(repo, sharedRepository));
      assert.equal(
        await readFile(path.join(archive.directory, "active.lock"), "utf8"),
        `${process.pid}\n`,
      );
      await assert.rejects(store.acquire(repo, 7), /locked/);
    }
    assert.equal(new Set(archives.map((archive) => archive.directory)).size, 3);
  } finally {
    for (const archive of archives) await archive.release();
  }
  assert.equal((await readdir(path.join(store.root, ".known"))).length, 3);
});

test("locks are exclusive across instances, release is idempotent, and stale locks are not removed", async (t) => {
  const { store, sharedRepository, dataHome } = await fixture(t);
  const other = new PrReviewStore(sharedRepository, dataHome);
  const archive = await store.acquire(repository(), 7);
  try {
    await assert.rejects(other.acquire(repository(), 7), /locked/);
  } finally {
    await archive.release();
  }
  await archive.release();
  const resumed = await other.acquire(repository(), 7);
  assert.equal(resumed.fresh, false);
  await resumed.release();
  const lock = path.join(archive.directory, "active.lock");
  await writeFile(lock, "99999999\n");
  await assert.rejects(store.acquire(repository(), 7), /locked/);
  assert.equal(await readFile(lock, "utf8"), "99999999\n");
});

test("schema 3 create/read enforce the exact repository and deterministic workspace binding", async (t) => {
  const { store, sharedRepository, dataHome } = await fixture(t);
  const archive = await store.acquire(repository(), 7);
  try {
    await mkdir(archive.workspace);
    const original = metadata(repository(), sharedRepository);
    assert.deepEqual(metadataSchema.parse(original), original);
    const invalid = [
      { ...original, sharedRepository: await sharedRepo(dataHome, "other") },
      { ...original, workspaceName: `jj-stamp-pr-${"f".repeat(64)}` },
      { ...original, sharedRepository: "relative/.jj/repo" },
      { ...original, schema: 2 },
    ];
    const metadataPath = path.join(archive.directory, "review.json");
    for (const candidate of invalid) {
      await assert.rejects(archive.create(candidate as PrMetadata));
      await assert.rejects(lstat(metadataPath), { code: "ENOENT" });
    }
    await archive.create(original);
    await assert.rejects(archive.create(original), { code: "EEXIST" });
    for (const candidate of invalid) {
      const bytes = `${JSON.stringify(candidate)}\n`;
      await writeFile(metadataPath, bytes);
      await assert.rejects(archive.read());
      assert.equal(await readFile(metadataPath, "utf8"), bytes);
    }
    await writeFile(metadataPath, JSON.stringify(original));
    assert.deepEqual(await archive.read(), original);
  } finally {
    await archive.release();
  }
});

test("foreign hosts, repositories, PR numbers and inconsistent PR URLs cannot resume a current archive", async (t) => {
  const { store, sharedRepository } = await fixture(t);
  const archive = await store.acquire(repository(), 7);
  const original = metadata(repository(), sharedRepository);
  await mkdir(archive.workspace);
  await archive.create(original);
  const comments = path.join(archive.workspace, "comments.txt");
  await writeFile(comments, "local comments\n");
  await archive.release();
  const foreignRepo = {
    ...repository(),
    owner: "Other",
    nameWithOwner: "Other/Test-Repo",
    url: "https://github.com/Other/Test-Repo",
  };
  for (const candidate of [
    {
      ...metadata(repository("other.example.com"), sharedRepository),
      workspaceName: original.workspaceName,
    },
    {
      ...metadata(foreignRepo, sharedRepository),
      workspaceName: original.workspaceName,
    },
    { ...original, pullRequest: { ...original.pullRequest, number: 8 } },
    {
      ...original,
      pullRequest: {
        ...original.pullRequest,
        url: "https://other.example.com/Test-Owner/Test-Repo/pull/7",
      },
    },
  ]) {
    const metadataPath = path.join(archive.directory, "review.json");
    const bytes = JSON.stringify(candidate);
    await writeFile(metadataPath, bytes);
    for (let attempt = 0; attempt < 2; attempt++) {
      const resumed = await store.acquire(repository(), 7);
      try {
        assert.equal(resumed.fresh, false);
        await assert.rejects(resumed.read(), /corrupt.*not recreated/);
        await assert.rejects(resumed.create(original), { code: "EEXIST" });
        assert.equal(await readFile(metadataPath, "utf8"), bytes);
        assert.equal(await readFile(comments, "utf8"), "local comments\n");
      } finally {
        await resumed.release();
      }
    }
  }
});

test("invalid identities and noncanonical shared repository paths fail before creating storage", async (t) => {
  const { dataHome, store } = await fixture(t);
  for (const repo of [
    { ...repository(), url: "not a URL" },
    { ...repository(), url: "http://github.com/Test-Owner/Test-Repo" },
    { ...repository(), url: `${repository().url}?query` },
    { ...repository(), nameWithOwner: "different/repo" },
  ]) {
    await assert.rejects(store.acquire(repo, 7));
    await assert.rejects(lstat(store.root), { code: "ENOENT" });
  }
  for (const shared of [
    "relative/.jj/repo",
    `${dataHome}/clone/../clone/.jj/repo`,
    `${dataHome}/clone/.jj/repo/`,
    `${dataHome}/\0`,
  ])
    assert.throws(() => new PrReviewStore(shared, dataHome));
  assert.throws(
    () =>
      new PrReviewStore(
        path.join(dataHome, "clone", ".jj", "repo"),
        "relative",
      ),
  );
});

test("missing, corrupt and unsafe current archives are never recreated or reset", async (t) => {
  for (const damage of [
    "archive",

    "metadata",
    "workspace",
    "json",
    "schema",
    "oversize",
    "marker",
    "symlink-marker",
    "symlink-archive",
    "symlink-workspace",
    "symlink-metadata",
    "hardlink-metadata",
  ]) {
    await t.test(damage, async (t) => {
      const { store, sharedRepository, dataHome } = await fixture(t);
      const archive = await store.acquire(repository(), 7);
      await mkdir(archive.workspace);
      await archive.create(metadata(repository(), sharedRepository));
      await archive.release();
      const metadataPath = path.join(archive.directory, "review.json");
      const marker = path.join(store.root, ".known", archive.key);
      const target = path.join(dataHome, "untouched-target");
      await writeFile(target, "outside managed storage\n");
      if (damage === "archive")
        await rm(archive.directory, { recursive: true });

      if (damage === "metadata") await rm(metadataPath);
      if (damage === "workspace")
        await rm(archive.workspace, { recursive: true });
      if (damage === "json") await writeFile(metadataPath, "{");
      if (damage === "schema") await writeFile(metadataPath, '{"schema":2}\n');
      if (damage === "oversize")
        await writeFile(metadataPath, " ".repeat(65537));
      if (damage === "marker") await writeFile(marker, "another PR\n");
      if (damage.startsWith("symlink-")) {
        const replaced = {
          "symlink-marker": marker,
          "symlink-archive": archive.directory,
          "symlink-workspace": archive.workspace,
          "symlink-metadata": metadataPath,
        }[damage]!;
        await rm(replaced, { recursive: true });
        await symlink(target, replaced);
      }
      if (damage === "hardlink-metadata")
        await link(metadataPath, path.join(dataHome, "metadata-alias"));
      const damagedBytes = ["json", "schema", "oversize"].includes(damage)
        ? await readFile(metadataPath, "utf8")
        : undefined;
      for (let attempt = 0; attempt < 2; attempt++)
        await assert.rejects(async () => {
          const resumed = await store.acquire(repository(), 7);
          try {
            assert.equal(resumed.fresh, false);
            await resumed.read();
          } finally {
            await resumed.release();
          }
        }, /recreated/);
      if (damage === "archive")
        await assert.rejects(lstat(archive.directory), { code: "ENOENT" });
      if (damage === "metadata")
        await assert.rejects(lstat(metadataPath), { code: "ENOENT" });
      if (damagedBytes !== undefined)
        assert.equal(await readFile(metadataPath, "utf8"), damagedBytes);
      assert.equal(await readFile(target, "utf8"), "outside managed storage\n");
    });
  }
});

test("an archive without its reservation is not overwritten as a fresh review", async (t) => {
  const { store, sharedRepository } = await fixture(t);
  const archive = await store.acquire(repository(), 7);
  await mkdir(archive.workspace);
  await archive.create(metadata(repository(), sharedRepository));
  await archive.release();
  const metadataPath = path.join(archive.directory, "review.json");
  const bytes = await readFile(metadataPath, "utf8");
  await rm(path.join(store.root, ".known", archive.key));
  await assert.rejects(store.acquire(repository(), 7), /not overwritten/);
  assert.equal(await readFile(metadataPath, "utf8"), bytes);
  assert.deepEqual(await readdir(archive.workspace), []);
  await assert.rejects(lstat(path.join(archive.directory, "active.lock")), {
    code: "ENOENT",
  });
});

test("symlink aliases for the shared repository and reservation directory are rejected", async (t) => {
  const { dataHome, sharedRepository, store } = await fixture(t);
  const alias = path.join(dataHome, "alias");
  await symlink(sharedRepository, alias);
  await assert.rejects(
    new PrReviewStore(alias, dataHome).acquire(repository(), 7),
    /unsafe directory/,
  );
  await mkdir(store.root, { recursive: true });
  const outside = path.join(dataHome, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(store.root, ".known"));
  await assert.rejects(store.acquire(repository(), 7), /unsafe directory/);
  assert.deepEqual(await readdir(outside), []);
});

test("old unscoped reservations and corrupt locked archives are ignored, never opened or migrated", async (t) => {
  for (const symlinkKnown of [false, true]) {
    await t.test(
      symlinkKnown ? "unsafe old .known" : "corrupt old reservation",
      async (t) => {
        const { store, sharedRepository, dataHome, base } = await fixture(t);
        const archiveKey = key(identity());
        const oldDirectory = path.join(base, archiveKey);
        const known = path.join(base, ".known");
        const markerDirectory = symlinkKnown
          ? path.join(dataHome, "old-known")
          : known;
        await mkdir(path.join(oldDirectory, "workspace"), { recursive: true });
        await mkdir(markerDirectory);
        if (symlinkKnown) await symlink(markerDirectory, known);
        // Deliberately hand-built old bytes: no old constructor, schema or migration helper.
        const files = new Map([
          [path.join(markerDirectory, archiveKey), "corrupt old reservation\n"],
          [path.join(oldDirectory, "review.json"), '{"schema":2,'],
          [path.join(oldDirectory, "active.lock"), `${process.pid}\n`],
          [path.join(oldDirectory, "workspace", "comments.txt"), "old draft\n"],
        ]);
        for (const [file, bytes] of files) await writeFile(file, bytes);
        const fresh = await store.acquire(repository(), 7);
        try {
          assert.equal(fresh.fresh, true);
          assert.equal(fresh.directory, path.join(store.root, archiveKey));
          assert.notEqual(fresh.directory, oldDirectory);
          await mkdir(fresh.workspace);
          await fresh.create(metadata(repository(), sharedRepository));
          assert.deepEqual(
            await fresh.read(),
            metadata(repository(), sharedRepository),
          );
          assert.deepEqual(await readdir(fresh.workspace), []);
        } finally {
          await fresh.release();
        }
        const resumed = await store.acquire(repository(), 7);
        try {
          assert.equal(resumed.fresh, false);
          assert.deepEqual(
            await resumed.read(),
            metadata(repository(), sharedRepository),
          );
        } finally {
          await resumed.release();
        }
        for (const [file, bytes] of files)
          assert.equal(await readFile(file, "utf8"), bytes);
        assert.deepEqual((await readdir(oldDirectory)).sort(), [
          "active.lock",
          "review.json",
          "workspace",
        ]);
        assert.equal((await lstat(known)).isSymbolicLink(), symlinkKnown);
      },
    );
  }
});
