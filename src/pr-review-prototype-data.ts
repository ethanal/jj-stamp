/** Deliberately fixed demo data, not the repository currently open in jj-stamp. */
export const SAMPLE_REPOSITORY = "orbit/notifications";

export interface SamplePullRequest {
  number: number;
  title: string;
  author: string;
  updated: string;
  requested: boolean;
  branch: string;
  summary: string;
  files: string[];
  additions: number;
  deletions: number;
}

export const samplePullRequests: readonly SamplePullRequest[] = [
  {
    number: 284,
    title: "Polish notification delivery",
    author: "mira",
    updated: "12 minutes ago",
    requested: true,
    branch: "mira/delivery-polish",
    summary:
      "Normalize notification subjects, improve retry timing, and tighten delivery defaults. Adds regression coverage for subject whitespace and disabled push notifications.",
    files: [
      "src/notifications.ts",
      "src/preferences.ts",
      "tests/notifications.test.ts",
    ],
    additions: 8,
    deletions: 5,
  },
  {
    number: 281,
    title: "Handle cancellation during queue shutdown",
    author: "sam",
    updated: "38 minutes ago",
    requested: true,
    branch: "sam/drain-on-shutdown",
    summary:
      "Wait for in-flight work before shutting down the delivery queue. Preserve cancellation reasons and avoid dropping pending notifications.",
    files: ["src/queue.ts", "src/worker.ts", "tests/shutdown.test.ts"],
    additions: 142,
    deletions: 27,
  },
  {
    number: 279,
    title: "Add queue saturation metrics",
    author: "jo",
    updated: "2 hours ago",
    requested: true,
    branch: "jo/queue-metrics",
    summary:
      "Expose queue depth and worker utilization so delivery bottlenecks are visible. Includes counters and metric labels for each channel.",
    files: ["src/metrics.ts", "src/queue.ts", "tests/metrics.test.ts"],
    additions: 96,
    deletions: 12,
  },
  {
    number: 276,
    title: "Respect recipient timezone for digest scheduling",
    author: "lea",
    updated: "3 hours ago",
    requested: true,
    branch: "lea/digest-timezones",
    summary:
      "Schedule daily and weekly digests in the recipient’s timezone. Cover daylight-saving transitions and missing timezone preferences.",
    files: ["src/digest.ts", "src/preferences.ts", "tests/digest.test.ts"],
    additions: 187,
    deletions: 44,
  },
  {
    number: 273,
    title: "Improve delivery error diagnostics",
    author: "mira",
    updated: "Yesterday",
    requested: true,
    branch: "mira/error-context",
    summary:
      "Include channel and attempt context in delivery failures without exposing notification bodies or recipient details in logs.",
    files: ["src/errors.ts", "src/notifications.ts"],
    additions: 64,
    deletions: 18,
  },
  {
    number: 271,
    title: "Bound exponential retry backoff",
    author: "sam",
    updated: "Yesterday",
    requested: false,
    branch: "sam/retry-backoff",
    summary:
      "Cap retry delays and make the backoff policy explicit. Covers transient errors, final-attempt failures, and maximum delays.",
    files: ["src/retry.ts", "tests/retry.test.ts"],
    additions: 76,
    deletions: 23,
  },
  {
    number: 268,
    title: "Document notification channel configuration",
    author: "jo",
    updated: "2 days ago",
    requested: false,
    branch: "jo/channel-docs",
    summary:
      "Document per-channel delivery options and provide examples for configuring email, push, and digest preferences.",
    files: ["docs/channels.md", "README.md"],
    additions: 112,
    deletions: 9,
  },
];

export type PrScope = "requested" | "active" | "all";

export function filterSamplePullRequests(
  query: string,
  scope: PrScope,
  activeNumbers: readonly number[],
): SamplePullRequest[] {
  const needle = query.trim().replace(/^#/, "").toLowerCase();
  return samplePullRequests.filter(
    (pr) =>
      (scope === "all" ||
        (scope === "requested"
          ? pr.requested
          : activeNumbers.includes(pr.number))) &&
      `${pr.number} ${pr.title} ${pr.author} ${pr.branch}`
        .toLowerCase()
        .includes(needle),
  );
}

/** Strictly accepts this fixture repository, never fetches arbitrary URLs. */
export function resolveSamplePullRequest(
  input: string,
): { pr: SamplePullRequest; error?: never } | { error: string; pr?: never } {
  const value = input.trim();
  let number: number;
  if (/^#?[1-9]\d*$/.test(value)) {
    number = Number(value.replace(/^#/, ""));
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return {
        error:
          "Enter a positive PR number or an https://github.com/orbit/notifications/pull/NUMBER URL.",
      };
    }
    const path = /^\/orbit\/notifications\/pull\/([1-9]\d*)\/?$/.exec(
      url.pathname,
    );
    if (
      url.protocol !== "https:" ||
      url.host !== "github.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !path
    ) {
      return {
        error:
          "This prototype accepts only https://github.com/orbit/notifications/pull/NUMBER URLs (no query or fragment). Other hosts and repositories are not supported.",
      };
    }
    number = Number(path[1]);
  }
  const pr = Number.isSafeInteger(number)
    ? samplePullRequests.find((candidate) => candidate.number === number)
    : undefined;
  return pr
    ? { pr }
    : {
        error:
          "PR not found in sample data. Try #284, #281, #279, #276, #273, #271, or #268. No network lookup was made.",
      };
}

export interface SampleComment {
  id: string;
  body: string;
  location: string;
  unmapped?: boolean;
}

export interface SampleReview {
  comments: SampleComment[];
  refreshed: boolean;
}

export function createSampleReviews(): Record<number, SampleReview> {
  return {
    284: {
      refreshed: false,
      comments: [
        {
          id: "subject",
          body: "Should an empty subject fall back to a default?",
          location: "src/notifications.ts · new line 21 (sample)",
        },
        {
          id: "retry",
          body: "Should this retry delay be capped?",
          location: "src/notifications.ts · old line 39 (sample)",
          unmapped: true,
        },
      ],
    },
    276: {
      refreshed: true,
      comments: [
        {
          id: "timezone",
          body: "Can we also cover a missing timezone preference?",
          location: "src/digest.ts · sample note",
        },
      ],
    },
    271: { refreshed: true, comments: [] },
  };
}
