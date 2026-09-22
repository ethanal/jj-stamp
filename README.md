# jj-stamp

> [!WARNING]
> This is completely AI generated if that wasn't obvious. Maybe don't bother reading the code because I haven't. It's an experiment, and if it works out I might clean it up.

A local, keyboard-first review UI for Jujutsu. Run **`jj-stamp`** in a jj workspace, then click a **change ID in the `jj log` graph** to choose what to review. Select changed lines and squash them into that change's **single mutable immediate parent**—not necessarily `@ → @-`.

Pierre Diffs renders the code; Pierre Trees renders the file sidebar. The existing TypeScript backend uses `jj-hunk-tool` for exact line-level operations.

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

The flake bundles the browser assets, Node.js, `jj`, `jj-hunk-tool`, and GNU `patch`. The hunk tool is pinned to **`817a3d19cab8ed9bf04ebf64f2f3073fe195d641`** in `nix/jj-hunk-tool.nix`, with fixed source and Cargo dependency hashes; `flake.lock` pins the Nix inputs. The installed wrapper puts its packaged tools ahead of ambient `PATH`, so a different globally installed hunk tool does not replace the tested one. The standalone Nix hunk-tool package also wraps its `jj` and GNU `patch` dependencies; listing hunks and previewing patches alone do not exercise the external `patch` command required for mutations.

No npm installation or runtime download of assets or bundled tools is needed. Builds may need network access. Your browser and any external helpers configured in jj (for example, signing tools) are not bundled. Linux browser launch uses bundled `xdg-open`; macOS uses system `open`.

The server binds **only to `127.0.0.1`**, uses port **8000** when available (otherwise a free port), and opens the URL in your browser. Keep the terminal running. **Ctrl-C** stops accepting requests and waits for accepted operations to finish. A failed browser launch leaves the server running and prints the URL. An explicit `--port` is never silently changed; use `--port 0` to always request a free port.

The flake exposes a default package/app and development shell for x86_64/aarch64 Linux and macOS. Linux and Apple Silicon use the locked `nixpkgs-unstable`; Intel macOS uses a separate locked 26.05 Darwin input. Builds and installed-package smoke tests are exercised on x86_64 Linux; other platforms are evaluated, not execution-tested here.

## Review

- **Choose a change:** click its ID in the right-hand graph. Immutable changes are disabled. The chosen change is followed by its full change ID through rewrites; moving the working copy or a bookmark does not silently select something else.
- **See the destination:** the file-sidebar footer shows `source → parent`; hover either ID for its full value. A change with two parents, or an immutable parent, shows an error and cannot be squashed. No older ancestor is substituted.
- **Select lines:** drag on code or line numbers to select changed lines for squash. **Shift+click/drag** extends the range from its anchor. A plain click/drag starts a new range; click a selected single line again to clear it. **Alt+drag** selects native browser text instead. Included context is highlighted but never squashed. Switching changes or files clears the selection.
- **Cmd/Ctrl+C:** copy the selected range’s right-hand/new-file code, without diff markers or deleted lines. Native text selections still copy normally.
- **`e`:** open the line under the mouse pointer in your existing Neovim session at `127.0.0.1:4242` (start it with `nvim --listen 127.0.0.1:4242`). Opens the workspace file, not a historical snapshot; `nvim` must be on the CLI’s `PATH`.
- **`s`:** selected changed lines disappear immediately and queue for squash. Real operations run one at a time. Continue selecting while they drain; changing revisions, refreshing, expanding context, and undo wait for an empty queue.
- **`u`:** undo the last app squash when the queue is empty and the repository is unchanged.
- **Escape:** clear the selection. **`r`:** refresh. **`f`:** focus the diff. **`l`:** toggle the graph.
- The file tree compacts single-child folder chains into one row (for example, `src/components/ui`). It supports collapsible folders, arrow-key navigation, Enter to open a file, change-status indicators, and live **`+ / −` counts**. Folder choices survive refresh and squash/undo updates.
- **One file / All files** switches between separate file views and all diffs on one scrolling page. In All files, the file tree jumps to each file’s heading; selecting lines in another file replaces the previous selection. The view preference persists in `localStorage`.
- **Split / Stacked** switches layouts without changing the exact selection. Split drags select aligned rows in both columns. Stacked lets you select an individual addition or deletion.
- **↑ 10 / ↓ 10** reveals ten context lines at a time.
- Both sidebars collapse to narrow rails; drag their inner edges to resize them. Sidebar widths, collapsed states, and diff layout persist in browser `localStorage`.
- Choose **Dark**, **Dim**, **Light**, **Solarized Dark**, or **Solarized Light** under **settings**. The scheme preference also persists in `localStorage` for this browser origin.

- Failed squashes show the API error code and full, selectable tool output. If reloading also fails, the original squash diagnostics remain visible alongside the reload error. Dismissing an error never resumes or retries queued work.
- A review stays pinned to its selected change, not the moving working copy. If jj abandons that change (for example, when editing away from an empty undescribed change), the error identifies its full ID. The graph remains available: explicitly select another mutable change to resume review. Missing and divergent changes are reported separately.

The heading groups the **change ID**, **title**, **commit ID**, and change line counts, without the author. The browser tab reads **`<title> (<short change ID> <full repo path>)`**. The graph is rendered by `jj`, with clickable change IDs and a high-contrast selected-change highlight. It uses `trunk() | ((tracked_remote_bookmarks() & ~::trunk())::) | (mutable() & mine())::`, plus the selected change and working copy instead of the default log revset or a 100-entry cap. Graph refreshes wait for queued operations to complete and show recorded history without snapshotting the working copy.

There is no demo creation or reset endpoint. Test fixtures live only in temporary directories.

## Safety and recovery

This is a **single-user local tool**, not a network service. Host and Origin checks reject cross-origin requests and DNS rebinding; mutations require JSON and an app-specific header. The browser cannot select a different repository or override a squash destination.

- Run **one jj-stamp process per repository**. Selection is shared by all tabs connected to that process; do not mutate from multiple tabs simultaneously.
- **Avoid concurrent file edits or jj operations while squashing or undoing.** The in-process queue cannot lock external processes. A race can be detected after a rewrite rather than prevented.
- Each operation validates the exact patch, changed-row indices, source and immediate parent, operation version, conflicts, and mutability. Execution pins full commit IDs and preserves the destination description and emptied source change.
- Conflicts elsewhere in the repository are allowed; the selected source and squash destination must be conflict-free. A conflicted immediate parent disables squashing. Renames/copies, binary or mode changes, missing final newlines, and ambiguous paths/formats are read-only. Merge context is unsupported. Very large diffs are not yet virtualized.
- Undo uses **`jj op revert` for the attributed app operation**, never `jj op restore`.
- If a queued job fails, unsent jobs are canceled and the actual repository is reloaded. Completed jobs are not rolled back. Failed mutations are never automatically retried.
- Do not close the browser with queued work. An accepted request can finish after a disconnection, but unsent browser-local jobs are lost.

The backend stores **no application state on disk**. Selected revision, preview tokens, undo information and recovery guards exist only in the running process. Existing `operations-*.json` files from older versions are ignored and are not deleted automatically. Browser appearance preferences remain in `localStorage`.

An ambiguous history operation blocks further mutations and revision switching in that process. Inspect `jj op log` and the current diff before restarting; restarting clears only app bookkeeping, never rolls back history or retries a squash. Undo is available only for operations performed by the current process. Do not blindly repeat a selection after an uncertain result. See [backend notes](server/README.md).

## Development

```sh
nix develop
npm ci
npm run build
npm start -- --repository /path/to/workspace --no-open
```

Without Nix, provide Node.js 24+, `jj`, **GNU `patch` available as `patch`**, and the **same tested hunk-tool revision** on `PATH`. The hunk tool invokes `patch -p1 --silent` when applying a squash, even if preview works without it. Install the hunk tool with Rust/Cargo:

```sh
cargo install --git https://github.com/mvzink/jj-hunk-tool \
  --rev 817a3d19cab8ed9bf04ebf64f2f3073fe195d641 --locked jj-hunk-tool
# Ensure Cargo's bin directory (normally ~/.cargo/bin) is on PATH.
```

Do not install a moving branch or rely on `jj-hunk-tool --version` to verify the pin: multiple revisions report `0.1.0`. `cargo install --list` records the git source/revision for this installation. Unlike the Nix wrapper, non-Nix runs use the first `jj`, `jj-hunk-tool`, and `patch` on `PATH`; keeping them compatible is your responsibility. The revision and Cargo lockfile pin source dependencies, not your host Rust compiler or `jj` version.

`npm run build` typechecks and produces **`dist/cli.cjs`** plus **`dist/client/`**. The CLI is bundled, so it does not need `node_modules` at runtime. `npm run dev -- -R /path/to/workspace` rebuilds and runs it; restart after source edits.

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

Tests use isolated real jj repositories. They cover exact line squashes, optimistic FIFO/recovery, revision selection and rewrite tracking, immutable/merge guards, stale requests, process-local undo and recovery guards, tree and graph interactions, full-path titles, local HTTP protections, browser launching, and graceful terminal-signal shutdown. Nix checks also exercise installed CLI preview, squash, and undo with an empty ambient `PATH`, verify a standalone installed hunk-tool squash under the same restriction, and run the upstream hunk-tool tests.

`@pierre/trees` is pinned to a beta release; review its API when upgrading.

## Performance diagnostics

Run a newly built version with tracing enabled, reproduce a few slow change switches and squashes, then stop normally with Ctrl-C:

```sh
jj-stamp --trace -R /path/to/workspace 2> /tmp/jj-stamp-trace.log
```

Each `[jj-stamp timing]` line is a JSON record for one completed backend request (including startup). It contains the operation name, time waiting in the shared queue, execution time, success/failure, and the start offset/duration of every service-launched subprocess. Timings are milliseconds. Nested commands inside `jj-hunk-tool` are included in that tool's duration, not listed separately. Parallel spans overlap; don't sum them to estimate request wall time. Browser rendering, network transfer, and JSON response serialization are outside these backend timings.

Trace records contain no repository paths, revision IDs, command arguments, file contents, or subprocess output. Ordinary errors on stderr can still contain sensitive details. To share only the diagnostic records:

```sh
grep '^\[jj-stamp timing\] ' /tmp/jj-stamp-trace.log > /tmp/jj-stamp-timings.log
```

Send that timings file, your OS and `jj --version`, and roughly how long the UI appeared stuck. Tracing is off by default and does not change validation, caching, or mutation behavior. Keep logs outside the reviewed workspace so logging itself does not create working-copy changes.

The isolated benchmark also measures cold/cached revision switches, squash, undo, and graph refreshes, with optional per-command breakdowns:

```sh
npm run benchmark -- --runs 3 --extra-files 50 --trace
```

## Source

- `cli.ts` — arguments, local startup, browser launch, shutdown
- `server/http.ts`, `server/api.ts` — loopback HTTP boundary and versioned API
- `server/service.ts`, `server/diff.ts` — revision tracking, exact patches and process-local mutation safety
- `server/revision.ts`, `server/editor.ts` — revision metadata parsing and safe workspace-editor dispatch
- `src/main.tsx` — review state, queue coordination and shortcuts
- `src/ReviewWorkspace.tsx`, `src/ReviewToolbar.tsx` — sidebars, revision graph, viewer, status and settings
- `src/ChangedFilesTree.tsx`, `src/CodeDiff.tsx` — Pierre rendering and selection
- `src/optimistic.ts`, `src/squash-queue.ts` — speculative UI and sequential dispatch
- `tests/browser-fixture.ts` — shared browser-test setup and teardown
- `flake.nix`, `nix/` — reproducible package, runtime tools, installed-package checks

Licensed under Apache-2.0. The diff parser was adapted from the local `hunk-jj-squash` project without modifying its sources.
