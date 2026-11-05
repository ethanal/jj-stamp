import { z } from "zod";
import type { PrRepository, PrReviewSummary } from "../src/pr-review-types.ts";

// Static queries only: all repository identities, PR numbers and cursors are variables.
const reviewerFields = `__typename ... on User { login } ... on Team { slug organization { login } }`;
const requestFields = `nodes { requestedReviewer { ${reviewerFields} } } pageInfo { hasNextPage endCursor }`;
const historyFields = `nodes { __typename ... on ReviewRequestedEvent { requestedReviewer { ${reviewerFields} } } } pageInfo { hasNextPage endCursor }`;
const candidatesQuery = `query RequestedReviewCandidates($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 20, after: $after, states: [OPEN, CLOSED], orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes {
        number title url state isDraft headRefName baseRefName headRefOid baseRefOid author { login }
        reviewRequests(first: 100) { ${requestFields} }
        timelineItems(first: 100, itemTypes: [REVIEW_REQUESTED_EVENT]) { ${historyFields} }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;
const requestsQuery = `query RequestedReviewRequests($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { number reviewRequests(first: 100, after: $after) { ${requestFields} } }
  }
}`;
const historyQuery = `query RequestedReviewHistory($owner: String!, $name: String!, $number: Int!, $after: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number timelineItems(first: 100, after: $after, itemTypes: [REVIEW_REQUESTED_EVENT]) { ${historyFields} }
    }
  }
}`;

const identity = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\s/\u0000-\u001f\u007f]+$/);
const organization = z.object({ login: identity });
const reviewer = z
  .union([
    z.object({ __typename: z.literal("User"), login: identity }),
    z.object({ __typename: z.literal("Team"), slug: identity, organization }),
    // Other RequestedReviewer variants cannot identify the viewer or an org team.
    z.object({ __typename: z.enum(["Bot", "Mannequin", "EnterpriseTeam"]) }),
  ])
  .nullable();
const request = z.object({ requestedReviewer: reviewer });
const event = request.extend({ __typename: z.literal("ReviewRequestedEvent") });
const pageInfo = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().min(1).max(2048).nullable(),
});
function connection<T extends z.ZodType>(node: T, size = 100) {
  return z
    .object({ nodes: z.array(node).max(size), pageInfo })
    .superRefine((page, ctx) => {
      if (
        page.pageInfo.hasNextPage &&
        (!page.nodes.length || !page.pageInfo.endCursor)
      )
        ctx.addIssue({
          code: "custom",
          message:
            "Malformed pagination: next page requires nodes and a cursor.",
        });
    });
}
const requests = connection(request);
const history = connection(event);
const number = z.number().int().positive().max(2147483647);
const candidate = z
  .object({
    number,
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    reviewRequests: requests,
    timelineItems: history,
  })
  .passthrough();
const candidates = connection(candidate, 20);
const team = z.object({
  slug: identity,
  organization: organization.optional(),
  parent: z.unknown().optional(),
});
const envelope = z.object({
  data: z.unknown(),
  errors: z.array(z.unknown()).optional(),
});
const MAX_PAGES = 100;
const MAX_CALLS = 500;
const fail = (message: string): never => {
  throw new Error(`Requested-review fallback: ${message}`);
};
const key = (org: string, slug: string) =>
  `${org.toLowerCase()}/${slug.toLowerCase()}`;

function nextCursor(
  info: z.infer<typeof pageInfo>,
  seen: Set<string>,
): string | null {
  if (info.endCursor !== null) {
    if (seen.has(info.endCursor)) fail("repeated pagination cursor.");
    seen.add(info.endCursor);
  }
  return info.hasNextPage ? info.endCursor : null;
}

/**
 * Compatibility queue: ever requested from the viewer or any of their current teams.
 * Completed reviews and removed/reassigned requests deliberately do not erase history;
 * the API cannot reliably distinguish manual withdrawals from automatic removal.
 * Bounds fail the entire lookup instead of returning a silently incomplete queue.
 */
export async function listRequestedReviews(
  repo: PrRepository,
  api: (args: string[]) => Promise<unknown>,
  validate: (value: unknown, repo: PrRepository) => PrReviewSummary,
  limit = 50,
): Promise<PrReviewSummary[]> {
  z.number().int().min(1).max(50).parse(limit);
  let calls = 0;
  const read = (args: string[]) => {
    if (++calls > MAX_CALLS)
      fail(`API call bound (${MAX_CALLS}) exceeded; queue may be incomplete.`);
    return api(args);
  };
  const viewer = organization
    .parse(await read(["--method", "GET", "user"]))
    .login.toLowerCase();
  const teams = new Set<string>();
  const teamPages = new Set<string>();
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES)
      fail("team page bound exceeded; queue may be incomplete.");
    const items = z
      .array(team)
      .max(100)
      .parse(
        await read(["--method", "GET", `user/teams?per_page=100&page=${page}`]),
      );
    const fingerprint: string[] = [];
    for (const item of items) {
      const org = organization.parse(item.organization).login;
      fingerprint.push(key(org, item.slug));
      let current: z.infer<typeof team> | null = item;
      const parents = new Set<string>();
      while (current) {
        if (parents.size >= 16) fail("team parent depth bound exceeded.");
        if (
          current.organization &&
          current.organization.login.toLowerCase() !== org.toLowerCase()
        )
          fail("team parent organization mismatch.");
        const id = key(org, current.slug);
        if (parents.has(id)) fail("repeated team parent.");
        parents.add(id);
        teams.add(id);
        current = current.parent == null ? null : team.parse(current.parent);
      }
    }
    if (items.length) {
      const signature = fingerprint.sort().join(",");
      if (teamPages.has(signature)) fail("repeated team page.");
      teamPages.add(signature);
    }
    if (items.length < 100) break;
  }
  const matches = (items: z.infer<typeof request>[]) =>
    items.some(({ requestedReviewer: who }) => {
      if (who?.__typename === "User") return who.login.toLowerCase() === viewer;
      if (who?.__typename === "Team")
        return teams.has(key(who.organization.login, who.slug));
      return false;
    });
  const graphql = async <T extends z.ZodType>(
    query: string,
    schema: T,
    pr?: number,
    after?: string | null,
  ): Promise<z.output<T>> => {
    const args = [
      "--method",
      "POST",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `owner=${repo.owner}`,
      "-f",
      `name=${repo.name}`,
    ];
    if (pr !== undefined) args.push("-F", `number=${pr}`);
    if (after !== undefined && after !== null)
      args.push("-f", `after=${after}`);
    const result = envelope.parse(await read(args));
    if (result.errors?.length)
      fail("GraphQL returned errors; queue may be incomplete.");
    return schema.parse(
      z.object({ repository: z.unknown() }).parse(result.data).repository,
    );
  };
  // Only paginate a connection until a match is proven. Never infer nonmatch from
  // the first 100 entries; history alone preserves requests removed by any review.
  const eligible = async (pr: z.infer<typeof candidate>) => {
    if (matches(pr.reviewRequests.nodes) || matches(pr.timelineItems.nodes))
      return true;
    for (const kind of ["reviewRequests", "timelineItems"] as const) {
      let info = pr[kind].pageInfo;
      const cursors = new Set<string>();
      for (let page = 1; ; page++) {
        const after = nextCursor(info, cursors);
        if (!after) break;
        if (page >= MAX_PAGES)
          fail(`${kind} page bound exceeded; queue may be incomplete.`);
        const query = kind === "reviewRequests" ? requestsQuery : historyQuery;
        const schema = kind === "reviewRequests" ? requests : history;
        const result = await graphql(
          query,
          z.object({ pullRequest: z.object({ number }).passthrough() }),
          pr.number,
          after,
        );
        if (result.pullRequest.number !== pr.number)
          fail("GitHub returned the wrong PR.");
        const batch = schema.parse(result.pullRequest[kind]);
        // Validate pagination even if a later page proves a match.
        if (batch.pageInfo.endCursor && cursors.has(batch.pageInfo.endCursor))
          fail("repeated pagination cursor.");
        if (matches(batch.nodes)) return true;
        info = batch.pageInfo;
      }
    }
    return false;
  };
  const output: PrReviewSummary[] = [];
  const cursors = new Set<string>();
  const seenPrs = new Set<number>();
  let after: string | null = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES)
      fail("candidate page bound exceeded; queue may be incomplete.");
    const result = await graphql(
      candidatesQuery,
      z.object({ pullRequests: candidates }),
      undefined,
      after,
    );
    const batch = result.pullRequests;
    const next = nextCursor(batch.pageInfo, cursors);
    for (const pr of batch.nodes) {
      if (seenPrs.has(pr.number)) fail("repeated PR in candidate pagination.");
      seenPrs.add(pr.number);
      const {
        reviewRequests: _requests,
        timelineItems: _history,
        ...value
      } = pr;
      const summary = validate(value, repo);
      if (summary.state !== "MERGED" && (await eligible(pr))) {
        output.push(summary);
        if (output.length === limit) return output;
      }
    }
    if (next === null) return output;
    after = next;
  }
}
