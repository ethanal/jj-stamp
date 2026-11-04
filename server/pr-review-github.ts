import { z } from "zod";
import { run, type ProcessResult } from "./process.ts";
import type { PrRepository, PrReviewSummary } from "../src/pr-review-types.ts";

export type PrRunner = (
  command: string,
  args: string[],
  cwd: string,
  limits?: { maxOutputBytes: number },
) => Promise<ProcessResult>;

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
    url: z.string(),
  })
  .strict();
const fields = Object.keys(summarySchema.shape).join(",");

export function parsePrInput(input: string, repository?: PrRepository): number {
  if (typeof input !== "string" || input.length > 2048)
    throw new Error(
      "Supply a PR number or an exact current-repository GitHub PR URL.",
    );
  input = input.trim();
  let number = input.replace(/^#/, "");
  if (!/^[1-9][0-9]*$/.test(number)) {
    const match =
      /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/([A-Za-z0-9][A-Za-z0-9_.-]*)\/pull\/([1-9][0-9]*)\/?$/.exec(
        input,
      );
    if (!match)
      throw new Error(
        "Use a positive PR number or https://github.com/OWNER/REPO/pull/NUMBER (no query, fragment, or extra path).",
      );
    if (
      repository &&
      `${match[1]}/${match[2]}`.toLowerCase() !==
        repository.nameWithOwner.toLowerCase()
    )
      throw new Error("Only PRs in the current repository can be opened.");
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

  private async json(args: string[]): Promise<unknown> {
    try {
      const result = await this.runner("gh", args, this.cwd, {
        maxOutputBytes: 1024 * 1024,
      });
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(
        `GitHub lookup failed. Install gh and run 'gh auth login' for github.com, then try again. ${error instanceof Error ? error.message : String(error)}`,
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
    const repo = { ...result, owner: result.owner.login };
    if (
      repo.nameWithOwner !== `${repo.owner}/${repo.name}` ||
      repo.url !== `https://github.com/${repo.nameWithOwner}`
    )
      throw new Error("Only canonical github.com repositories are supported.");
    return repo;
  }

  async list(repo: PrRepository): Promise<PrReviewSummary[]> {
    return z
      .array(z.unknown())
      .max(50)
      .parse(
        await this.json([
          "pr",
          "list",
          "--repo",
          repo.nameWithOwner,
          "--state",
          "open",
          "--limit",
          "50",
          "--json",
          fields,
        ]),
      )
      .map((item) => validateSummary(item, repo));
  }

  async view(repo: PrRepository, number: number): Promise<PrReviewSummary> {
    const result = validateSummary(
      await this.json([
        "pr",
        "view",
        String(number),
        "--repo",
        repo.nameWithOwner,
        "--json",
        fields,
      ]),
      repo,
    );
    if (result.number !== number)
      throw new Error("GitHub returned the wrong PR.");
    return result;
  }
}
