import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  oid,
  repositorySchema,
  summarySchema,
  validateSummary,
} from "./pr-review-github.ts";
import type { PrRepository } from "../src/pr-review-types.ts";

const changeId = z.string().regex(/^[k-z]{32}$/);
const legacyMetadataSchema = z
  .object({
    schema: z.literal(2),
    repository: repositorySchema,
    pullRequest: summarySchema,
    mergeBaseOid: oid,
    headTreeOid: oid,
    sourceChangeId: changeId,
    reviewedChangeId: changeId,
    branches: z
      .array(
        z
          .object({
            codeChangeId: changeId,
            commentsChangeId: changeId,
          })
          .strict(),
      )
      .length(2),
  })
  .strict();
const canonicalRepositoryPath = z
  .string()
  .refine(
    (value) =>
      !value.includes("\0") &&
      path.isAbsolute(value) &&
      path.resolve(value) === value,
    "Shared repository must be a canonical absolute path.",
  );
const linkedMetadataSchema = legacyMetadataSchema.extend({
  schema: z.literal(3),
  sharedRepository: canonicalRepositoryPath,
  workspaceName: z.string().regex(/^jj-stamp-pr-[0-9a-f]{64}$/),
});
export const metadataSchema = z.discriminatedUnion("schema", [
  legacyMetadataSchema,
  linkedMetadataSchema,
]);
export type PrMetadata = z.infer<typeof metadataSchema>;

interface PrReviewArchive {
  key: string;
  workspaceName: string;
  fresh: boolean;
  directory: string;
  workspace: string;
  release(): Promise<void>;
  read(): Promise<PrMetadata>;
  create(metadata: PrMetadata): Promise<void>;
}

class UnsupportedArchiveSchema extends Error {}

export async function safeDirectory(directory: string): Promise<void> {
  const stat = await lstat(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(directory)) !== directory
  )
    throw new Error("Managed review storage contains an unsafe directory.");
}

/** Missing/corrupt archives are never silently reinitialized or overwritten. */
export class PrReviewStore {
  readonly root: string;
  readonly sharedRepository?: string;
  private readonly legacyRoot: string;
  private readonly dataHome: string;

  constructor(
    dataHome = process.env.XDG_DATA_HOME ||
      path.join(homedir(), ".local", "share"),
    sharedRepository?: string,
  ) {
    if (!path.isAbsolute(dataHome))
      throw new Error("XDG_DATA_HOME must be absolute.");
    this.dataHome = dataHome;
    this.legacyRoot = path.join(dataHome, "jj-stamp", "pr-reviews");
    this.sharedRepository =
      sharedRepository === undefined
        ? undefined
        : canonicalRepositoryPath.parse(sharedRepository);
    this.root =
      this.sharedRepository === undefined
        ? this.legacyRoot
        : path.join(
            this.legacyRoot,
            "workspaces",
            createHash("sha256").update(this.sharedRepository).digest("hex"),
          );
  }

  async acquire(repo: PrRepository, number: number): Promise<PrReviewArchive> {
    repo = repositorySchema.parse(repo);
    const host = new URL(repo.url).host;
    // Preserve public GitHub's existing archive keys and reservation contents.
    const identity = `${host === "github.com" ? "" : `${host}/`}${repo.nameWithOwner.toLowerCase()}#${number}`;
    const key = createHash("sha256").update(identity).digest("hex");
    const workspaceName = `jj-stamp-pr-${key}`;
    const sharedRepository = this.sharedRepository;
    if (sharedRepository !== undefined) {
      await mkdir(this.legacyRoot, { recursive: true, mode: 0o700 });
      await safeDirectory(this.legacyRoot);
      const legacyKnown = path.join(this.legacyRoot, ".known");
      let legacyReservation = false;
      let legacyArchive = false;
      try {
        await safeDirectory(legacyKnown);
        try {
          await lstat(path.join(legacyKnown, key));
          legacyReservation = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        await lstat(path.join(this.legacyRoot, key));
        legacyArchive = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      // Even incomplete legacy reservations take precedence: never hide
      // existing drafts (or damaged archives) behind a new linked workspace.
      if (legacyReservation || legacyArchive)
        return new PrReviewStore(this.dataHome).acquire(repo, number);
      await safeDirectory(sharedRepository);
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await safeDirectory(this.root);
    const directory = path.join(this.root, key);
    // Keep identity reservations separate from the workspace directory. A
    // deleted/moved archive is not mistaken for a never-opened PR.
    const known = path.join(this.root, ".known");
    await mkdir(known, { recursive: true, mode: 0o700 });
    await safeDirectory(known);
    const marker = path.join(known, key);
    let fresh = false;
    try {
      const markerFile = await open(marker, "wx", 0o600);
      try {
        await markerFile.writeFile(`${identity}\n`);
        await markerFile.sync();
      } finally {
        await markerFile.close();
      }
      fresh = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (fresh) {
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch {
        throw new Error(
          "A reserved managed review directory already exists. It was not overwritten.",
        );
      }
    } else {
      const markerStat = await lstat(marker);
      if (
        !markerStat.isFile() ||
        markerStat.isSymbolicLink() ||
        markerStat.nlink !== 1 ||
        markerStat.size > 1024 ||
        (await readFile(marker, "utf8")) !== `${identity}\n`
      )
        throw new Error(
          "Managed review identity reservation is corrupt. Nothing was recreated.",
        );
    }
    try {
      await safeDirectory(directory);
    } catch {
      throw new Error(
        "Managed review archive is missing or unsafe. It was not recreated; restore the archive manually.",
      );
    }
    const lock = path.join(directory, "active.lock");
    let handle;
    try {
      handle = await open(lock, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`);
      await handle.sync();
    } catch {
      throw new Error(
        `Managed review is locked. Another process may be reviewing it. After an interrupted process, inspect local jj history before manually removing ${lock}. Nothing was recreated.`,
      );
    } finally {
      await handle?.close();
    }
    let released = false;
    const release = async () => {
      if (!released) {
        released = true;
        await unlink(lock);
      }
    };
    const metadataPath = path.join(directory, "review.json");
    const workspace = path.join(directory, "workspace");
    const validateBinding = (metadata: PrMetadata) => {
      if (
        sharedRepository === undefined
          ? metadata.schema !== 2
          : metadata.schema !== 3 ||
            metadata.sharedRepository !== sharedRepository ||
            metadata.workspaceName !== workspaceName
      )
        throw new Error("Archive linked workspace binding mismatch.");
    };
    return {
      key,
      workspaceName,
      fresh,
      directory,
      workspace,
      release,
      async read(): Promise<PrMetadata> {
        try {
          await safeDirectory(workspace);
          const stat = await lstat(metadataPath);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.nlink !== 1 ||
            stat.size > 65536
          )
            throw new Error("Unsafe metadata file.");
          const raw: unknown = JSON.parse(await readFile(metadataPath, "utf8"));
          if (
            raw !== null &&
            typeof raw === "object" &&
            "schema" in raw &&
            raw.schema !== 2 &&
            raw.schema !== 3
          )
            throw new UnsupportedArchiveSchema(
              `Managed review archive schema ${String(raw.schema)} is incompatible with independent COMMENTS branches (schemas 2 and 3). Manual migration is required; no automatic migration or reset was attempted.`,
            );
          const metadata = metadataSchema.parse(raw);
          validateBinding(metadata);
          if (
            new URL(metadata.repository.url).host !== host ||
            metadata.repository.nameWithOwner.toLowerCase() !==
              repo.nameWithOwner.toLowerCase() ||
            metadata.pullRequest.number !== number
          )
            throw new Error("Archive identity mismatch.");
          validateSummary(metadata.pullRequest, metadata.repository);
          return metadata;
        } catch (error) {
          if (error instanceof UnsupportedArchiveSchema) throw error;
          throw new Error(
            "Managed review archive is missing, corrupt, or unsafe. It was not recreated; inspect/restore the archive manually.",
          );
        }
      },
      async create(metadata: PrMetadata) {
        metadataSchema.parse(metadata);
        validateBinding(metadata);
        const output = await open(metadataPath, "wx", 0o600);
        try {
          await output.writeFile(`${JSON.stringify(metadata, null, 2)}\n`);
          await output.sync();
        } finally {
          await output.close();
        }
      },
    };
  }
}
