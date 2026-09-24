import type { HunkScope } from "./hunk-context";

export type ScopePosition = "above" | "below";

/** Choose a breadcrumb for omitted context around one rendered separator. */
export function selectHunkBreadcrumb(
  scopes: HunkScope[],
  position: (scope: HunkScope) => ScopePosition | undefined,
): HunkScope | undefined {
  for (const scope of scopes) {
    const rendered = position(scope);
    // The reader has already seen this enclosing declaration above the gap.
    if (rendered === "above") return;
    // A declaration below the gap would duplicate upcoming code, so try its
    // parent before giving up on a useful breadcrumb.
    if (rendered === "below") continue;
    return scope;
  }
}
