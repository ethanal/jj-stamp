# Responsiveness sprint results

Measured September 24, 2026. Application source **`2628113`**; production assets
built by the successful final `npm run test:all`. Only README documentation was
uncommitted during measurement. This report follows the methodology and workload
in [PERF_BASELINE.md](PERF_BASELINE.md): 54 changed files, including a 5,800-line
TypeScript file with 200 separated hunks, Chromium headless on this two-vCPU VM.

## Implemented

- Independent bounded immutable commit/file reads, exact `commit_id(...)`
  expressions, output limits, shutdown draining, and a separate bounded backend
  descriptor cache. No workspace snapshot, source switch, or mutation authority
  is introduced by these reads.
- Browser commit-keyed content cache: **10 speculative commits / 30 demanded
  commits**, separate diff/file byte budgets, in-flight deduplication, demand
  promotion, nearest-log-order prefetch, and foreground/visibility pausing.
  Speculation cannot evict browsing entries or update browsing recency. Admission
  failures and their suppression metadata are also bounded; unchanged candidates
  cannot enter a fetch/evict/refetch loop.
- Cached Tree-sitter scope results in a bounded worker; syntax highlighting in
  at most two workers; virtualized diff rows in single-file and all-files modes.
  Production tests verify actual worker execution, not merely worker asset URLs.
- Immediate display-only cached revision previews while live selection validates.
  Rapid navigation sends one stateful request at a time and coalesces unsent
  intent; stale results never become mutation state. Graph metadata remains live
  because operation IDs alone cannot establish graph configuration freshness.
- Existing optimistic squash, exact mutation validation, recovery guards, undo,
  file navigation, copying, scroll anchoring, themes, and keyboard interactions
  remain covered by regression tests.

## Three-run production comparison

Medians in milliseconds; the paint/readiness proxy includes automation and two
animation frames. It is **not INP, compositor paint time, or pure CPU time**.
Baseline and final runs were not interleaved or CPU-isolated: baseline had other
sprint work running concurrently. Treat the numbers as local observations, not
controlled percentage-speedup claims.

| Interaction              | Baseline paint proxy | Final paint proxy |
| ------------------------ | -------------------: | ----------------: |
| Cold initial diff        |                3,261 |               639 |
| Select changed line      |                  746 |                83 |
| Expand context           |                3,919 |               160 |
| Navigate to another file |                  319 |               142 |
| Revisit large file       |                1,043 |               199 |
| Expand after revisit     |                2,591 |               125 |

Cold scope-label readiness was **1,505 ms** (baseline 4,213 ms); warm revisit
scope readiness was **234 ms** (baseline 1,639 ms). Optional syntax highlighting
may finish later; the readiness metric does not wait for all highlighting.

**No main-thread long tasks were observed in any of the three final runs during
selection, context expansion, file navigation, or revisiting.** Cold startup still
had one or two long tasks per run (median largest task 123 ms). Thus the sprint
removed the measured multi-second browsing stalls, but did not meet every
provisional target: cold work remains, and the automation-inclusive warm-navigation
proxy is still above 100 ms.

### Content traffic and queueing

- Baseline expansion, navigation, revisit, and revisit expansion each made one
  full-content request. All four phases made **zero** such requests in every
  final run.
- The cold settling window now includes **59 full-content requests**, versus
  one baseline request: it warms all 54 changed files plus nearby graph content.
  This intentionally trades background work for later cache hits; it is not a
  reduction in total cold traffic. There is only one speculative task at a time.
  Deterministic tests verify demand progress even when background reads stall.
- Initial content reads no longer queue behind the stateful graph/mutation lane.
  Median maximum observed cold service queue wait was 0 ms, versus 175 ms in the
  baseline. This is workload-specific, not a promise that all reads have zero wait.
- The synthetic contention phase deliberately still calls the **legacy**
  state-bound `/file` API. Its final median was 971 ms, with a 701 ms maximum
  queue-wait median. Its serialized behavior is intentionally unchanged; the UI
  now uses immutable `/commit-file` for display. That legacy synthetic phase also
  still recorded long tasks, so it is not included in the browsing claim above.

## Validation

`npm run test:all` passed on the final application source:

- Formatting and strict TypeScript checks.
- **366** unit/real-jj tests.
- **Nine browser suites**, including production scope-worker/WASM and highlighting
  worker tests, virtualization/scrolling, worker failure fallback, copying,
  selection/squash/undo, nearest-first prefetch, cached pending previews, coalesced
  navigation, configuration-sensitive graph refresh, and stalled background reads.
- **34** bundled CLI tests, including loopback security and graceful draining.
- Production build passed. Existing dependency eval and bundle-size warnings
  remain; no empty worker bundle is emitted.

New safety regressions cover bookmarks named exactly like source/parent commit
hashes, source-shadowing races between metadata and diff reads, cache-object
mutation isolation, stale completions, byte/count limits, and bounded rejection
metadata during traversal of a graph much larger than the cache.

No Nix flake check was run in this sprint. No claim is made about all repositories,
retained browser heap, worker CPU time, or every browser/device combination.

## Reproduction and provenance

```sh
npm run build
npm run benchmark:browser -- --runs 3 --extra-files 50 --scope-functions 200 \
  --output /tmp/jj-stamp-responsiveness-final.json
```

Final measurement timestamp: **2026-09-24T20:06:21.420Z**. Source:
`2628113f2a3109c05a51b74a177a265cb4d8f166`. Entry-asset SHA-256 (index plus directly
referenced entry JS/CSS, not lazy chunks):

```text
4019acf59bae517bd1bd10c4989588ca61196ce5710e0f8599b8f8522a29c414
```

Transient detailed spans remain at `/tmp/jj-stamp-responsiveness-final.json` and
`/tmp/jj-stamp-responsiveness-final-output.txt`; full suite log is
`/tmp/jj-stamp-perf-all.log`. This document retains the durable numerical summary.

## Deferred

Persistent IndexedDB caching, filesystem/repository watchers, graph-content reuse
without live configuration validation, raw Tree-sitter syntax-tree retention,
and further cold-start/bundle work remain follow-ups. Source contents and derived
results are memory-only; localStorage continues to hold appearance preferences.
