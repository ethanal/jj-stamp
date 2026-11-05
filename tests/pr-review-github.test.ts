import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePrInput,
  PrGithub,
  repositoryHost,
  repositorySchema,
  validateSummary,
  type PrRunner,
} from "../server/pr-review-github.ts";
import type { PrRepository, PrReviewSummary } from "../src/pr-review-types.ts";

function repository(host = "github.enterprise.example"): PrRepository {
  return {
    owner: "owner",
    name: "repo",
    nameWithOwner: "owner/repo",
    url: `https://${host}/owner/repo`,
  };
}

function summary(repo: PrRepository): PrReviewSummary {
  return {
    number: 7,
    title: "Enterprise review",
    url: `${repo.url}/pull/7`,
    state: "OPEN",
    isDraft: false,
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: "a".repeat(40),
    baseRefOid: "b".repeat(40),
    author: { login: "reviewer" },
  };
}

test("canonical public and Enterprise repositories include their exact host", () => {
  for (const host of [
    "github.com",
    "github.enterprise.example",
    "company.ghe.com",
    "github.internal:8443",
  ]) {
    const repo = repository(host);
    assert.deepEqual(repositorySchema.parse(repo), repo);
    assert.equal(repositoryHost(repo), host);
    assert.equal(parsePrInput("7", repo), 7);
    assert.equal(parsePrInput(" #7 ", repo), 7);
    assert.equal(parsePrInput(`${repo.url}/pull/7`), 7);
    assert.equal(parsePrInput(`${repo.url}/pull/7`, repo), 7);
    assert.equal(parsePrInput(` ${repo.url}/pull/7/ `, repo), 7);
    assert.equal(parsePrInput(`https://${host}/OWNER/REPO/pull/7`, repo), 7);
  }
});

test("repository discovery rejects noncanonical or mismatched identities", () => {
  const repo = repository();
  for (const url of [
    "http://github.enterprise.example/owner/repo",
    "https://user:pass@github.enterprise.example/owner/repo",
    "https://github.enterprise.example/owner/other",
    `${repo.url}/`,
    `${repo.url}?`,
    `${repo.url}#`,
    `${repo.url}?query=1`,
    `${repo.url}#fragment`,
    "https://github.enterprise.example/owner/x/../repo",
    "https://github.enterprise.example/owner/%72epo",
    "https://github.enterprise.example\\owner\\repo",
    "https://github.enterprise.example:443/owner/repo",
    "https://github.enterprise.example:0/owner/repo",
    "https://www.github.enterprise.example/owner/repo",
    "https://github..enterprise.example/owner/repo",
    "https://github.enterprise.example./owner/repo",
    "https://github.enterprise.example/owner/repo\n",
    "https://github.enterprise.example/owner/repo/extra",
  ])
    assert.equal(
      repositorySchema.safeParse({ ...repo, url }).success,
      false,
      url,
    );
  assert.equal(
    repositorySchema.safeParse({ ...repo, nameWithOwner: "other/repo" })
      .success,
    false,
  );
});

test("Enterprise PR URLs cannot escape the current host and repository", () => {
  const repo = repository();
  for (const input of [
    "https://github.com/owner/repo/pull/7",
    "https://another.enterprise.example/owner/repo/pull/7",
    "https://www.github.enterprise.example/owner/repo/pull/7",
    "https://github.enterprise.example.evil.example/owner/repo/pull/7",
    "https://github.enterprise.example:8443/owner/repo/pull/7",
    "https://github.enterprise.example/other/repo/pull/7",
    "https://github.enterprise.example/owner/other/pull/7",
    "https://github.enterprise.example@evil.example/owner/repo/pull/7",
    "https://user:pass@github.enterprise.example/owner/repo/pull/7",
    "http://github.enterprise.example/owner/repo/pull/7",
    `${repo.url}/pull/7?`,
    `${repo.url}/pull/7#`,
    `${repo.url}/pull/7?x=1`,
    `${repo.url}/pull/7#discussion`,
    `${repo.url}/pull/7/files`,
    `${repo.url}/pull/7/../7`,
    `${repo.url}/pull/%37`,
    `${repo.url}/pull/07`,
    `${repo.url}/pull/2147483648`,
    `${repo.url}/pull/7;pwd`,
    "https://github.enterprise.example\\owner\\repo\\pull\\7",
    "https://github.enterprise.example/owner/repo/\npull/7",
  ])
    assert.throws(() => parsePrInput(input, repo), input);
  // Reject gh's host alias even before the current repository is discovered.
  assert.throws(() =>
    parsePrInput("https://www.github.enterprise.example/owner/repo/pull/7"),
  );
});

test("PR summaries must contain an actual same-host URL and matching number", () => {
  const repo = repository();
  const pr = summary(repo);
  assert.deepEqual(validateSummary(pr, repo), pr);
  for (const url of [
    "7",
    `${repo.url}/pull/8`,
    "https://github.com/owner/repo/pull/7",
    `${repo.url}/pull/7?x`,
  ])
    assert.throws(() => validateSummary({ ...pr, url }, repo), url);
});

for (const host of [
  "github.com",
  "github.enterprise.example",
  "company.ghe.com",
]) {
  test(`gh discovery, listing and lookup explicitly target ${host}`, async () => {
    const repo = repository(host);
    const pr = summary(repo);
    const calls: string[][] = [];
    const runner: PrRunner = async (command, args, cwd, limits) => {
      assert.equal(command, "gh");
      assert.equal(cwd, "/original/workspace");
      assert.equal(limits?.maxOutputBytes, 1024 * 1024);
      calls.push([...args]);
      const result =
        args[0] === "repo"
          ? { ...repo, owner: { login: repo.owner } }
          : args[1] === "list"
            ? [pr]
            : pr;
      return { stdout: JSON.stringify(result), stderr: "" };
    };
    const github = new PrGithub("/original/workspace", runner);
    assert.deepEqual(await github.repository(), repo);
    assert.deepEqual(await github.list(repo), [pr]);
    assert.deepEqual(await github.view(repo, 7), pr);
    assert.deepEqual(calls[0], [
      "repo",
      "view",
      "--json",
      "owner,name,nameWithOwner,url",
    ]);
    for (const call of calls.slice(1))
      assert.equal(call[call.indexOf("--repo") + 1], `${host}/owner/repo`);
    assert.deepEqual(calls[1]!.slice(0, 8), [
      "pr",
      "list",
      "--repo",
      `${host}/owner/repo`,
      "--state",
      "open",
      "--limit",
      "50",
    ]);
    assert.deepEqual(calls[2]!.slice(0, 5), [
      "pr",
      "view",
      "7",
      "--repo",
      `${host}/owner/repo`,
    ]);
  });
}

test("gh errors provide authentication guidance for the selected Enterprise host", async () => {
  const github = new PrGithub("/workspace", async () => {
    throw new Error("not authenticated");
  });
  await assert.rejects(
    github.list(repository()),
    /gh auth login --hostname github\.enterprise\.example/,
  );
  await assert.rejects(
    github.view(repository(), 7),
    /gh auth login --hostname github\.enterprise\.example/,
  );
  await assert.rejects(github.repository(), (error: Error) => {
    assert.match(error.message, /gh auth login --hostname HOST/);
    assert.doesNotMatch(error.message, /for github\.com/);
    return true;
  });
});
