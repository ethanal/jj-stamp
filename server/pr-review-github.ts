import { z } from "zod";
import { run, type ProcessResult } from "./process.ts";
import type { PrRepository, PrReviewSummary } from "../src/pr-review-types.ts";

export type PrRunner = (
  command: string,
  args: string[],
  cwd: string,
  limits?: { maxOutputBytes: number },
) => Promise<ProcessResult>;

/** Accept only literal canonical HTTPS URLs, never URL-normalized aliases. */
function canonicalHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    // gh strips "www.", so it cannot target this literal host faithfully.
    url.hostname.startsWith("www.") ||
    value !== `${url.origin}${url.pathname}` ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname) ||
    url.hostname.length > 253 ||
    url.hostname
      .split(".")
      .some(
        (label) =>
          label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
      ) ||
    url.port === "0"
  )
    throw new Error("Expected a canonical HTTPS GitHub URL.");
  return url;
}

const name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/);
export const oid = z.string().regex(/^[0-9a-f]{40}$/);
export const summarySchema = z.object({
  number: z.number().int().positive().max(2147483647),
  title: z.string().max(4096),
  url: z.string().max(2048),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  headRefName: z.string().min(1).max(1024),
  baseRefName: z.string().min(1).max(1024),
  headRefOid: oid,
  baseRefOid: oid,
  // Bot identities can contain "[bot]" or the CLI's "app/" prefix. This
  // display-only field is never used to construct a command or repository URL.
  author: z
    .object({
      login: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[^\u0000-\u001f\u007f]+$/),
    })
    .nullable(),
});
export const repositorySchema = z
  .object({
    owner: name,
    name,
    nameWithOwner: z.string(),
    url: z.string().max(2048),
  })
  .strict()
  .superRefine((repo, ctx) => {
    try {
      const url = canonicalHttpsUrl(repo.url);
      if (
        repo.nameWithOwner !== `${repo.owner}/${repo.name}` ||
        url.pathname !== `/${repo.nameWithOwner}`
      )
        throw new Error("Repository identity does not match its URL.");
    } catch {
      ctx.addIssue({
        code: "custom",
        message:
          "Expected a canonical HTTPS GitHub repository URL matching OWNER/REPO.",
        path: ["url"],
      });
    }
  });

export function repositoryHost(repo: PrRepository): string {
  return new URL(repositorySchema.parse(repo).url).host;
}

const fields = Object.keys(summarySchema.shape).join(",");

export function parsePrInput(input: string, repository?: PrRepository): number {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error(
      "Supply a PR number or an exact current-repository GitHub PR URL.",
    );
  input = input.trim();
  let number = input.replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(number)) {
    let url: URL;
    try {
      url = canonicalHttpsUrl(input);
    } catch {
      throw new Error(
        "Use a positive PR number or a canonical HTTPS PR URL on the current repository's GitHub host (no query, fragment, or extra path).",
      );
    }
    const match =
      /^\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/pull\/([1-9][0-9]*)\/?$/.exec(
        url.pathname,
      );
    if (!match)
      throw new Error(
        "Use a positive PR number or https://HOST/OWNER/REPO/pull/NUMBER (no query, fragment, or extra path).",
      );
    if (
      repository &&
      (url.host !== repositoryHost(repository) ||
        `${match[1]}/${match[2]}`.toLowerCase() !==
          repository.nameWithOwner.toLowerCase())
    )
      throw new Error(
        "Only PRs on the current repository's GitHub host and in the current repository can be opened.",
      );
    number = match[3];
  }
  const parsed = Number(number);
  if (!Number.isSafeInteger(parsed) || parsed > 2147483647)
    throw new Error("PR number is out of range.");
  return parsed;
}

export function validateSummary(
  value: unknown,
  repo: PrRepository,
): PrReviewSummary {
  const summary = summarySchema.parse(value);
  canonicalHttpsUrl(summary.url);
  if (parsePrInput(summary.url, repo) !== summary.number)
    throw new Error("GitHub returned an inconsistent PR URL.");
  return summary;
}

/** All GitHub calls here are read-only CLI queries, with a fixed output budget. */
export class PrGithub {
  constructor(
    private cwd: string,
    private runner: PrRunner = run,
  ) {}

  private async json(args: string[], host?: string): Promise<unknown> {
    try {
      const result = await this.runner("gh", args, this.cwd, {
        maxOutputBytes: 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(
        `GitHub lookup failed. Install gh and run ${host ? `'gh auth login --hostname ${host}'` : "'gh auth login --hostname HOST' for the repository's GitHub host"}, then try again. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async repository(): Promise<PrRepository> {
    const result = z
      .object({
        owner: z.object({ login: name }),
        name,
        nameWithOwner: z.string(),
        url: z.string(),
      })
      .parse(
        await this.json([
          "repo",
          "view",
          "--json",
          "owner,name,nameWithOwner,url",
        ]),
      );
    return repositorySchema.parse({ ...result, owner: result.owner.login });
  }

  async list(repo: PrRepository): Promise<PrReviewSummary[]> {
    const host = repositoryHost(repo);
    return z
      .array(z.unknown())
      .max(50)
      .parse(
        await this.json(
          [
            "pr",
            "list",
            "--repo",
            `${host}/${repo.nameWithOwner}`,
            "--state",
            "open",
            "--limit",
            "50",
            "--json",
            fields,
          ],
          host,
        ),
      )
      .map((item) => validateSummary(item, repo));
  }

  async view(repo: PrRepository, number: number): Promise<PrReviewSummary> {
    const host = repositoryHost(repo);
    const result = validateSummary(
      await this.json(
        [
          "pr",
          "view",
          String(number),
          "--repo",
          `${host}/${repo.nameWithOwner}`,
          "--json",
          fields,
        ],
        host,
      ),
      repo,
    );
    if (result.number !== number)
      throw new Error("GitHub returned the wrong PR.");
    return result;
  }
}
