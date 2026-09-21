# jj-stamp

Minimal, keyboard-first review of `@` in a real Jujutsu workspace. Diff rendering uses Pierre Diffs; selected lines move through `jj-hunk-tool`.

## Use

- **Drag directly on code** (or line numbers) to select a range. Shift-click extends it. Selected changes have a strong blue fill, a bright gutter marker, and outlined range edges; included context is tinted more softly and is never squashed.
- **`s`** queues selected changed lines **from `@` into `@-`**. They disappear immediately; real squashes run one at a time in the background. Keep selecting while the queue drains. No confirmation dialog or target picker.
- **`u`** undoes the last app squash once the queue is empty, provided the repository is unchanged.
- **Escape** clears the selection. **`r`** refreshes.
- The left sidebar lists files with **`+ / −` counts**. The header shows working-copy totals, the change ID, and the commit ID; hover an ID to see its full value.
- Both sidebars have **collapse / expand buttons**. Collapsed sidebars leave a narrow rail with the expand button; their state is remembered locally.
- The **right-hand panel** shows actual `jj log` output. **`l`** toggles it; **`f`** focuses the diff.
- **Split / Stacked** switches between side-by-side and unified diffs. The layout preference is saved locally. In split view, dragging selects the aligned rows in **both columns**, regardless of where the drag starts. Use Stacked view to select an individual addition or deletion. Switching layout preserves the exact selection.
- **↑ 10 / ↓ 10** reveal ten more context lines above or below the hunk (or the remaining lines at a file boundary).

Only changed rows are squashed, even when a range includes context or spans multiple hunks. Selections can include just one addition or deletion inside a long hunk. A new drag replaces the range; switching files clears it. Working-file contents are preserved.

An immutable immediate parent or merge is rejected, never silently redirected to an older ancestor.

### Optimistic queue

Each selection captures exact file/side/line/text identities. Before dispatching the next queued job, the client remaps those identities onto the newly acknowledged tool hunk IDs and patch indices. It compares the complete predicted changed-row set with the actual result; it never guesses by text alone or reuses a stale version.

Rows and counts update speculatively; the footer shows the queue length. The graph remains confirmed history and refreshes after the queue drains. Context expansion, refresh, reset, and undo wait for an empty queue; code selection, file navigation, and layout switching remain available.

If a job fails, the queue stops, unsent jobs are canceled, and the actual repository is reloaded. Completed jobs are not rolled back automatically, and failed mutations are never retried. Refresh or undo explicitly to resume. The queue lives in browser memory, not durable storage; leaving with work pending triggers a browser warning. An in-flight operation can finish after disconnection, but unsent jobs are not submitted after leaving.

Backend reads cache immutable source diffs, not mutable state or safety decisions. Measured isolated-demo squash latency improved from a median 1.76s to 0.57s; details are in `server/README.md`.

The running VM demo is served on port **8000** by systemd unit **jj-stamp**. **reset demo** creates a new demo repository without deleting the previous one. Tests use independent repositories and never mutate the running demo.

## Run

Requires Node.js 22.12+ (tested on 24), `jj`, and `jj-hunk-tool` on `PATH`.

```sh
git clone https://github.com/ethanal/jj-stamp.git
cd jj-stamp
npm ci
npm run dev                          # http://localhost:8000
npm run demo                         # optional: initialize / print existing demo
```

The first request creates the persistent `orbit` demo. `.data/active-repo.json` records its path; repositories and mutation journals are gitignored.

To use a different **trusted** repository:

```sh
JJ_REPO=/absolute/path/to/workspace PORT=8001 npm start
```

Only server configuration chooses the repository. Reset is disabled for user repositories. Run one jj-stamp process per repository, and use separate data directories/services for independent configured repositories.

### Production

```sh
npm run build
NODE_ENV=production npm start
```

The VM-specific `jj-stamp.service` serves the production build. To deploy changes:

```sh
npm run build
sudo systemctl restart jj-stamp
journalctl -u jj-stamp -n 30 --no-pager
```

The service drains accepted operations during normal shutdown rather than interrupting a history rewrite. Fonts, syntax grammars, themes, and scripts are served locally.

## Safety / limits

This is a single-user, trusted-repository app, **not public multi-tenant hosting**. The exe.dev proxy provides authentication on this VM; the app has no login. Do not expose it without authentication. Mutation requests require JSON, a custom header, and an allowed origin; no CORS access is granted.

- Code coordinates map through the renderer to original one-based **patch-body indices**, not guessed source-line ranges. Context expansion never changes the underlying tool hunk IDs.
- Before squashing, the backend internally validates the exact patch, source, immediate parent, operation version, and tool IDs. It pins commit hashes, keeps destination descriptions, and retains emptied source changes.
- Reads/writes serialize. Stale requests, target overrides, and replayed operations are refused. No interactive tools or automatic mutation retries.
- Undo reverts one attributed operation with `jj op revert`, never `jj op restore`.
- Ambiguous failures leave a durable recovery guard. Inspect `jj op log` before proceeding; see `server/README.md` for recovery details.
- **Avoid concurrent edits or jj commands while squashing/undoing.** The in-process queue cannot lock external processes. A race may be detected only after a mutation, not prevented. Never run two jj-stamp instances against one repository.
- Unsupported tool formats (binary, renames/copies, mode changes, no final newline, ambiguous paths) are read-only. Conflicted repositories are rejected.
- Diffs load one file at a time; very large files are not virtualized yet.

## Test

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

Browser tests exercise real code dragging, single-line and 3-of-40-line squashes, Split/Stacked selection, immediate-parent routing, keyboard undo, graph output, ten-line context expansion, optimistic counts, artificially delayed FIFO jobs, selection preservation across acknowledgements, and injected failures with actual-state recovery. Backend tests cover stale versions, invalid paths, immutable/merge parents, target overrides, pinned file contents, exact patches, persisted undo, and failure/interleaving recovery.

Fixtures remain in `/tmp/fold-backend-*` and `/tmp/fold-browser-*` for inspection. App source is Git-managed separately from the demo jj repositories.

## Source

- `src/main.tsx` — minimal shell, file list, right-side log, counts, shortcuts
- `src/CodeDiff.tsx` — code-drag selection and context expansion
- `src/selection.ts` — exact selected patch rows
- `src/optimistic.ts`, `src/squash-queue.ts` — speculative diffs, exact remapping, sequential dispatch, failure recovery
- `server/api.ts`, `server/service.ts` — versioned reads and safe mutations
- `server/diff.ts` — fail-closed parsing and patch reconciliation
- `server/demo.ts` — non-destructive demo creation

The parser was adapted from the existing local `hunk-jj-squash` project without modifying it. UI styling takes cues from Hunk’s terminal diff viewer.
