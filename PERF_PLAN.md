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
LRU eviction. All immutable-content and derived-result cache keys must be based
on full commit IDs, never change IDs. Namespace by backend-supplied repository
identity, and include path, base commit ID, and representation version where
appropriate. File-side caches use that side's owning commit ID; diff caches use
the source commit and pinned base identity. Workspace paths and live operation
tokens are not substitutes for commit identity. Preserve absent-versus-empty
file semantics. Refreshing metadata or switching the selected change must not
invalidate content for unchanged commit IDs.

Optimistic squash output must have a distinct identity: never pair a locally
modified patch with cached pre-squash file sides. Disable context reads there
unless they can be reconstructed consistently. Mutations must still privately
read and validate their pinned inputs; display caches do not authorize writes.

### 3. Keep the browser responsive

Move scope parsing to a bounded worker, reuse grammar initialization, and cache
its derived results across component unmounts, navigation, and metadata refresh.
Deduplicate in-flight parsing as well as file reads. Cache hunk-scope results by
repository, source/base commit IDs, path, diff representation, and grammar/scope
extractor version. A matching entry needs neither a file fetch nor another parse.
Cache empty/no-confident-scope results too; transient failures remain retryable.

Start with compact derived scope results rather than retaining every syntax tree.
If profiling justifies reuse across different hunk queries, add a worker-local
LRU of syntax trees or per-file scope indexes keyed by the file side's full commit
ID, path, and grammar/extractor version. Release WASM trees explicitly on eviction;
only serializable derived results are candidates for later persistent storage.

Render the diff first; optional labels/highlighting may arrive later. Reject
obsolete worker results after navigation or a rewrite. Profile patch parsing/
highlighting separately and move CPU work only where it helps; account for worker
message-copy and retained-memory costs.

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

### 4. Prefetch up to 30 commits from the displayed jj log

The candidate set is the commits included in the app's jj log, not all repository
history and not just graph rows currently inside the viewport. Deduplicate by
full commit ID and take at most 30, prioritizing closeness to the inspected
commit. Initially define closeness as absolute distance in commit-row order,
ignoring connector rows, with deterministic ties. If the inspected commit is
filtered out of the log, serve it on demand and use log order for the candidates.
The selected commit counts toward the cap when present in the log.

Priority order:

1. Explicit demand: selected/visible file and context expansion.
2. Diff and full changed-file contents for the inspected commit.
3. Diff and full changed-file contents for each remaining candidate, nearest
   commit first. Within a commit, fetch its diff before its file sides.

“Full contents” means the old/new sides of changed supported files, not complete
repository trees. Both diffs and contents for the entire capped candidate set
are first-sprint goals, not limited to likely-next commits. Hover/focus can promote
an explicit demand without expanding the background candidate set.

Recompute priorities on selection/log updates, but retain cached and in-flight
work for unchanged commit IDs. No time-based or operation-token-based content
refetch. A rewrite creates a new commit ID and therefore new work; change IDs
are never used to decide content-cache reuse. Network
reads are needed only for missing content (cold cache, eviction, explicit cache
clear, incompatible representation, or retry after a failed fetch).

Start with one speculative request at a time; tune from traces. Pause on hidden
tabs and during foreground mutations; promote matching pending work on demand
and drop obsolete queued jobs. Keep byte/response-size and per-file parsing
limits alongside the 30-commit cap: commit count alone does not bound memory.
If the candidate set exceeds the byte budget, prefer nearer commits and avoid
repeatedly prefetching entries just evicted from the same candidate generation.
Cancel reads where safe; never cancel/retry mutations. Prefetch failures are
optional misses, not global review errors.

Separate graph topology/content reuse from its fresh selection-authorization
version. Avoid rebuilding an unchanged graph just because the user selected a
different node, without reusing stale operation/configuration/eligibility data.

### Cache admission: speculative work must not churn the browsing LRU

Use one commit-keyed entry store with separate retention policies, not a single
LRU that treats background fetches as user accesses:

- Demand-used entries belong to a byte-bounded browsing LRU. Only actual user
  use updates its recency. Prefetch probes, writes, and background parsing do not.
- Speculative-only entries belong to a separately budgeted working set ranked
  by distance in the displayed log. Prefetch cannot evict demand-used entries.
  On user access, promote an entry into the browsing LRU without copying bytes.
- Keep the currently displayed content referenced independently of eviction;
  account for its memory and reduce speculative capacity accordingly. Oversized
  demand content can be displayed without retaining it as a reusable cache entry.
- Admit nearest candidates first and reserve space for in-flight speculative
  reads. Unknown-size responses need a bounded allowance/response-size limit;
  reject oversized results rather than pushing out protected entries. Stop when
  the speculative budget is full instead of evicting earlier, nearer prefetches
  to admit later, farther ones. Distance ties retain existing entries.
- Reconcile the target set by commit ID, retaining its overlap across log and
  selection updates. A closer newly relevant entry may replace a farther
  speculative-only entry, never a demand-used entry. Reject obsolete completions
  that no longer meet admission criteria.
- Remember capacity-rejected/evicted candidates while their admission conditions
  remain unchanged. A routine refresh or priority recomputation must not restart
  a fetch/evict loop. Retry only on explicit demand or a material improvement in
  eligibility/capacity; do not immediately refill speculation displaced by demand.
- Give diffs, full source contents, and parser results separate byte allowances
  so a large source file cannot evict the entire useful diff set. Apply these
  rules to backend caches too, not just the browser cache.

Test a candidate set larger than capacity: after the initial warmup, repeated
refreshes with the same commits must cause zero successful-content refetches,
zero demand-entry evictions from prefetch, and no demand-LRU recency changes.
Also test out-of-order responses, size-estimate overruns, set overlap, promotion,
and foreground use displacing speculative capacity without a refill loop.

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
failures, bounded scheduling and foreground priority. Assert the 30-commit cap,
nearest-first ordering ignoring graph connectors, unchanged-commit reuse across
log refresh/selection, no eviction/refetch loops, and scope-result reuse without
reparsing. Exercise optimistic squash,
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
