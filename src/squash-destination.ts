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
  const selected = mode === "custom" ? (current?.custom ?? null) : null;
  const custom =
    state?.targets.find((target) => target.changeId === selected?.changeId) ??
    selected;
  const parentReason =
    state?.squashUnavailable ||
    (!state?.parent
      ? state?.targets.length
        ? "Choose a destination in the log; this revision has multiple parents."
        : "No mutable immediate parent is available."
      : "");
  const customReason =
    state?.squashUnavailable ||
    (!selected
      ? "Choose a revision in the log first."
      : !state?.targets.some((target) => target.changeId === selected.changeId)
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
