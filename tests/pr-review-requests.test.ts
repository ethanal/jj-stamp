import assert from "node:assert/strict";
import { test } from "node:test";
import { listRequestedReviews } from "../server/pr-review-requests.ts";
import { validateSummary } from "../server/pr-review-github.ts";
import type { PrRepository, PrReviewSummary } from "../src/pr-review-types.ts";

const repo: PrRepository = {
  owner: "owner",
  name: "repo",
  nameWithOwner: "owner/repo",
  url: "https://enterprise.example/owner/repo",
};
const user = (login = "viewer") => ({ __typename: "User", login });
const team = (org = "owner", slug = "reviewers") => ({
  __typename: "Team",
  slug,
  organization: { login: org },
});
const request = (who: unknown = user()) => ({ requestedReviewer: who });
const event = (who: unknown = user()) => ({
  __typename: "ReviewRequestedEvent",
  ...request(who),
});
const connection = (
  nodes: unknown[] = [],
  hasNextPage = false,
  endCursor: string | null = null,
) => ({
  nodes,
  pageInfo: { hasNextPage, endCursor },
});
function pr(number = 1, overrides: Record<string, unknown> = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `${repo.url}/pull/${number}`,
    state: "OPEN",
    isDraft: false,
    headRefName: "feature",
    baseRefName: "main",
    headRefOid: "a".repeat(40),
    baseRefOid: "b".repeat(40),
    author: { login: "author" },
    reviewRequests: connection(),
    timelineItems: connection(),
    ...overrides,
  };
}
const data = (repository: unknown) => ({ data: { repository } });
const candidates = (
  nodes: unknown[] = [],
  more = false,
  cursor: string | null = null,
) => data({ pullRequests: connection(nodes, more, cursor) });
const restTeam = (
  slug = "reviewers",
  org = "owner",
  parent: unknown = null,
) => ({
  slug,
  organization: { login: org },
  parent,
});
const hundred = (create: (index: number) => unknown) =>
  Array.from({ length: 100 }, (_, i) => create(i));
type Call = {
  args: string[];
  query: string;
  operation: string;
  after?: string;
  number?: number;
  teamPage?: number;
};
function mock(handler: (call: Call) => unknown, teams: unknown[] = []) {
  const calls: Call[] = [];
  const api = async (args: string[]): Promise<unknown> => {
    const query = args.find((s) => s.startsWith("query="))?.slice(6) ?? "";
    const endpoint = args[2];
    const call: Call = {
      args,
      query,
      operation: query.match(/query (\w+)/)?.[1] ?? endpoint,
      after: args.find((s) => s.startsWith("after="))?.slice(6),
      number: args.find((s) => s.startsWith("number="))
        ? Number(args.find((s) => s.startsWith("number="))!.slice(7))
        : undefined,
      teamPage: endpoint.startsWith("user/teams?")
        ? Number(endpoint.match(/page=(\d+)$/)![1])
        : undefined,
    };
    calls.push(call);
    if (endpoint === "user") return { login: "viewer" };
    if (call.teamPage) {
      const result = handler(call);
      return result === undefined ? teams : result;
    }
    return handler(call);
  };
  return { api, calls };
}
const queue = (api: (args: string[]) => Promise<unknown>, limit = 50) =>
  listRequestedReviews(repo, api, validateSummary, limit);
const numbers = (summaries: PrReviewSummary[]) =>
  summaries.map((item) => item.number);

test("matches personal current and historical requests, including completed/withdrawn requests", async () => {
  const client = mock(({ operation }) =>
    operation === "RequestedReviewCandidates"
      ? candidates([
          pr(1, { reviewRequests: connection([request(user("VIEWER"))]) }),
          pr(2, {
            timelineItems: connection([event()]),
            reviews: { nodes: [{ author: user(), state: "APPROVED" }] },
          }),
          pr(3, { timelineItems: connection([event()]), author: null }),
          pr(4, {
            reviewRequests: connection([request(user("other")), request(null)]),
          }),
        ])
      : undefined,
  );
  const results = await queue(client.api);
  assert.deepEqual(numbers(results), [1, 2, 3]);
  assert.deepEqual(results[0].author, { login: "author" });
  assert.equal(results[2].author, null);
  assert.ok(!("reviewRequests" in results[0]));
});

test("historical team eligibility survives auto-reassignment/removal and someone else's completed review", async () => {
  const client = mock(
    ({ operation }) =>
      operation === "RequestedReviewCandidates"
        ? candidates([
            pr(1, {
              timelineItems: connection([event(team("OwNeR", "REVIEWERS"))]),
              reviews: {
                nodes: [{ author: user("teammate"), state: "APPROVED" }],
              },
            }),
            pr(2, {
              reviewRequests: connection([request(user("teammate"))]),
              timelineItems: connection([event(team())]),
            }),
            pr(3, { reviewRequests: connection([request(team())]) }),
            pr(4, {
              timelineItems: connection([event(team("different-org"))]),
            }),
            pr(5, {
              timelineItems: connection([event(team("owner", "other-team"))]),
            }),
            pr(6, { timelineItems: connection([event(user("unrelated"))]) }),
          ])
        : undefined,
    [restTeam()],
  );
  assert.deepEqual(numbers(await queue(client.api)), [1, 2, 3]);
});

test("excludes merged defensively but includes closed unmerged and draft PRs", async () => {
  const client = mock(({ operation }) =>
    operation === "RequestedReviewCandidates"
      ? candidates([
          pr(1, { state: "MERGED", reviewRequests: connection([request()]) }),
          pr(2, { state: "CLOSED", timelineItems: connection([event()]) }),
          pr(3, { isDraft: true, reviewRequests: connection([request()]) }),
        ])
      : undefined,
  );
  assert.deepEqual(numbers(await queue(client.api)), [2, 3]);
});

test("fully paginates viewer teams and includes explicit nested team parents", async () => {
  const client = mock(({ operation, teamPage }) => {
    if (teamPage === 1) return hundred((i) => restTeam(`filler-${i}`));
    if (teamPage === 2)
      return [
        restTeam("child", "OwNeR", {
          slug: "reviewers",
          parent: { slug: "grandparent", parent: null },
        }),
      ];
    if (operation === "RequestedReviewCandidates")
      return candidates([
        pr(1, { timelineItems: connection([event(team())]) }),
        pr(2, {
          timelineItems: connection([event(team("owner", "grandparent"))]),
        }),
        pr(3, {
          timelineItems: connection([event(team("other", "grandparent"))]),
        }),
      ]);
  });
  assert.deepEqual(numbers(await queue(client.api)), [1, 2]);
  assert.deepEqual(
    client.calls.filter((c) => c.teamPage).map((c) => c.teamPage),
    [1, 2],
  );
});

for (const kind of ["reviewRequests", "timelineItems"] as const) {
  test(`paginates ${kind} beyond 100 before declaring nonmatch`, async () => {
    const node = kind === "reviewRequests" ? request : event;
    const operationName =
      kind === "reviewRequests"
        ? "RequestedReviewRequests"
        : "RequestedReviewHistory";
    const client = mock(({ operation, after, number }) => {
      if (operation === "RequestedReviewCandidates")
        return candidates([
          pr(1, {
            [kind]: connection(
              hundred(() => node(user("other"))),
              true,
              "first-100",
            ),
          }),
          pr(2, {
            [kind]: connection(
              hundred(() => node(user("other"))),
              true,
              "first-100",
            ),
          }),
        ]);
      if (operation === operationName) {
        assert.equal(after, "first-100");
        return data({
          pullRequest: {
            number,
            [kind]: connection(
              [node(number === 1 ? user() : user("other"))],
              false,
              "last",
            ),
          },
        });
      }
    });
    assert.deepEqual(numbers(await queue(client.api)), [1]);
    assert.equal(
      client.calls.filter((c) => c.operation === operationName).length,
      2,
    );
  });
}

test("paginates both current requests and history before declaring nonmatch", async () => {
  const client = mock(({ operation, number }) => {
    if (operation === "RequestedReviewCandidates")
      return candidates([
        pr(1, {
          reviewRequests: connection([request(user("other"))], true, "r1"),
          timelineItems: connection([event(user("other"))], true, "h1"),
        }),
      ]);
    if (operation === "RequestedReviewRequests")
      return data({
        pullRequest: {
          number,
          reviewRequests: connection([request(user("other"))], false, "r2"),
        },
      });
    if (operation === "RequestedReviewHistory")
      return data({
        pullRequest: {
          number,
          timelineItems: connection([event()], false, "h2"),
        },
      });
  });
  assert.deepEqual(numbers(await queue(client.api)), [1]);
  assert.deepEqual(
    client.calls.filter((c) => c.query).map((c) => c.operation),
    [
      "RequestedReviewCandidates",
      "RequestedReviewRequests",
      "RequestedReviewHistory",
    ],
  );
});

test("continues candidate pagination beyond 50 nonmatching PRs", async () => {
  let page = 0;
  const client = mock(({ operation, after }) => {
    if (operation !== "RequestedReviewCandidates") return;
    assert.equal(after, page ? `page-${page}` : undefined);
    const start = page++ * 20;
    return candidates(
      Array.from({ length: page === 4 ? 1 : 20 }, (_, i) =>
        pr(start + i + 1, {
          timelineItems: connection([
            event(user(page === 4 ? "viewer" : "other")),
          ]),
        }),
      ),
      page < 4,
      `page-${page}`,
    );
  });
  assert.deepEqual(numbers(await queue(client.api)), [61]);
  assert.equal(page, 4);
});

test("stops at 50 matching results, not 50 candidates, and honors a smaller limit", async () => {
  for (const limit of [1, 50]) {
    let page = 0;
    let validated = 0;
    const client = mock(({ operation }) => {
      if (operation === "RequestedReviewCandidates") {
        const start = page++ * 20;
        return candidates(
          Array.from({ length: 20 }, (_, i) =>
            pr(start + i + 1, { reviewRequests: connection([request()]) }),
          ),
          true,
          `page-${page}`,
        );
      }
    });
    const result = await listRequestedReviews(
      repo,
      client.api,
      (value, repository) => {
        validated++;
        return validateSummary(value, repository);
      },
      limit,
    );
    assert.equal(result.length, limit);
    assert.equal(validated, limit);
    assert.equal(page, Math.ceil(limit / 20));
  }
});

test("operations are read-only, host-relative, static and parameterized, with no reviews or members enumeration", async () => {
  const client = mock(({ operation, number }) => {
    if (operation === "RequestedReviewCandidates")
      return candidates([
        pr(1, {
          reviewRequests: connection([request(user("other"))], true, "r1"),
          timelineItems: connection([event(user("other"))], true, "h1"),
        }),
      ]);
    if (operation === "RequestedReviewRequests")
      return data({
        pullRequest: { number, reviewRequests: connection([], false, "r2") },
      });
    if (operation === "RequestedReviewHistory")
      return data({
        pullRequest: { number, timelineItems: connection([], false, "h2") },
      });
  });
  await queue(client.api);
  for (const call of client.calls) {
    assert.ok(!call.args.includes("--paginate"));
    assert.ok(
      !/\b(reviews|reviewDecision|members|mutation)\b/.test(call.query),
    );
    if (!call.query) {
      assert.equal(call.args[1], "GET");
      continue;
    }
    assert.equal(call.args[1], "POST");
    assert.equal(call.args[2], "graphql");
    assert.ok(call.args.includes(`owner=${repo.owner}`));
    assert.ok(call.args.includes(`name=${repo.name}`));
    assert.match(call.query, /repository\(owner: \$owner, name: \$name\)/);
    if (call.operation === "RequestedReviewCandidates") {
      assert.match(
        call.query,
        /first: 20.*states: \[OPEN, CLOSED\].*UPDATED_AT.*DESC/,
      );
      assert.match(call.query, /author \{ login \}/);
    }
    if (call.query.includes("timelineItems"))
      assert.match(call.query, /itemTypes: \[REVIEW_REQUESTED_EVENT\]/);
  }
});

test("rejects GraphQL partial errors, absent repositories, malformed summaries, and cross-repo URLs", async () => {
  for (const response of [
    {
      ...candidates([pr(1, { reviewRequests: connection([request()]) })]),
      errors: [{ message: "partial failure" }],
    },
    data(null),
    { errors: [{ message: "denied" }] },
    candidates([pr(1, { title: null })]),
    candidates([pr(1, { url: "https://other.example/owner/repo/pull/1" })]),
  ]) {
    const client = mock(({ operation }) =>
      operation === "RequestedReviewCandidates" ? response : undefined,
    );
    await assert.rejects(queue(client.api));
  }
});

test("rejects malformed viewer, team identities, parent cycles and cross-org parents", async () => {
  await assert.rejects(queue(async () => ({ login: "" })));
  const cyclic = { slug: "child", parent: { slug: "child" } };
  for (const teams of [
    [{ slug: "reviewers" }],
    [{ slug: "", organization: { login: "owner" } }],
    [restTeam("child", "owner", cyclic)],
    [restTeam("child", "owner", restTeam("parent", "different"))],
    [restTeam("child", "owner", {})],
  ]) {
    const client = mock(() => undefined, teams);
    await assert.rejects(queue(client.api));
  }
  let parent: unknown = null;
  for (let i = 0; i < 17; i++) parent = { slug: `p${i}`, parent };
  const client = mock(() => undefined, [restTeam("child", "owner", parent)]);
  await assert.rejects(queue(client.api), /parent depth bound/);
});

test("rejects repeated team pages and fails explicitly at the team page bound", async () => {
  const repeated = mock(({ teamPage }) =>
    teamPage ? hundred((i) => restTeam(`team-${i}`)) : undefined,
  );
  await assert.rejects(queue(repeated.api), /repeated team page/);
  const bounded = mock(({ teamPage }) =>
    teamPage ? hundred((i) => restTeam(`team-${teamPage}-${i}`)) : undefined,
  );
  await assert.rejects(queue(bounded.api), /team page bound/);
  assert.equal(bounded.calls.filter((c) => c.teamPage).length, 100);
});

for (const kind of ["candidates", "reviewRequests", "timelineItems"] as const) {
  test(`fails closed on malformed or repeated ${kind} cursors`, async () => {
    for (const mode of [
      "missing",
      "empty",
      "repeated",
      "empty-page",
    ] as const) {
      let page = 0;
      const client = mock(({ operation, number, teamPage }) => {
        if (teamPage) return;
        const cursor =
          mode === "empty" ? "" : mode === "missing" ? null : "same";
        const node =
          kind === "reviewRequests"
            ? request(user("other"))
            : event(user("other"));
        const batch = connection(
          mode === "empty-page" ? [] : [node],
          true,
          cursor,
        );
        if (operation === "RequestedReviewCandidates") {
          if (kind === "candidates")
            return candidates(
              mode === "empty-page" ? [] : [pr(++page)],
              true,
              cursor,
            );
          return candidates([pr(1, { [kind]: batch })]);
        }
        return data({ pullRequest: { number, [kind]: batch } });
      });
      await assert.rejects(queue(client.api), /pagination|cursor/i);
    }
  });
}

test("rejects repeated candidate PRs and wrong or missing continuation PR identities", async () => {
  let page = 0;
  const duplicated = mock(({ operation }) =>
    operation === "RequestedReviewCandidates"
      ? candidates([pr(1)], ++page < 2, `p${page}`)
      : undefined,
  );
  await assert.rejects(queue(duplicated.api), /repeated PR/);
  for (const pullRequest of [
    null,
    { number: 2, reviewRequests: connection() },
  ]) {
    const client = mock(({ operation }) =>
      operation === "RequestedReviewCandidates"
        ? candidates([
            pr(1, {
              reviewRequests: connection([request(user("other"))], true, "r1"),
            }),
          ])
        : operation === "RequestedReviewRequests"
          ? data({ pullRequest })
          : undefined,
    );
    await assert.rejects(queue(client.api));
  }
});

for (const kind of ["candidates", "reviewRequests", "timelineItems"] as const) {
  test(`fails explicitly at the ${kind} page bound instead of returning a partial queue`, async () => {
    let page = 0;
    const client = mock(({ operation, number, teamPage }) => {
      if (teamPage) return;
      if (operation === "RequestedReviewCandidates") {
        if (kind === "candidates")
          return candidates([pr(++page)], true, `p${page}`);
        const node =
          kind === "reviewRequests"
            ? request(user("other"))
            : event(user("other"));
        return candidates([pr(1, { [kind]: connection([node], true, "c0") })]);
      }
      const node =
        kind === "reviewRequests"
          ? request(user("other"))
          : event(user("other"));
      return data({
        pullRequest: { number, [kind]: connection([node], true, `c${++page}`) },
      });
    });
    await assert.rejects(queue(client.api), /page bound/);
    assert.equal(page, kind === "candidates" ? 100 : 99);
  });
}

test("global API call bound fails the entire queue rather than returning already found matches", async () => {
  const pages = new Map<number, number>();
  const client = mock(({ operation, number }) => {
    if (operation === "RequestedReviewCandidates")
      return candidates([
        pr(1, { reviewRequests: connection([request()]) }),
        ...Array.from({ length: 10 }, (_, i) =>
          pr(i + 2, {
            timelineItems: connection([event(user("other"))], true, "h0"),
          }),
        ),
      ]);
    if (operation === "RequestedReviewHistory") {
      const page = (pages.get(number!) ?? 0) + 1;
      pages.set(number!, page);
      return data({
        pullRequest: {
          number,
          timelineItems: connection(
            [event(user("other"))],
            page < 99,
            `h${page}`,
          ),
        },
      });
    }
  });
  await assert.rejects(queue(client.api), /API call bound/);
  assert.equal(client.calls.length, 500);
});

test("API errors propagate, and invalid limits make no API calls", async () => {
  await assert.rejects(
    queue(async () => {
      throw new Error("authentication denied");
    }),
    /authentication denied/,
  );
  for (const limit of [0, -1, 51, 1.5, NaN]) {
    let calls = 0;
    await assert.rejects(
      queue(async () => {
        calls++;
        return {};
      }, limit),
    );
    assert.equal(calls, 0);
  }
});
