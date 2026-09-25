# jj-stamp

> [!WARNING]
> This is completely AI generated if that wasn't obvious. Maybe don't bother reading the code because I haven't. It's an experiment, and if it works out I might clean it up.

A local, keyboard-first review UI for Jujutsu. Run **`jj-stamp`** in a jj workspace, then click a **change ID in the `jj log` graph** to choose what to review. Select changed lines and squash them into that change's **single mutable immediate parent**—not necessarily `@ → @-`.

Pierre Diffs renders the code; Pierre Trees renders the file sidebar. This experimental branch uses a native TypeScript diff editor: selected file contents are constructed directly, and `jj squash --tool jj-stamp` performs the history rewrite. No hunk tool or patch-application executable is used.

## Install with Nix

Enable Nix flakes and `nix-command`, then from this checkout:

```sh
nix build
./result/bin/jj-stamp --repository /path/to/workspace

# Install the command in your profile:
nix profile add .
```

Now, inside any jj workspace:

```sh
jj-stamp                          # start at @; select changes in the graph
jj-stamp <change-id>              # optionally choose the initial change
jj-stamp @-                      # any expression resolving to one visible change
jj-stamp --no-open --port 8080    # print a URL instead of opening a browser
jj-stamp -R /path/to/workspace
```

Or run without installing, from this checkout:

```sh
nix run . -- --repository /path/to/workspace
```

The flake bundles the browser assets, Node.js, `jj`, and jj-stamp's native diff-editor callback. `flake.lock` pins the Nix inputs. The launcher pins its absolute `jj` executable via `JJ_STAMP_JJ`; callbacks use the same Node.js runtime as the server. There is no Rust/Cargo or GNU `patch` dependency in this branch.

No npm installation or runtime download of assets or bundled tools is needed. Builds may need network access. Your browser and any external helpers configured in jj (for example, signing tools) are not bundled. Linux browser launch uses bundled `xdg-open`; macOS uses system `open`.

The server binds **only to `127.0.0.1`**, uses port **8000** when available (otherwise a free port), and opens the URL in your browser. Keep the terminal running. **Ctrl-C** stops accepting requests and waits for accepted operations to finish. A failed browser launch leaves the server running and prints the URL. An explicit `--port` is never silently changed; use `--port 0` to always request a free port.

The flake exposes a default package/app and development shell for x86_64/aarch64 Linux and macOS. Linux and Apple Silicon use the locked `nixpkgs-unstable`; Intel macOS uses a separate locked 26.05 Darwin input. Builds and installed-package smoke tests are exercised on x86_64 Linux; other platforms are evaluated, not execution-tested here.

## Review

- **Choose a change:** click its ID in the right-hand graph. Immutable changes are disabled. The chosen change is followed by its full change ID through rewrites; moving the working copy or a bookmark does not silently select something else.
- **See the destination:** the file-sidebar footer shows `source → parent`; hover either ID for its full value. A change with two parents, or an immutable parent, shows an error and cannot be squashed. No older ancestor is substituted.
- **Select lines:** drag on code or line numbers to select changed lines for squash. **Shift+click/drag** extends the range from its anchor. A plain click/drag starts a new range; click a selected single line again to clear it. **Alt+drag** selects native browser text instead. Included context is highlighted but never squashed. Switching changes or files clears the selection.
- **Cmd/Ctrl+C:** copy the selected range’s right-hand/new-file code, without diff markers or deleted lines. Native text selections still copy normally.
- **`e`:** open the line under the mouse pointer in your existing Neovim session at `127.0.0.1:4242` (start it with `nvim --listen 127.0.0.1:4242`). Opens the workspace file, not a historical snapshot; `nvim` must be on the CLI’s `PATH`.
- **`s`:** selected changed lines disappear immediately and queue for squash. Real operations run one at a time; selections waiting behind the in-flight squash merge into one follow-up squash. The queue count reflects these batches, not individual selections. Continue selecting while they drain; changing revisions, refreshing, expanding context, and undo wait for an empty queue.
- **Squash a file:** use the **down-arrow-into-node** button in its diff header. This queues every remaining changed line in that file, independent of the current line selection. Read-only files and unavailable destinations stay disabled.
- **`u`:** undo the last app squash when the queue is empty and the repository is unchanged. Undo reverts an entire compacted batch, not just its last selection.
- **Escape:** clear the selection. **`r`:** refresh. **`f`:** focus the diff. **`l`:** toggle the graph.
- Returning to the window or tab automatically refreshes the selected change (no polling). Refresh waits until active selections, drags, and queued operations finish; unchanged state leaves the view untouched. File-sidebar navigation stays available during refresh; squash actions remain disabled until it completes. Failed queues stay paused until explicit refresh or undo. Like manual refresh, a focus refresh snapshots working-copy edits and may invalidate undo after external changes.
- The file tree compacts single-child folder chains into one row (for example, `src/components/ui`). It supports collapsible folders, arrow-key navigation, Enter to open a file, change-status indicators, and live **`+ / −` counts**. Folder choices survive refresh and squash/undo updates.
- **One file / All files** switches between separate file views and all diffs on one scrolling page. In All files, file headings stay pinned while scrolling through their diffs, and the file tree jumps to each file’s heading; selecting lines in another file replaces the previous selection. The view preference persists in `localStorage`.
- **Split / Stacked** switches layouts without changing the exact selection. Split drags select aligned rows in both columns. Stacked lets you select an individual addition or deletion.
- Diff separators use Tree-sitter to show the smallest confidently parsed enclosing function, method, class, interface, implementation, module, or namespace. Supported files are Rust, JavaScript/TypeScript/TSX, Python, Go, Java, C, C++, C#, Ruby, PHP, and Bash. Unsupported, oversized, or syntactically invalid files show no label instead of a heuristic guess; hover a truncated label to see it in full.
- **↑ 10 / ↓ 10** reveals ten context lines at a time.
- Both sidebars collapse to narrow rails; drag their inner edges to resize them. Sidebar widths, collapsed states, and diff layout persist in browser `localStorage`.
- Choose **Dark**, **Dim**, **Light**, **Solarized Dark**, or **Solarized Light** under **settings**. The scheme preference also persists in `localStorage` for this browser origin.

- Failed squashes show the API error code, working directory, full shell-quoted failed command, and full, selectable tool output. Nix builds print the absolute `/nix/store/…/bin/jj` path actually executed. Callback arguments reference a short-lived private manifest that is removed after the invocation; the command is diagnostic, **not a replayable retry**. Inspect history first if the error says it may have changed. If reloading also fails, the original squash diagnostics remain visible alongside the reload error. Dismissing an error never resumes or retries queued work.
- A review stays pinned to its selected change, not the moving working copy. If jj abandons that change (for example, when editing away from an empty undescribed change), the error identifies its full ID. The graph remains available: explicitly select another mutable change to resume review. Missing and divergent changes are reported separately.

The heading groups the **change ID**, **title**, **commit ID**, and change line counts, without the author. The browser tab reads **`<title> (<short change ID> <full repo path>)`**. The graph is rendered by `jj`, with clickable change IDs and a high-contrast selected-change highlight. It uses `visible() & (trunk() | (tracked_remote_bookmarks() & ~::trunk()) | (mutable() & mine())::)` instead of the default log revset or a 100-entry cap. The selected change and working copy are shown only when they match this revset. Graph refreshes wait for queued operations to complete and show recorded history without snapshotting the working copy.

There is no demo creation or reset endpoint. Test fixtures live only in temporary directories.

## Safety and recovery

This is a **single-user local tool**, not a network service. Host and Origin checks reject cross-origin requests and DNS rebinding; mutations require JSON and an app-specific header. The browser cannot select a different repository or override a squash destination.

- Run **one jj-stamp process per repository**. Selection is shared by all tabs connected to that process; do not mutate from multiple tabs simultaneously.
- **Avoid concurrent file edits or jj operations while squashing or undoing.** The in-process queue cannot lock external processes. A race can be detected after a rewrite rather than prevented.
- Each operation validates the exact patch, changed-row indices, source and immediate parent, operation version, conflicts, and mutability. Execution pins full commit IDs and preserves the destination description and emptied source change.
- Conflicts elsewhere in the repository are allowed; the selected source must be conflict-free. Squash resolutions into a conflicted immediate parent incrementally, leaving unselected conflicts for later. Renames/copies, binary or mode changes, missing final newlines, and ambiguous paths/formats are read-only. Merge context is unsupported. Large diff rows are virtualized; optional full-file context reads have size limits.
- Undo uses **`jj op revert` for the attributed app operation**, never `jj op restore`.
- If a queued job fails, unsent jobs are canceled and the actual repository is reloaded. Completed jobs are not rolled back. Failed mutations are never automatically retried.
- Do not close the browser with queued work. An accepted request can finish after a disconnection, but unsent browser-local jobs are lost.

The backend stores **no durable application state on disk**. A native squash temporarily writes a private manifest containing the pinned input and selected output bytes; it is removed after success or failure. An abrupt process/VM crash can leave that private temporary directory behind; it is not a recovery journal and is never reused. Selected revision, preview tokens, undo information and recovery guards exist only in the running process. Existing `operations-*.json` files from older versions are ignored and are not deleted automatically. Browser appearance preferences remain in `localStorage`.

An ambiguous history operation blocks further mutations and revision switching in that process. Inspect `jj op log` and the current diff before restarting; restarting clears only app bookkeeping, never rolls back history or retries a squash. Undo is available only for operations performed by the current process. Do not blindly repeat a selection after an uncertain result. See [backend notes](server/README.md).

## Development

```sh
nix develop
npm ci
npm run build
npm start -- --repository /path/to/workspace --no-open
```

Without Nix, provide Node.js 24+ and `jj` on `PATH`. No hunk tool, Rust toolchain, or external `patch` is needed. Unpack/install the complete `dist/` directory: the bundled CLI must keep its sibling `diff-editor.cjs` and browser assets. `JJ_STAMP_JJ`, when set, selects the same absolute jj executable for reads, mutations and diagnostics.

Native selection currently supports regular, non-executable, lossless UTF-8 text with final newlines (including CRLF). Existing conservative restrictions on binary files, rename/copy/mode changes, merges, and ambiguous paths/formats remain. File snapshots are verified as bytes before applying a selection; there is no context search, offset adjustment, or fuzz.
`npm run build` typechecks and produces **`dist/cli.cjs`**, **`dist/diff-editor.cjs`**, and **`dist/client/`**. The CLI is bundled, so it does not need `node_modules` at runtime. `npm run dev -- -R /path/to/workspace` rebuilds and runs it; restart after source edits.

```sh
npm run check                  # formatting and strict type checking
npm test                       # unit and real-jj backend tests
npx playwright install chromium
npm run test:browser            # browser interactions against fixtures
npm run test:cli                # rebuild and test the bundled executable
nix flake check                 # installed Nix packages and runtime tools
```

`npm run test:all` runs the formatting/type checks and all three npm test suites. Use `npm run format` to apply formatting, or `npm run typecheck` to check types independently. Type checking also rejects unused locals and parameters; it runs as part of every build.

Browser suites share an ephemeral loopback server and Chromium fixture with HMR disabled. Setup failures and test completion close the browser, HTTP server and Vite instance; no fixed development port or running app is required.

Tests use isolated real jj repositories. They cover exact line squashes, optimistic queue compaction/recovery, revision selection and rewrite tracking, immutable/merge guards, stale requests, process-local undo and recovery guards, tree and graph interactions, full-path titles, local HTTP protections, browser launching, and graceful terminal-signal shutdown. Native tests cover exact selection, repeated text, asymmetric context, invalid UTF-8, CRLF, creation/deletion, source-tree preservation, callback inventories and filesystem containment. Nix checks exercise the installed CLI with poisoned obsolete hunk/patch executables on `PATH`, including a real partial squash, undo, and complete native-command error diagnostics.

`@pierre/trees` is pinned to a beta release; review its API when upgrading.

## Responsive browsing

The browser prefetches diffs and full **changed-file** contents for up to **10**
commits from the displayed jj log, nearest to the inspected commit first (commit
row distance, ignoring connectors). It also warms the inspected commit's other
changed files. This is not a preload of entire repository trees.

Actually viewed content is promoted into a separate **30-commit browsing LRU**.
Speculative reads cannot evict or update recency in that LRU. Both pools have
separate diff/content byte budgets; oversized entries may bypass caching. Shared
in-flight requests are deduplicated, and unchanged full commit IDs reuse cached
content across navigation and live-state refreshes. Cache keys never use change
IDs or operation versions. Prefetch pauses while the tab is hidden or foreground
work is pending; already-running pinned reads can finish without causing refetch
loops. Source contents are cached **in memory only**, not localStorage or disk.

A prefetched revision can appear immediately while its live selection validates.
The viewer explicitly marks it as cached/pending and disables squash; it never
becomes mutation authority. Rapid graph clicks coalesce to the latest unsent
selection, with one stateful selection request at a time. Existing log entries
remain clickable while the graph shows “updating…”; navigation uses the latest
validated version, and obsolete graph responses cannot overwrite a newer
selection. Graph metadata is still revalidated, since graph configuration can
change without a history operation.

Tree-sitter scope extraction runs in a bounded worker and caches compact scope
results across file revisits. Syntax highlighting uses at most two workers, and
diff rendering virtualizes offscreen rows, including in all-files mode. Worker
failure leaves browsing available with optional scope labels omitted or local
highlighting fallback. All mutation validation and recovery guards remain live;
display caches do not authorize writes.

## Performance diagnostics

Run a newly built version with tracing enabled, reproduce a few slow change switches and squashes, then stop normally with Ctrl-C:

```sh
jj-stamp --trace -R /path/to/workspace 2> /tmp/jj-stamp-trace.log
```

Each `[jj-stamp timing]` line is a JSON record for one completed backend request (including startup). It contains the operation name, queue wait (stateful queue or independent immutable-read lane), execution time, success/failure, and the start offset/duration of every service-launched subprocess. Timings are milliseconds. The native diff-editor callback is included in the `jj squash (native editor)` duration, not listed separately. Parallel spans overlap; don't sum them to estimate request wall time. Browser rendering, network transfer, and JSON response serialization are outside these backend timings.

Trace records contain no repository paths, revision IDs, command arguments, file contents, or subprocess output. Ordinary errors on stderr can still contain sensitive details. To share only the diagnostic records:

```sh
grep '^\[jj-stamp timing\] ' /tmp/jj-stamp-trace.log > /tmp/jj-stamp-timings.log
```

Send that timings file, your OS and `jj --version`, and roughly how long the UI appeared stuck. Tracing is off by default and does not change validation, caching, or mutation behavior. Keep logs outside the reviewed workspace so logging itself does not create working-copy changes.

The isolated benchmark also measures cold/cached revision switches, squash, undo, and graph refreshes, with optional per-command breakdowns:

```sh
npm run benchmark -- --runs 3 --extra-files 50 --trace
```

For production browser readiness, duplicate reads, and main-thread long tasks:

```sh
npm run build
npm run benchmark:browser -- --runs 3 --extra-files 50 --scope-functions 200 \
  --output /tmp/jj-stamp-responsiveness.json
```

This uses disposable repositories and an ephemeral loopback port. The readiness
metric includes browser automation and two animation frames; it is not INP or a
compositor paint measurement. Wall-clock assertions are not used in CI.

## Source

- `cli.ts` — arguments, local startup, browser launch, shutdown
- `server/http.ts`, `server/api.ts` — loopback HTTP boundary and versioned API
- `server/service.ts`, `server/diff.ts` — revision tracking, exact patches and process-local mutation safety
- `server/selection.ts`, `server/diff-editor.ts` — byte-exact selection and private jj callback
- `server/revision.ts`, `server/editor.ts` — revision metadata parsing and safe workspace-editor dispatch
- `src/main.tsx` — review state, queue coordination and shortcuts
- `src/ReviewWorkspace.tsx`, `src/ReviewToolbar.tsx` — sidebars, revision graph, viewer, status and settings
- `src/ChangedFilesTree.tsx`, `src/CodeDiff.tsx` — Pierre rendering and selection
- `src/content-store.ts`, `src/revision-navigation.ts` — commit-keyed prefetch/cache and coalesced revision selection
- `src/DiffRuntime.tsx`, `src/hunk-context-client.ts` — virtualized diff rendering and bounded highlighting/scope workers
- `src/optimistic.ts`, `src/squash-queue.ts` — speculative UI and sequential dispatch
- `tests/browser-fixture.ts` — shared browser-test setup and teardown
- `flake.nix`, `nix/` — reproducible package, runtime tools, installed-package checks

Licensed under Apache-2.0. The diff parser was adapted from the local `hunk-jj-squash` project without modifying its sources.
