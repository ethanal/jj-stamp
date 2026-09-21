export interface Revision {
  changeId: string;
  commitId: string;
  description: string;
  author?: string;
  /** jj's shortest distinguishing prefix, not an arbitrary fixed truncation. */
  changeIdPrefix?: string;
}

/** Common identity fields shared by state, selection, and graph metadata reads. */
export const revisionFieldsTemplate =
  'json(change_id) ++ "\\t" ++ json(commit_id) ++ "\\t" ++ json(description.first_line()) ++ "\\t" ++ json(author.name()) ++ "\\t" ++ json(change_id.shortest(8).prefix())';
export const revisionTemplate = revisionFieldsTemplate + ' ++ "\\n"';

interface RevisionRecord {
  revision: Revision;
  flags: boolean[];
}

/** Parse one tab-separated jj template row and fail closed on extra metadata. */
export function parseRevisionRecord(
  line: string,
  flagCount: number,
  identityError: string,
  flagError = identityError,
): RevisionRecord {
  const [
    changeId,
    commitId,
    description,
    author,
    changeIdPrefix,
    ...flags
  ]: unknown[] = line.split("\t").map((value) => JSON.parse(value));
  if (
    typeof changeId !== "string" ||
    !/^[k-z]+$/.test(changeId) ||
    typeof commitId !== "string" ||
    !/^[0-9a-f]{40,64}$/.test(commitId) ||
    typeof description !== "string" ||
    typeof author !== "string" ||
    typeof changeIdPrefix !== "string" ||
    !changeIdPrefix ||
    !changeId.startsWith(changeIdPrefix)
  ) {
    throw new Error(identityError);
  }
  if (
    flags.length !== flagCount ||
    flags.some((flag) => typeof flag !== "boolean")
  ) {
    throw new Error(flagError);
  }
  return {
    revision: { changeId, commitId, description, author, changeIdPrefix },
    flags: flags as boolean[],
  };
}
