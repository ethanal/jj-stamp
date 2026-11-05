import express from "express";
import type { ErrorRequestHandler } from "express";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { run } from "./process.ts";
import { ReviewService } from "./service.ts";
import { resolveRepoDirectory } from "./fs-events.ts";
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
import { validateCommentsLayer } from "./comments-layer.ts";

export interface PrHandlers {
  context(): PrContext;
  list(): Promise<PrListResult>;
  open(input: string): Promise<PrOpenResult>;
  workspace?(
    id: string,
  ): { service: ReviewService; pr: PrHandlers } | undefined;
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
  service: ReviewService;
  pr: PrHandlers;
  id: string;
  url: string;
  release(): Promise<void>;
}

/** Owns child services for the lifetime of the original workspace server. */
export class PrReviewManager implements PrHandlers {
  private github: PrGithub;
  private backend?: {
    root: string;
    sharedRepository: string;
    store: PrReviewStore;
  };
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
  }

  setOriginalWorkspaceUrl(url: string) {
    this.originalUrl = url.endsWith("/") ? url : `${url}/`;
  }

  workspace(id: string) {
    if (this.closing || !/^[0-9a-f]{64}$/.test(id)) return undefined;
    const review = [...this.reviews.values()].find(
      (review) => review.id === id,
    );
    return review ? { service: review.service, pr: review.pr } : undefined;
  }

  private async currentRepository() {
    if (!this.backend) {
      const root = await realpath(
        await this.jj(
          this.options.repoPath,
          ["root", "--ignore-working-copy"],
          true,
        ),
      );
      const sharedRepository = await resolveRepoDirectory(root);
      this.backend = {
        root,
        sharedRepository,
        store: new PrReviewStore(this.options.dataHome, sharedRepository),
      };
    }
    return this.backend;
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
        scope: "review-involves",
        limit: 50,
      };
    });
  }

  open(input: string): Promise<PrOpenResult> {
    parsePrInput(input);
    return this.enqueue(async () => {
      if (!this.originalUrl)
        throw new Error(
          "Start the original workspace server before opening a PR.",
        );
      this.repository ??= await this.github.repository();
      const number = parsePrInput(input, this.repository);
      const existing = this.reviews.get(number);
      if (existing) return { url: existing.url };
      // Each managed service can expose a workspace editor and arbitrary local
      // review operations, so cap live workspaces as well as queued requests.
      if (this.reviews.size >= 8)
        throw new Error(
          "At most eight managed PR workspaces can be open. Restart to close them.",
        );
      const backend = await this.currentRepository();
      const archive = await backend.store.acquire(this.repository, number);
      let service: ReviewService | undefined;
      try {
        const metadata = archive.fresh
          ? await this.initialize(
              this.repository,
              number,
              archive.workspace,
              archive.key,
              archive.workspaceName,
            )
          : await archive.read();
        if (metadata.schema === 3) {
          if (
            metadata.sharedRepository !== backend.sharedRepository ||
            (await resolveRepoDirectory(archive.workspace)) !==
              backend.sharedRepository ||
            metadata.workspaceName !== archive.workspaceName ||
            (await realpath(
              await this.jj(
                archive.workspace,
                [
                  "workspace",
                  "root",
                  "--ignore-working-copy",
                  "--name",
                  metadata.workspaceName,
                ],
                true,
              ),
            )) !== archive.workspace
          )
            throw new Error(
              "Managed review repository or workspace identity changed. The archive was not reset.",
            );
        }
        await this.validateProgress(
          archive.workspace,
          metadata,
          !archive.fresh,
        );
        if (archive.fresh) await archive.create(metadata);
        service = new ReviewService({
          repoPath: archive.workspace,
          revision: `change_id("${metadata.sourceChangeId}")`,
          comments: {
            sourceChangeId: metadata.sourceChangeId,
            reviewedChangeId: metadata.reviewedChangeId,
            branches: metadata.branches,
          },
          onTiming: this.options.onTiming,
        });
        await service.getState();
        const pr: PrHandlers = {
          context: () => this.context(metadata),
          list: () => this.list(),
          open: (next) => this.open(next),
          workspace: (id) => this.workspace(id),
        };
        const url = `${this.originalUrl}reviews/${archive.key}/`;
        this.reviews.set(number, {
          metadata,
          service,
          pr,
          id: archive.key,
          url,
          release: archive.release,
        });
        return { url };
      } catch (error) {
        try {
          await service?.drain();
        } finally {
          await archive.release();
        }
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

  private async backingGitDirectory(workspace: string) {
    return realpath(
      path.resolve(
        workspace,
        await this.jj(
          workspace,
          ["git", "root", "--ignore-working-copy"],
          true,
        ),
      ),
    );
  }

  private async initialize(
    repository: PrRepository,
    number: number,
    workspace: string,
    key: string,
    workspaceName: string,
  ): Promise<PrMetadata> {
    const pullRequest = await this.github.view(repository, number);
    if (pullRequest.state === "MERGED")
      throw new Error("Merged pull requests cannot start a new review.");
    const backend = await this.currentRepository();
    const gitDirectory = await this.backingGitDirectory(backend.root);
    const git = (args: string[], read = false) =>
      this.command(
        "git",
        [`--git-dir=${gitDirectory}`, ...args],
        backend.root,
        read,
      );
    // The archive key separates PRs, and the attempt suffix avoids touching even
    // an existing ref under our namespace. Cached objects still need refs so
    // jj's import can discover objects not already visible in its commit graph.
    const namespace = `refs/heads/jj-stamp/${key}/${randomUUID()}`;
    const refs = [
      {
        oid: pullRequest.baseRefOid,
        ref: `${namespace}/base`,
        source: pullRequest.baseRefOid,
      },
      {
        oid: pullRequest.headRefOid,
        ref: `${namespace}/head`,
        source: `refs/pull/${number}/head`,
      },
    ];
    const missing: string[] = [];
    for (const object of refs) {
      let present = false;
      try {
        await git(["cat-file", "-e", `${object.oid}^{commit}`], true);
        present = true;
      } catch {
        // Fetch below fails visibly if the object is missing for another reason.
      }
      if (present)
        await git([
          "update-ref",
          object.ref,
          object.oid,
          "0".repeat(object.oid.length),
        ]);
      else missing.push(`${object.source}:${object.ref}`);
    }
    // Explicit credentials helper is static, never built from user input. No
    // setup-git/global config, checkout, GitHub write API, or inherited origin.
    if (missing.length)
      await git([
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
        ...missing,
      ]);
    const head = await git(
      ["rev-parse", "--verify", `${namespace}/head^{commit}`],
      true,
    );
    const base = await git(
      ["rev-parse", "--verify", `${namespace}/base^{commit}`],
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
      revalidated.state === "MERGED"
    )
      throw new Error(
        "PR changed during initialization. No review was initialized.",
      );
    const mergeBaseOid = oid.parse(
      await git(["merge-base", "--all", head, base], true),
    );
    const headTreeOid = oid.parse(
      await git(["rev-parse", `${head}^{tree}`], true),
    );
    // Import and workspace creation operate from the original workspace without
    // snapshotting its files or moving its working-copy change.
    await this.jj(backend.root, ["git", "import", "--ignore-working-copy"]);
    await this.jj(backend.root, [
      "workspace",
      "add",
      "--ignore-working-copy",
      "--name",
      workspaceName,
      "--sparse-patterns",
      "full",
      "-r",
      `commit_id("${mergeBaseOid}")`,
      "-m",
      `Reviewed PR #${number}`,
      workspace,
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
    // --ignore-working-copy also skips the new workspace's initial checkout.
    // Finish that checkout only here, while this workspace is freshly created
    // and has never been exposed to a reviewer. Never do this on archive resume.
    await this.jj(workspace, ["workspace", "update-stale"]);
    const checkedOutChangeId = await this.jj(
      workspace,
      [
        "log",
        "--ignore-working-copy",
        "--no-graph",
        "-r",
        "@",
        "-T",
        "change_id",
      ],
      true,
    );
    if (checkedOutChangeId !== reviewedChangeId)
      throw new Error("The new review workspace moved during initialization.");
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
    const branches = [];
    for (const [codeChangeId, label] of [
      [reviewedChangeId, "Reviewed"],
      [sourceChangeId, "Remaining"],
    ] as const) {
      const description = `COMMENTS ${label} PR #${number}`;
      await this.jj(workspace, [
        "new",
        "--no-edit",
        "-r",
        `change_id("${codeChangeId}")`,
        "-m",
        description,
      ]);
      const children = await this.jj(
        workspace,
        [
          "log",
          "--ignore-working-copy",
          "--no-graph",
          "-r",
          `children(change_id("${codeChangeId}"))`,
          "-T",
          'json(change_id) ++ "\\t" ++ json(description.first_line()) ++ "\\n"',
        ],
        true,
      );
      const matches = children
        .split("\n")
        .map((line) =>
          line.split("\t").map((field) => JSON.parse(field) as unknown),
        )
        .filter((row) => row.length === 2 && row[1] === description);
      if (
        matches.length !== 1 ||
        typeof matches[0]![0] !== "string" ||
        !/^[k-z]{32}$/.test(matches[0]![0])
      )
        throw new Error(
          "Could not identify the new independent COMMENTS branch.",
        );
      branches.push({ codeChangeId, commentsChangeId: matches[0]![0] });
    }
    return {
      schema: 3,
      sharedRepository: backend.sharedRepository,
      workspaceName,
      repository,
      pullRequest,
      mergeBaseOid,
      headTreeOid,
      sourceChangeId,
      reviewedChangeId,
      branches,
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
    // Legacy schema-2 archives retain their own isolated backing Git store.
    const gitDirectory = await this.backingGitDirectory(workspace);
    const git = (args: string[]) =>
      this.command(
        "git",
        [`--git-dir=${gitDirectory}`, ...args],
        workspace,
        true,
      );
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
    const tree = await git(["rev-parse", `${source.commit}^{tree}`]);
    if (tree !== metadata.headTreeOid)
      throw new Error(
        "Managed Remaining tree differs from the exact pinned PR head. The archive was not reset.",
      );
    const expectedCode = new Map([
      [metadata.sourceChangeId, source],
      [metadata.reviewedChangeId, reviewed],
    ]);
    const commentsIds = new Set<string>();
    for (const branch of metadata.branches) {
      const code = expectedCode.get(branch.codeChangeId);
      if (
        !code ||
        commentsIds.has(branch.commentsChangeId) ||
        [metadata.sourceChangeId, metadata.reviewedChangeId].includes(
          branch.commentsChangeId,
        )
      )
        throw new Error(
          "Managed COMMENTS branch identities are inconsistent. The archive was not reset.",
        );
      commentsIds.add(branch.commentsChangeId);
      expectedCode.delete(branch.codeChangeId);
      const comments = await inspect(branch.commentsChangeId);
      if (comments.parents !== code.commit)
        throw new Error(
          "Managed COMMENTS branch parent changed. The archive was not reset.",
        );
      const codeTree = oid.parse(
        await git(["rev-parse", `${code.commit}^{tree}`]),
      );
      const commentsTree = oid.parse(
        await git(["rev-parse", `${comments.commit}^{tree}`]),
      );
      if (!allowComments && commentsTree !== codeTree)
        throw new Error("Managed initial COMMENTS branch is not empty.");
    }
    if (expectedCode.size)
      throw new Error(
        "Managed COMMENTS branch coverage is incomplete. The archive was not reset.",
      );
    await validateCommentsLayer(workspace, {
      sourceChangeId: metadata.sourceChangeId,
      reviewedChangeId: metadata.reviewedChangeId,
      branches: metadata.branches,
    });
  }

  close(): Promise<void> {
    if (!this.shutdown) {
      this.closing = true;
      this.shutdown = (async () => {
        await this.queue;
        const results = await Promise.allSettled(
          [...this.reviews.values()].map(async (review) => {
            try {
              await review.service.drain();
            } finally {
              await review.release();
            }
          }),
        );
        this.reviews.clear();
        const failed = results.find((result) => result.status === "rejected");
        if (failed?.status === "rejected") throw failed.reason;
      })();
    }
    return this.shutdown;
  }
}
