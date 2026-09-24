# Responsiveness sprint — proposed plan

Goal: browsing, scrolling, selecting lines, expanding context, and switching
changes should not visibly hang. This is a proposal, not an implementation or a
measured diagnosis. Priorities should be adjusted after the baseline trace.

## Findings from the current code

- `server/service.ts`: every request uses one serial queue. `/file` reads and
  validates state, resolves parents, reads file sides, and validates again.
  Sending many speculative `/file` calls would queue ahead of user actions.
- The backend already caches parsed diffs by repository and immutable commit ID,
  capped at 16 entries. Hits do not update recency; this is not a true LRU.
  There is no corresponding shared full-content cache in the browser.
- `src/CodeDiff.tsx`: visible supported files already fetch full contents for
  scope labels. The component shares an in-flight request, but clears its
  content reference after scope inference; later expansion can request it again.
  Component-local state also disappears on unmount.
- `src/hunk-context.ts`: asynchronous asset loading leads to synchronous
  Tree-sitter parsing on the browser thread. An async function is not a worker.
- `src/ReviewWorkspace.tsx`: all-files mode mounts all file diff components.
  `CodeDiff` parses patches during render and scans rendered rows to paint
  selections. Profile these before deciding the virtualization granularity.
- `src/main.tsx`: focus refresh is already deferred during selection/mutation,
  but an executing refresh disables selection. Switching changes waits for
  validation and diff loading; the graph effect also reruns on state-version
  changes, including selection changes.
- Existing service traces separate queue time from execution/subprocess time.
  Existing performance tests assert process budgets, not wall-clock timings.

## Proposed implementation slices

### 1. Baseline and responsiveness contract

Capture production-build browser traces and service timings for startup, file
switching, context expansion, graph navigation, selection/drag, squash bursts,
undo, and returning to the tab. Exercise many small files, a large source file,
and a large graph, with cold and warm caches. Use disposable repositories.

Measure input-to-feedback, click-to-usable-content, main-thread long tasks,
server queue wait, cache hits/misses, bytes, and speculative work discarded.
Use existing `--trace` and benchmark infrastructure rather than another tracing
system. Correlate background content requests with foreground delays.

Provisional goals on the agreed representative fixture/machine:

- Input feedback within 50 ms; cached file/change browsing usable within 100 ms.
- No app-attributable main-thread task over 50 ms during ordinary warm browsing.
- A cold read may take longer, but scrolling/navigation remains usable and the
  loading status is explicit; no blanking the last useful view.
- Speculative work cannot build an unbounded queue ahead of foreground actions.

Track local latency distributions; keep timing thresholds out of shared CI.

### 2. Shared immutable content layer

Separate display content from live authorization. Introduce bounded read-only
access to pinned commit diffs and changed-file contents without changing the
session's selected revision, snapshotting the workspace, or loading a full live
state per speculative file. Restrict requests to the configured repository and
validated full commit identities/paths; preserve unsupported-file safeguards.

Keep revision selection, workspace snapshots, mutations, and all existing live
safety checks serialized. A separate, tightly bounded immutable-read lane must
never publish current eligibility or replace those checks. Drain it on shutdown.
Do not parallelize existing stateful requests wholesale.

Use shared browser in-memory caches with in-flight deduplication and byte-budgeted
LRU eviction. Key by backend-supplied repository identity, full commit/base
identity, path, and representation version as appropriate—not change ID,
workspace path alone, or the live operation token. Invalidate derived parser
results by parser/schema version. Preserve absent-versus-empty file semantics.

Optimistic squash output must have a distinct identity: never pair a locally
modified patch with cached pre-squash file sides. Disable context reads there
unless they can be reconstructed consistently. Mutations must still privately
read and validate their pinned inputs; display caches do not authorize writes.

### 3. Keep the browser responsive

Move scope parsing to a bounded worker, reuse grammar initialization, and cache
its derived results. Render the diff first; optional labels/highlighting may
arrive later. Reject obsolete worker results after navigation or a rewrite.
Profile patch parsing/highlighting separately and move CPU work only where it
helps; account for worker message-copy and retained-memory costs.

If traces justify it, lazily mount/window offscreen file diffs and graph rows,
then address oversized individual diffs. Preserve file jump targets, scroll
anchors, selection/copy behavior, context expansion, and keyboard navigation.
Reduce broad row scans and unrelated React updates on drag/selection paths.

Keep browsing separate from mutation locks. Show cached pinned content promptly
while validating an explicit revision switch, clearly marking it as pending and
not squashable. Coalesce rapid navigation intent rather than queueing obsolete
switches; an aborted HTTP request does not undo a server-side selection. Only
confirmed server responses establish the active mutation state. Background
refresh must not replace content underneath an active selection.

### 4. Budgeted prefetch, not preload-everything

Priority order:

1. Explicit demand: selected/visible file and context expansion.
2. Other changed files in the inspected commit, near the viewport first.
3. Diffs for hovered/focused and nearby visible graph revisions.
4. Remaining graph diffs opportunistically within byte/time/work limits.
5. Full contents for likely-next revisions only when the budget allows.

“Full contents” means the old/new sides of changed supported files, not complete
repository trees. Start with one speculative request at a time; tune from traces.
Pause on hidden tabs and during foreground mutations; promote matching pending
work on demand and drop obsolete queued jobs. Bound response sizes, cache bytes,
and per-file parsing costs. Cancel reads where safe; never cancel/retry mutations.
Prefetch failures are optional misses, not global review errors.

Separate graph topology/content reuse from its fresh selection-authorization
version. Avoid rebuilding an unchanged graph just because the user selected a
different node, without reusing stale operation/configuration/eligibility data.

### 5. Optional follow-ups, contingent on measured benefit

- Persistent cache: IndexedDB behind the same cache interface, not localStorage.
  Start with memory; persistence mainly targets reloads/revisits. Bound bytes,
  evict by recency, handle quota/corruption/disabled storage as cache misses, and
  provide a clear-cache control. Never persist authorization, undo, or pending
  guards. Review the privacy implications of retaining repository source and
  identity across sessions; persistence should not be necessary for usability.
- Refresh hints: retain focus/manual refresh first. Explore a debounced server
  dirty-generation notification if refresh cost remains material. Repository
  operations and unsnapshotted workspace edits are separate signals. Watcher
  events are hints, not proof of freshness; retain authoritative validation and
  fallback refresh, coalesce mutation-generated events, and defer during drags.
  Do not rely on undocumented jj internal-file layouts as a correctness boundary.

## Regression coverage and exit criteria

Add deterministic tests for cache identity/isolation, eviction/deduplication,
rewrites with stable change IDs, stale worker/network results, optional prefetch
failures, bounded scheduling and foreground priority. Exercise optimistic squash,
undo, unsupported/large files, absent sides, graph recovery, rapid navigation,
and multiple tabs sharing one selected revision. Keep all mutation race tests.

Browser tests should inject slow content/state reads and verify navigation,
scrolling, selection stability, and loading indicators still work. Verify warm
context expansion/file revisit makes no duplicate content request. Test worker
failure and, if implemented, storage failure. Re-run the baseline traces and
compare queue wait, responsiveness, memory, and wasted work—not just throughput.

Recommended first sprint: slices 1–4, ordered by measured bottlenecks, with
persistent caching and watchers explicitly deferred. No application changes are
part of this planning commit.
