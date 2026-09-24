import assert from "node:assert/strict";
import test from "node:test";
import { selectHunkBreadcrumb } from "../src/hunk-breadcrumb.ts";
import type { HunkScope } from "../src/hunk-context.ts";

const fn: HunkScope = { label: "fn get_partition_snapshot() {", newLine: 75 };
const impl: HunkScope = {
  label: "impl<B, H> MaterializedViewManager<B, H> {",
  newLine: 69,
};
const scopes = [fn, impl];

test("breadcrumb policy distinguishes declarations above and below a gap", () => {
  assert.equal(
    selectHunkBreadcrumb(scopes, () => undefined),
    fn,
    "the nearest hidden scope wins",
  );
  assert.equal(
    selectHunkBreadcrumb(scopes, (scope) =>
      scope === fn ? "below" : undefined,
    ),
    impl,
    "an upcoming function is skipped in favor of its hidden parent",
  );
  assert.equal(
    selectHunkBreadcrumb(scopes, (scope) =>
      scope === fn ? "above" : undefined,
    ),
    undefined,
    "a function already shown above the gap makes a breadcrumb redundant",
  );
  assert.equal(
    selectHunkBreadcrumb(scopes, () => "below"),
    undefined,
    "no breadcrumb is shown when every enclosing declaration follows the gap",
  );
});
