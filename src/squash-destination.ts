import type { RepoState, Revision } from "./types";

/** A custom destination belongs to a reviewed revision, never to the graph filter. */
export interface DestinationChoice {
  sourceId: string;
  mode: "parent" | "custom";
  custom: Revision | null;
}

export function squashDestination(
  state: RepoState | null,
  choice: DestinationChoice | null,
) {
  const current = choice?.sourceId === state?.source.changeId ? choice : null;
  const mode = current?.mode ?? "parent";
  const remembered = current?.custom ?? null;
  const custom =
    state?.targets.find((target) => target.changeId === remembered?.changeId) ??
    remembered;
  const parentReason =
    state?.squashUnavailable ||
    (!state?.parent ? "No mutable immediate parent is available." : "");
  const customReason =
    state?.squashUnavailable ||
    (!remembered
      ? "Choose a revision in the log first."
      : !state?.targets.some(
            (target) => target.changeId === remembered.changeId,
          )
        ? "The chosen revision is no longer an eligible mutable ancestor. Choose another destination or select Parent."
        : "");
  // Retain missing custom metadata for explanation, but never authorize a
  // fallback to Parent or a visible graph row with a similar short ID.
  const target =
    mode === "parent" ? (state?.parent ?? null) : customReason ? null : custom;
  return {
    mode,
    custom,
    target,
    parentReason,
    customReason,
    error: mode === "parent" ? parentReason : customReason,
  };
}
