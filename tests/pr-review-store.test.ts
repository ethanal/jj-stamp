import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
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
import { test } from "node:test";
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

function metadata(repo: PrRepository): Extract<PrMetadata, { schema: 2 }> {
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

function linkedMetadata(
  repo: PrRepository,
  sharedRepository: string,
  workspaceName: string,
): Extract<PrMetadata, { schema: 3 }> {
  return { ...metadata(repo), schema: 3, sharedRepository, workspaceName };
}

async function sharedRepo(dataHome: string, clone = "clone") {
  const directory = path.join(dataHome, clone, ".jj", "repo");
  await mkdir(directory, { recursive: true });
  return directory;
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

test("linked stores scope the same GitHub PR to the canonical local repository", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const repo = repository();
  const legacyRoot = new PrReviewStore(dataHome).root;
  const archiveKey = key("test-owner/test-repo#7");
  const workspaceName = `jj-stamp-pr-${archiveKey}`;
  const sharedRepositories = await Promise.all([
    sharedRepo(dataHome, "first-clone"),
    sharedRepo(dataHome, "second-clone"),
  ]);
  const archives = [];
  try {
    for (const sharedRepository of sharedRepositories) {
      const store = new PrReviewStore(dataHome, sharedRepository);
      assert.equal(
        store.root,
        path.join(legacyRoot, "workspaces", key(sharedRepository)),
      );
      const archive = await store.acquire(repo, 7);
      archives.push(archive);
      assert.equal(archive.key, archiveKey);
      assert.equal(archive.workspaceName, workspaceName);
      assert.equal(archive.fresh, true);
      assert.equal(archive.directory, path.join(store.root, archiveKey));
      await mkdir(archive.workspace);
      const original = linkedMetadata(repo, sharedRepository, workspaceName);
      await archive.create(original);
      assert.deepEqual(await archive.read(), original);
      await writeFile(
        path.join(archive.workspace, "comments.txt"),
        sharedRepository,
      );
      assert.equal(
        await readFile(path.join(store.root, ".known", archiveKey), "utf8"),
        "test-owner/test-repo#7\n",
      );
      for (const file of [
        path.join(store.root, ".known", archiveKey),
        path.join(archive.directory, "review.json"),
        path.join(archive.directory, "active.lock"),
      ])
        assert.equal((await lstat(file)).mode & 0o777, 0o600);
      assert.equal((await lstat(store.root)).mode & 0o777, 0o700);
      await assert.rejects(
        new PrReviewStore(dataHome, sharedRepository).acquire(repo, 7),
        /locked/,
      );
    }
    assert.notEqual(archives[0].directory, archives[1].directory);
    await assert.rejects(lstat(path.join(legacyRoot, ".known")), {
      code: "ENOENT",
    });
  } finally {
    for (const archive of archives) await archive.release();
  }
  for (const sharedRepository of sharedRepositories) {
    const archive = await new PrReviewStore(dataHome, sharedRepository).acquire(
      repo,
      7,
    );
    try {
      assert.equal(archive.fresh, false);
      assert.deepEqual(
        await archive.read(),
        linkedMetadata(repo, sharedRepository, workspaceName),
      );
      assert.equal(
        await readFile(path.join(archive.workspace, "comments.txt"), "utf8"),
        sharedRepository,
      );
    } finally {
      await archive.release();
    }
  }
});

test("schema 3 create/read require the exact linked repository and deterministic workspace binding", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  const sharedRepository = await sharedRepo(dataHome);
  const store = new PrReviewStore(dataHome, sharedRepository);
  const repo = repository();
  const archive = await store.acquire(repo, 7);
  t.after(async () => {
    await archive.release();
    await rm(dataHome, { recursive: true, force: true });
  });
  await mkdir(archive.workspace);
  const original = linkedMetadata(
    repo,
    sharedRepository,
    archive.workspaceName,
  );
  assert.deepEqual(metadataSchema.parse(metadata(repo)), metadata(repo));
  assert.deepEqual(metadataSchema.parse(original), original);
  const invalid = [
    { ...original, sharedRepository: await sharedRepo(dataHome, "other") },
    { ...original, workspaceName: `jj-stamp-pr-${"f".repeat(64)}` },
    { ...original, sharedRepository: "relative/.jj/repo" },
    metadata(repo),
  ];
  const metadataPath = path.join(archive.directory, "review.json");
  for (const candidate of invalid) {
    await assert.rejects(archive.create(candidate));
    await assert.rejects(lstat(metadataPath), { code: "ENOENT" });
  }
  await archive.create(original);
  for (const candidate of invalid) {
    const bytes = `${JSON.stringify(candidate)}\n`;
    await writeFile(metadataPath, bytes);
    await assert.rejects(archive.read(), /corrupt.*not recreated/);
    assert.equal(await readFile(metadataPath, "utf8"), bytes);
  }
  const foreignHost = linkedMetadata(
    repository("other.example.com"),
    sharedRepository,
    archive.workspaceName,
  );
  await writeFile(metadataPath, JSON.stringify(foreignHost));
  await assert.rejects(archive.read(), /corrupt.*not recreated/);
  await writeFile(metadataPath, JSON.stringify(original));
  assert.deepEqual(await archive.read(), original);

  const legacy = await new PrReviewStore(dataHome).acquire(repo, 8);
  try {
    await mkdir(legacy.workspace);
    await assert.rejects(legacy.create(original), /binding mismatch/);
    await writeFile(
      path.join(legacy.directory, "review.json"),
      JSON.stringify(original),
    );
    await assert.rejects(legacy.read(), /corrupt.*not recreated/);
  } finally {
    await legacy.release();
  }
});

test("linked stores resume legacy archives unchanged rather than hiding existing drafts", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const sharedRepository = await sharedRepo(dataHome);
  for (const host of ["github.com", "enterprise.example.com"]) {
    const repo = repository(host);
    const legacyStore = new PrReviewStore(dataHome);
    const legacy = await legacyStore.acquire(repo, 7);
    await mkdir(legacy.workspace);
    await legacy.create(metadata(repo));
    const comments = path.join(legacy.workspace, "comments.txt");
    await writeFile(comments, "never discard this draft\n");
    const metadataPath = path.join(legacy.directory, "review.json");
    const archived = await readFile(metadataPath, "utf8");
    await legacy.release();
    const store = new PrReviewStore(dataHome, sharedRepository);
    const resumed = await store.acquire(repo, 7);
    try {
      assert.equal(resumed.fresh, false);
      assert.equal(resumed.directory, legacy.directory);
      assert.equal(resumed.key, legacy.key);
      assert.equal(resumed.workspaceName, `jj-stamp-pr-${legacy.key}`);
      assert.deepEqual(await resumed.read(), metadata(repo));
      assert.equal(await readFile(metadataPath, "utf8"), archived);
      assert.equal(
        await readFile(comments, "utf8"),
        "never discard this draft\n",
      );
      await assert.rejects(lstat(store.root), { code: "ENOENT" });
      await assert.rejects(legacyStore.acquire(repo, 7), /locked/);
      await assert.rejects(store.acquire(repo, 7), /locked/);
    } finally {
      await resumed.release();
    }
  }
});

test("legacy identity takes precedence even when a linked archive also exists", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const sharedRepository = await sharedRepo(dataHome);
  const repo = repository();
  const store = new PrReviewStore(dataHome, sharedRepository);
  const linked = await store.acquire(repo, 7);
  await mkdir(linked.workspace);
  await linked.create(
    linkedMetadata(repo, sharedRepository, linked.workspaceName),
  );
  await linked.release();
  const linkedBytes = await readFile(
    path.join(linked.directory, "review.json"),
    "utf8",
  );
  const legacy = await new PrReviewStore(dataHome).acquire(repo, 7);
  await mkdir(legacy.workspace);
  await legacy.create(metadata(repo));
  await legacy.release();
  const resumed = await store.acquire(repo, 7);
  try {
    assert.equal(resumed.directory, legacy.directory);
    assert.equal((await resumed.read()).schema, 2);
  } finally {
    await resumed.release();
  }
  await writeFile(path.join(legacy.directory, "review.json"), "corrupt");
  const damaged = await store.acquire(repo, 7);
  try {
    assert.equal(damaged.directory, legacy.directory);
    await assert.rejects(damaged.read(), /corrupt.*not recreated/);
    assert.equal(
      await readFile(path.join(linked.directory, "review.json"), "utf8"),
      linkedBytes,
    );
  } finally {
    await damaged.release();
  }
});

test("damaged legacy archives and reservations fail closed before creating linked storage", async (t) => {
  for (const damage of [
    "missing-archive",
    "missing-reservation",
    "corrupt-reservation",
    "corrupt-metadata",
    "missing-metadata",
    "missing-workspace",
    "unsupported-schema",
    "oversize-metadata",
  ]) {
    await t.test(damage, async (t) => {
      const dataHome = await mkdtemp(
        path.join(os.tmpdir(), "jj-stamp-pr-store-"),
      );
      t.after(() => rm(dataHome, { recursive: true, force: true }));
      const sharedRepository = await sharedRepo(dataHome);
      const repo = repository();
      const legacyStore = new PrReviewStore(dataHome);
      const legacy = await legacyStore.acquire(repo, 7);
      await mkdir(legacy.workspace);
      await legacy.create(metadata(repo));
      await legacy.release();
      const metadataPath = path.join(legacy.directory, "review.json");
      const reservation = path.join(legacyStore.root, ".known", legacy.key);
      if (damage === "missing-archive")
        await rm(legacy.directory, { recursive: true });
      if (damage === "missing-reservation") await rm(reservation);
      if (damage === "corrupt-reservation")
        await writeFile(reservation, "another PR\n");
      if (damage === "corrupt-metadata") await writeFile(metadataPath, "{");
      if (damage === "missing-metadata") await rm(metadataPath);
      if (damage === "missing-workspace")
        await rm(legacy.workspace, { recursive: true });
      if (damage === "unsupported-schema")
        await writeFile(
          metadataPath,
          JSON.stringify({ ...metadata(repo), schema: 1 }),
        );
      if (damage === "oversize-metadata")
        await writeFile(metadataPath, " ".repeat(65537));
      const store = new PrReviewStore(dataHome, sharedRepository);
      await assert.rejects(async () => {
        const archive = await store.acquire(repo, 7);
        try {
          assert.equal(archive.fresh, false);
          await archive.read();
        } finally {
          await archive.release();
        }
      });
      await assert.rejects(lstat(store.root), { code: "ENOENT" });
      if (damage === "missing-archive")
        await assert.rejects(lstat(legacy.directory), { code: "ENOENT" });
    });
  }
});

test("linked storage requires canonical absolute repository paths, not symlink aliases", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  for (const sharedRepository of [
    "relative/.jj/repo",
    `${dataHome}/clone/../clone/.jj/repo`,
    `${dataHome}/clone/.jj/repo/`,
    `${dataHome}/\0`,
  ])
    assert.throws(() => new PrReviewStore(dataHome, sharedRepository));
  const sharedRepository = await sharedRepo(dataHome);
  const alias = path.join(dataHome, "alias");
  await symlink(sharedRepository, alias);
  const store = new PrReviewStore(dataHome, alias);
  await assert.rejects(store.acquire(repository(), 7), /unsafe directory/);
  await assert.rejects(lstat(store.root), { code: "ENOENT" });
});

test("a missing linked archive is never recreated after reserving its identity", async (t) => {
  const dataHome = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-pr-store-"));
  t.after(() => rm(dataHome, { recursive: true, force: true }));
  const sharedRepository = await sharedRepo(dataHome);
  const store = new PrReviewStore(dataHome, sharedRepository);
  const archive = await store.acquire(repository(), 7);
  await archive.release();
  await rm(archive.directory, { recursive: true });
  await assert.rejects(
    store.acquire(repository(), 7),
    /missing.*not recreated/,
  );
  await assert.rejects(lstat(archive.directory), { code: "ENOENT" });
  assert.equal(
    await readFile(path.join(store.root, ".known", archive.key), "utf8"),
    "test-owner/test-repo#7\n",
  );
});
