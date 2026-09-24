# Responsiveness baseline — September 24, 2026

## Provenance and reproduction

Baseline application source: **`c0c28dae0972829bd9b7b0f6f26f64c1e263f6cc`**.
The existing service benchmark began at **19:34:34 UTC**, before concurrent sprint
edits. Browser measurements finished at **19:41:35 UTC**. These are local smoke
measurements, not statistically controlled performance claims or CI thresholds.

Environment:

- Linux 6.12.93, x86-64, KVM; two logical Intel Xeon Platinum 8259CL CPUs at 2.50 GHz.
- 8,320,557,056 bytes RAM (7.75 GiB); no swap. Shared VM: other sprint agents were
  running concurrently; CPU was **not isolated** and wall times varied substantially.
- Node v24.21.0; npm 11.19.0;
  jj `0.45.1-7c41cdeb16b6b321c64e789a966b6adf723816a5`.
- Playwright Chromium 153.0.8010.12, headless, 1440 × 900, no artificial throttling.

The working directory's pre-existing `dist/client/index.html` had mtime
**17:11:33 UTC**, with no verified source identity. **It was not used.** Instead,
`git archive` exported the baseline commit to a disposable directory, its
`node_modules` linked to the existing installation, and `npm run build` ran there.
The shared checkout/dist was neither rebuilt nor reverted. Baseline production
index mtime: **19:38:01.145 UTC**. SHA-256 over index plus directly referenced
entry JS/CSS (not all lazy chunks):

```text
0235a248b4056545c8c55c2bd6569fc71396b1386af4461628672ecb1304e3c6
```

Suggested repeat command, **after building the intended source version**:

```sh
npm run build
npx tsx scripts/responsiveness.ts --runs 3 --extra-files 50 \
  --scope-functions 200 --output /tmp/jj-stamp-responsiveness.json
```

The script does **not** build implicitly. `--assets /absolute/path/to/dist/client`
selects another build; this changes only browser assets, not imported server
source. `--source-label` records provenance for archive runs; it does not verify
that provenance. Keep service source and browser build matched.

To reproduce the original baseline without disturbing ongoing checkout edits:

```sh
checkout="$PWD"
snapshot=$(mktemp -d /tmp/jj-stamp-perf-source-XXXXXX)
git archive c0c28dae0972829bd9b7b0f6f26f64c1e263f6cc | tar -x -C "$snapshot"
ln -s "$checkout/node_modules" "$snapshot/node_modules"
cp scripts/responsiveness.ts "$snapshot/scripts/responsiveness.ts"
(
  cd "$snapshot"
  npm run build
  npx tsx scripts/responsiveness.ts --runs 3 --extra-files 50 \
    --source-label 'c0c28dae0972829bd9b7b0f6f26f64c1e263f6cc (isolated git archive)' \
    --output /tmp/jj-stamp-responsiveness-baseline.json
)
```

No package script was added. Chromium must already be installed for Playwright.
The benchmark starts the real production static HTTP server (`startLocalServer`,
which mounts `createApi`) on **loopback port 0**, never Vite or a shared port.
It creates, edits, and deletes only its own temporary jj fixtures. Browser,
server, service drain, and fixture disposal run even after assertion failures.

## Existing service benchmark

Command: `/usr/bin/time -p npm run benchmark -- --runs 3 --extra-files 50`.
Output: **3 runs, 53 changed files; local medians; service-launched subprocesses**.

| Action                       | Milliseconds | Subprocesses |
| ---------------------------- | -----------: | -----------: |
| Startup state                |           92 |            7 |
| Warm state                   |           59 |            4 |
| Full log (compatibility API) |           86 |            6 |
| Graph rows (browser)         |           72 |            5 |
| Switch to parent (uncached)  |           75 |            5 |
| Graph after switch (browser) |           73 |            5 |
| Switch back (cached)         |           61 |            4 |
| Switch to source (uncached)  |           80 |            5 |
| Squash one hunk              |          337 |           14 |
| Graph after squash (browser) |           72 |            5 |
| Undo                         |          200 |           13 |

```text
real 5.39
user 3.43
sys 1.41
```

Fixture setup/snapshots are excluded from individual actions but included in
command wall time. These are **not browser interaction timings**.

## Production browser workload and measurement definitions

Each run starts a fresh browser, ReviewService, and real disposable repo based
on `tests/fixtures.ts`. The fixture adds a 93,489-byte TypeScript file with 200
functions and **200 separated changed hunks** (about 5,800 lines), preserving
the demo's three changed files and adding 50 text files: **54 changed files**.
This is intentionally a renderer/scope stress case, not a typical small file.
The OS/page cache is not flushed. Each run:

1. Opens the large TS file; waits for diff rows and a visible enclosing-scope label.
2. Selects a changed line; verifies the selection marker.
3. Expands ten context lines upward; verifies the newly revealed line.
4. Navigates to `src/notifications.ts`; waits for its scope label.
5. Revisits the large file; waits for scope label, then expands context again.
6. Issues a controlled read burst: state read, then concurrent graph/state plus
   four `/api/file` reads. This deliberately exercises the **legacy state-bound
   file API**, even if a future UI uses immutable commit-content endpoints.

Reported `paintMs` is **automation action → requested DOM readiness → two
animation frames**, not a compositor paint timestamp, INP, or pure application
CPU time. `readyMs` additionally waits for a visible scope label and two frames
in the load/navigation phases. In other phases it equals `paintMs`. Scope-ready
latency combines fetch, grammar load, parsing, renderer work, and automation;
there is **no CPU attribution proving which share is scope parsing**. Expansion
is incremental visible context, though `/api/file` transfers full old/new files.

Long Task API entries are collected from before navigation, with an observation
window extending through network-idle and 100 ms settling after readiness. Thus
long-task sums can cover more time than `paintMs`. Event Timing entries ≥16 ms
are retained in JSON; they are event samples, **not an INP score**. Playwright
protocol request timings avoid misleading Node callback times when the browser
main thread is blocked. Full JSON includes API path/file/status/duration,
service queue/execution/subprocess spans, long-task start/duration, event samples,
asset identity, source label, and environment. Counts include both `/api/file`
and `/api/commit-file`, so a future immutable endpoint is not falsely counted as
zero traffic. No persistent client memory, worker-CPU, or compositor profiling
is attempted.

## Browser results (three runs)

All times below are milliseconds. `file req` counts full-content requests per
phase. `LT` is long-task count; `LT ms` is their summed duration; `queue max` is
maximum observed service queue wait in that phase. All API responses were 200;
no browser page errors or readiness assertions failed.

| Run | Phase                 | Paint proxy | Ready | File req |  LT | LT ms | Queue max |
| --: | --------------------- | ----------: | ----: | -------: | --: | ----: | --------: |
|   1 | Cold load             |        3261 |  4213 |        1 |   8 |  3071 |       175 |
|   1 | Select changed line   |         746 |   746 |        0 |   1 |   547 |         0 |
|   1 | Expand context        |        4451 |  4451 |        1 |   3 |  3982 |         0 |
|   1 | Navigate cold         |         584 |   898 |        1 |   3 |   415 |         0 |
|   1 | Revisit warm          |        1141 |  1639 |        1 |   4 |  1241 |         0 |
|   1 | Expand revisit        |        2497 |  2497 |        1 |   3 |  2055 |         0 |
|   1 | Read contention burst |        1009 |  1009 |        4 |   0 |     0 |       788 |
|   2 | Cold load             |        1739 |  2181 |        1 |   7 |  1574 |       171 |
|   2 | Select changed line   |         539 |   539 |        0 |   1 |   380 |         0 |
|   2 | Expand context        |        2573 |  2573 |        1 |   3 |  2275 |         0 |
|   2 | Navigate cold         |         310 |   525 |        1 |   1 |   125 |         0 |
|   2 | Revisit warm          |        1043 |  1923 |        1 |   4 |  1375 |         0 |
|   2 | Expand revisit        |        3767 |  3767 |        1 |   3 |  3083 |         0 |
|   2 | Read contention burst |        1687 |  1687 |        4 |   0 |     0 |      1053 |
|   3 | Cold load             |        3489 |  4315 |        1 |  10 |  3397 |       271 |
|   3 | Select changed line   |        1073 |  1073 |        0 |   1 |   752 |         0 |
|   3 | Expand context        |        3919 |  3919 |        1 |   3 |  3487 |         1 |
|   3 | Navigate cold         |         319 |   538 |        1 |   1 |   108 |         0 |
|   3 | Revisit warm          |         815 |  1282 |        1 |   4 |   939 |         0 |
|   3 | Expand revisit        |        2591 |  2591 |        1 |   3 |  2094 |         0 |
|   3 | Read contention burst |        1074 |  1074 |        4 |   0 |     0 |       754 |

Selected **medians**:

| Phase               | Paint proxy | Scope ready | Longest individual task | Largest event sample |
| ------------------- | ----------: | ----------: | ----------------------: | -------------------: |
| Cold load           |        3261 |        4213 |                    1104 |                   32 |
| Select changed line |         746 |           — |                     547 |                  608 |
| Expand context      |        3919 |           — |                    2585 |                  736 |
| Navigate cold       |         319 |         538 |                     125 |                  104 |
| Revisit warm        |        1043 |        1639 |                     771 |                   32 |
| Expand revisit      |        2591 |           — |                    1325 |                  680 |

Largest-task and largest-event columns take each phase's maximum, then the
median over runs. Millisecond medians for full-file reads (network / service
execution) were cold **688 / 392**, expansion **275 / 271**, other-file navigation
**246 / 238**, revisit **256 / 245**, and revisit expansion **335 / 320**. Every
baseline file read launched **nine subprocesses**, including repeat visits.

Controlled contention burst median wall time was **1074 ms**; maximum queue
wait per run was **788, 1053, 754 ms**. The burst had no browser long tasks:
queueing can delay reads independently of renderer stalls. Cold navigation also
queued a file read behind graph work (maximum queue waits 175/171/271 ms).

```text
real 53.16
user 7.24
sys 2.95
```

The wall time includes repo construction, browser launch, and deliberate settling.
The reported shell user/system times do not reliably account for Chromium's
multiprocess lifetime; do not interpret them as total browser CPU consumption.

## Interpretation and limits

- **Repeat-content traffic is reproducible:** cold load, explicit expansion,
  revisit, and revisit expansion each issue another full-file request. Scope
  hydration and context expansion are not sharing durable contents in this
  baseline. Request counts are more stable than timings on this shared VM.
- **Large visible diff work dominates some interactions:** expansion includes
  multi-second long tasks while service execution is hundreds of milliseconds.
  Selection itself stalls without making any API request. Moving scope parsing
  off-thread alone cannot be assumed to eliminate these renderer/selection costs.
- **Serial service contention is observable:** the synthetic burst illustrates
  head-of-line blocking, not a claimed typical user navigation sequence.
- Cold timing varies roughly 2× across these three runs. A preceding same-workload
  trial had a 1590 ms median cold paint proxy; the final capture has 3261 ms.
  The application source/build did not change. That trial preceded a correction
  to _network timing bookkeeping_, not a performance optimization. Concurrent VM
  activity makes percent-speedup claims from isolated before/after samples unsafe.
- This covers one-file mode, one language, file navigation, selection, and
  incremental context expansion. It does **not** cover all-files virtualization,
  huge/binary content limits, revision navigation in the browser, edit/undo races,
  worker cancellation, retained-memory bounds, or perceived physical-display
  latency. Existing service benchmark covers revision/squash/undo separately.
- Long-task observation does not assign CPU to parsing versus highlighting or
  DOM rendering and cannot see worker-thread tasks. Scope readiness verifies one
  visible label, not completion of every hunk's metadata. Follow-up profiling
  should use traces or scoped instrumentation before making CPU attribution claims.

Validation: baseline production build/typecheck passed; one pilot and two
three-run browser captures completed. The table above uses the **final** capture.
Transient raw files on this VM are `/tmp/jj-stamp-responsiveness-baseline.json`,
`/tmp/jj-stamp-responsiveness-baseline-output.txt`, and
`/tmp/jj-stamp-benchmark-baseline.txt`; their durable numerical summary is this
file. Rerun with `--output` to retain all spans elsewhere.
