import express from "express";
import type { ErrorRequestHandler } from "express";
import { z } from "zod";
import { run } from "./process.ts";
import { ReviewService } from "./service.ts";
import { startLocalServer } from "./http.ts";
import {
  PrGithub,
  oid,
  parsePrInput,
  type PrRunner,
} from "./pr-review-github.ts";
import { PrReviewStore, type PrMetadata } from "./pr-review-store.ts";
import type {
  PrContext,
  PrListResult,
  PrOpenResult,
  PrRepository,
} from "../src/pr-review-types.ts";
import { parseReviewComments } from "../src/review-comments.ts";

export interface PrHandlers {
  context(): PrContext;
  list(): Promise<PrListResult>;
  open(input: string): Promise<PrOpenResult>;
}

export function createPrRouter(handlers: PrHandlers) {
  const router = express.Router();
  router.use("/pr", (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  router.get("/pr/context", (_req, res) => res.json(handlers.context()));
  router.get("/pr/list", async (_req, res) => {
    try {
      res.json(await handlers.list());
    } catch (error) {
      res.status(503).json({
        code: "PR_UNAVAILABLE",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  router.post("/pr/open", express.json({ limit: "4kb" }), async (req, res) => {
    const body = z
      .object({ input: z.string().min(1).max(2048) })
      .strict()
      .safeParse(req.body);
    if (!body.success) {
      res.status(400).json({
        code: "INVALID_INPUT",
        error: "Expected {input: PR number or current-repository GitHub URL}.",
      });
      return;
    }
    try {
      parsePrInput(body.data.input);
      res.json(await handlers.open(body.data.input));
    } catch (error) {
      res.status(422).json({
        code: "PR_OPEN_FAILED",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  const invalidJson: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({
      code: "INVALID_INPUT",
      error: "Expected a small JSON {input: PR number or GitHub URL} object.",
    });
  };
  router.use("/pr/open", invalidJson);
  return router;
}

interface ManagedReview {
  metadata: PrMetadata;
  local: Awaited<ReturnType<typeof startLocalServer>>;
  release(): Promise<void>;
}

/** Owns child services for the lifetime of the original workspace server. */
export class PrReviewManager implements PrHandlers {
  private github: PrGithub;
  private store: PrReviewStore;
  private repository: PrRepository | null = null;
  private reviews = new Map<number, ManagedReview>();
  private originalUrl: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private closing = false;
  private shutdown?: Promise<void>;
  private runner: PrRunner;

  constructor(
    private options: {
      repoPath: string;
      assetsDir: string;
      dataHome?: string;
      runner?: PrRunner;
      onTiming?: ConstructorParameters<typeof ReviewService>[0]["onTiming"];
    },
  ) {
    this.runner = options.runner ?? run;
    this.github = new PrGithub(options.repoPath, this.runner);
    this.store = new PrReviewStore(options.dataHome);
  }

  setOriginalWorkspaceUrl(url: string) {
    this.originalUrl = url;
  }

  context(metadata?: PrMetadata): PrContext {
    return {
      mode: metadata ? "pr" : "workspace",
      repository: metadata?.repository ?? this.repository,
      originalWorkspaceUrl: this.originalUrl,
      pullRequest: metadata?.pullRequest ?? null,
      capabilities: {
        list: true,
        open: true,
        refresh: false,
        submit: false,
        dismiss: false,
        threads: false,
      },
    };
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.closing || this.pending >= 8)
      return Promise.reject(new Error("PR manager is busy or shutting down."));
    this.pending++;
    const result = this.queue.then(task);
    this.queue = result
      .catch(() => undefined)
      .finally(() => {
        this.pending--;
      });
    return result;
  }

  list(): Promise<PrListResult> {
    return this.enqueue(async () => {
      this.repository ??= await this.github.repository();
      return {
        repository: this.repository,
        pullRequests: await this.github.list(this.repository),
        scope: "all-open",
        limit: 50,
      };
    });
  }

  open(input: string): Promise<PrOpenResult> {
    parsePrInput(input);
    return this.enqueue(async () => {
      this.repository ??= await this.github.repository();
      const number = parsePrInput(input, this.repository);
      const existing = this.reviews.get(number);
      if (existing) return { url: existing.local.url };
      // Each managed service can expose a workspace editor and arbitrary local
      // review operations, so cap live workspaces as well as queued requests.
      if (this.reviews.size >= 8)
        throw new Error(
          "At most eight managed PR servers can be open. Restart to close them.",
        );
      const archive = await this.store.acquire(this.repository, number);
      try {
        const metadata = archive.fresh
          ? await this.initialize(this.repository, number, archive.workspace)
          : await archive.read();
        await this.validateProgress(
          archive.workspace,
          metadata,
          !archive.fresh,
        );
        if (archive.fresh) await archive.create(metadata);
        const service = new ReviewService({
          repoPath: archive.workspace,
          revision: `change_id("${metadata.sourceChangeId}")`,
          onTiming: this.options.onTiming,
        });
        await service.getState();
        const local = await startLocalServer({
          service,
          assetsDir: this.options.assetsDir,
          port: 0,
          pr: {
            context: () => this.context(metadata),
            list: () => this.list(),
            open: (next) => this.open(next),
          },
        });
        this.reviews.set(number, { metadata, local, release: archive.release });
        return { url: local.url };
      } catch (error) {
        await archive.release();
        throw error;
      }
    });
  }

  private async command(
    command: string,
    args: string[],
    cwd: string,
    read = false,
  ) {
    return (
      await this.runner(
        command,
        args,
        cwd,
        read ? { maxOutputBytes: 1024 * 1024 } : undefined,
      )
    ).stdout.trim();
  }

  private jj(cwd: string, args: string[], read = false) {
    return this.command(
      "jj",
      ["--no-pager", "--color=never", ...args],
      cwd,
      read,
    );
  }

  private async initialize(
    repository: PrRepository,
    number: number,
    workspace: string,
  ): Promise<PrMetadata> {
    const pullRequest = await this.github.view(repository, number);
    if (pullRequest.state !== "OPEN")
      throw new Error("Only open pull requests can start a new review.");
    await this.jj(this.options.repoPath, [
      "git",
      "init",
      "--colocate",
      workspace,
    ]);
    // Explicit credentials helper is static, never built from user input. No
    // setup-git/global config, checkout, GitHub write API, or inherited origin.
    await this.command(
      "git",
      [
        "-c",
        "credential.helper=",
        "-c",
        "credential.helper=!gh auth git-credential",
        "-c",
        "credential.interactive=false",
        "-c",
        "core.askPass=true",
        "fetch",
        "--quiet",
        "--no-tags",
        "--no-write-fetch-head",
        repository.url,
        `${pullRequest.baseRefOid}:refs/heads/pr-review-base`,
        `refs/pull/${number}/head:refs/heads/pr-review-head`,
      ],
      workspace,
    );
    const head = await this.command(
      "git",
      ["rev-parse", "--verify", "refs/heads/pr-review-head^{commit}"],
      workspace,
      true,
    );
    const base = await this.command(
      "git",
      ["rev-parse", "--verify", "refs/heads/pr-review-base^{commit}"],
      workspace,
      true,
    );
    if (head !== pullRequest.headRefOid || base !== pullRequest.baseRefOid)
      throw new Error(
        "PR moved during fetch. No review was initialized; the incomplete archive is preserved for inspection.",
      );
    const revalidated = await this.github.view(repository, number);
    if (
      revalidated.headRefOid !== head ||
      revalidated.baseRefOid !== base ||
      revalidated.state !== "OPEN"
    )
      throw new Error(
        "PR changed during initialization. No review was initialized.",
      );
    const mergeBaseOid = oid.parse(
      await this.command(
        "git",
        ["merge-base", "--all", head, base],
        workspace,
        true,
      ),
    );
    const headTreeOid = oid.parse(
      await this.command(
        "git",
        ["rev-parse", `${head}^{tree}`],
        workspace,
        true,
      ),
    );
    await this.jj(workspace, ["git", "import"]);
    await this.jj(workspace, [
      "new",
      `commit_id("${mergeBaseOid}")`,
      "-m",
      `Reviewed PR #${number}`,
    ]);
    const reviewedChangeId = await this.jj(
      workspace,
      [
        "log",
        "--ignore-working-copy",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "change_id",
      ],
      true,
    );
    await this.jj(workspace, [
      "new",
      "@",
      "-m",
      `Remaining PR #${number}: ${pullRequest.title}`,
    ]);
    await this.jj(workspace, ["restore", "--from", `commit_id("${head}")`]);
    const sourceChangeId = await this.jj(
      workspace,
      [
        "log",
        "--ignore-working-copy",
        "-r",
        "@",
        "--no-graph",
        "-T",
        "change_id",
      ],
      true,
    );
    return {
      schema: 1,
      repository,
      pullRequest,
      mergeBaseOid,
      headTreeOid,
      sourceChangeId,
      reviewedChangeId,
    };
  }

  private async validateProgress(
    workspace: string,
    metadata: PrMetadata,
    allowComments: boolean,
  ) {
    // No working-copy snapshots or remote updates when validating an archive.
    // Rewrites retain both change IDs. Divergence, abandonment, parent changes,
    // or editing non-annotation bytes require manual inspection.
    const inspect = async (id: string) => {
      const text = await this.jj(
        workspace,
        [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          `change_id("${id}")`,
          "-T",
          'json(commit_id) ++ "\\t" ++ json(parents.map(|p| p.commit_id())) ++ "\\n"',
        ],
        true,
      );
      const lines = text.split("\n");
      if (lines.length !== 1)
        throw new Error(
          "Managed review source is missing or divergent. Inspect the archive manually.",
        );
      const parts = lines[0]!
        .split("\t")
        .map((part) => JSON.parse(part) as unknown);
      if (parts.length !== 2)
        throw new Error("Invalid managed revision metadata.");
      return {
        commit: oid.parse(parts[0]),
        parents: z.array(oid).parse(parts[1]).join(","),
      };
    };
    const source = await inspect(metadata.sourceChangeId);
    const reviewed = await inspect(metadata.reviewedChangeId);
    const workingCopy = await this.jj(
      workspace,
      [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "@",
        "-T",
        'change_id ++ "\\t" ++ commit_id',
      ],
      true,
    );
    if (workingCopy !== `${metadata.sourceChangeId}\t${source.commit}`)
      throw new Error(
        "Managed working copy no longer edits the recorded PR source. The archive was not reset.",
      );
    if (
      source.parents !== reviewed.commit ||
      reviewed.parents !== metadata.mergeBaseOid
    )
      throw new Error(
        "Managed review ancestry changed. The archive was not reset.",
      );
    const tree = await this.command(
      "git",
      ["rev-parse", `${source.commit}^{tree}`],
      workspace,
      true,
    );
    if (tree !== metadata.headTreeOid) {
      if (!allowComments)
        throw new Error(
          "Managed review initial tree differs from the pinned PR head.",
        );
      await this.validateCommentOnlyTree(
        workspace,
        metadata.headTreeOid,
        oid.parse(tree),
      );
    }
  }

  private async validateCommentOnlyTree(
    workspace: string,
    headTree: string,
    sourceTree: string,
  ) {
    const changed = () =>
      new Error(
        "Managed review total tree changed beyond recognized review annotations. The archive was not reset.",
      );
    // Never parse a patch (filenames/content can resemble patch headers). Raw
    // NUL-delimited object identities let unchanged binary files stay opaque.
    const raw = await this.runner(
      "git",
      [
        "diff",
        "--raw",
        "-z",
        "--no-renames",
        "--no-ext-diff",
        "--no-textconv",
        "--abbrev=40",
        headTree,
        sourceTree,
        "--",
      ],
      workspace,
      { maxOutputBytes: 1024 * 1024 },
    );
    const bytes = raw.stdoutBytes ?? Buffer.from(raw.stdout, "utf8");
    let entries: string[];
    try {
      entries = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .split("\0");
    } catch {
      throw changed();
    }
    if (
      entries.pop() !== "" ||
      entries.length === 0 ||
      entries.length > 512 ||
      entries.length % 2
    )
      throw changed();
    let totalBytes = 0;
    for (let index = 0; index < entries.length; index += 2) {
      const match =
        /^:(100644|100755) \1 ([0-9a-f]{40}) ([0-9a-f]{40}) M$/.exec(
          entries[index]!,
        );
      const file = entries[index + 1]!;
      if (
        !match ||
        file === "" ||
        file.startsWith("/") ||
        file
          .split("/")
          .some(
            (part) =>
              !part ||
              part === "." ||
              part === ".." ||
              part === ".jj" ||
              part === ".git",
          )
      )
        throw changed();
      const readBlob = async (blob: string) => {
        const result = await this.runner(
          "git",
          ["cat-file", "blob", blob],
          workspace,
          { maxOutputBytes: 4 * 1024 * 1024 },
        );
        const bytes = result.stdoutBytes ?? Buffer.from(result.stdout, "utf8");
        totalBytes += bytes.length;
        if (totalBytes > 16 * 1024 * 1024) throw changed();
        return bytes;
      };
      const head = await readBlob(match[2]!);
      const source = await readBlob(match[3]!);
      const text = source.toString("utf8");
      if (
        !Buffer.from(text, "utf8").equals(source) ||
        text.includes("\0") ||
        text.startsWith("\ufeff") ||
        !text.endsWith("\n")
      )
        throw changed();
      const parsed = parseReviewComments(file, text);
      if (
        !parsed.editable ||
        !parsed.lexicalSafe ||
        parsed.issues.length ||
        !parsed.comments.length
      )
        throw changed();
      const markers = new Set(
        parsed.comments.flatMap((comment) => comment.markerLines),
      );
      const lines = text.match(/[^\n]*\n/g) ?? [];
      const stripped = Buffer.from(
        lines.filter((_line, index) => !markers.has(index + 1)).join(""),
        "utf8",
      );
      if (!stripped.equals(head)) throw changed();
    }
  }

  close(): Promise<void> {
    if (!this.shutdown) {
      this.closing = true;
      this.shutdown = (async () => {
        await this.queue;
        const results = await Promise.allSettled(
          [...this.reviews.values()].map(async (review) => {
            await review.local.close();
            await review.release();
          }),
        );
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
    }
    return this.shutdown;
  }
}
