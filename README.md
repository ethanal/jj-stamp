# jj-stamp

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

The flake bundles the browser assets, Node.js, `jj`, and a pinned `jj-hunk-tool`. No npm installation, global tools, or network access is needed at runtime. Linux browser launch uses `xdg-open`; macOS uses `open`.

The server binds **only to `127.0.0.1`**, chooses a free port by default, and opens the URL in your browser. Keep the terminal running. **Ctrl-C** stops accepting requests and waits for accepted operations to finish. A failed browser launch leaves the server running and prints the URL.

The flake exposes a default package/app and development shell for x86_64/aarch64 Linux and macOS. Linux and Apple Silicon use the locked `nixpkgs-unstable`; Intel macOS uses a separate locked 26.05 Darwin input. Builds and installed-package smoke tests are exercised on x86_64 Linux; other platforms are evaluated, not execution-tested here.

## Review

- **Choose a change:** click its ID in the right-hand graph. Immutable changes are disabled. The chosen change is followed by its full change ID through rewrites; moving the working copy or a bookmark does not silently select something else.
- **See the destination:** the file-sidebar footer shows `source → parent`; hover either ID for its full value. A change with two parents, or an immutable parent, shows an error and cannot be squashed. No older ancestor is substituted.
- **Select lines:** drag on code or line numbers; Shift-click extends the range. Included context is highlighted but never squashed. Switching changes or files clears the selection.
- **`s`:** selected changed lines disappear immediately and queue for squash. Real operations run one at a time. Continue selecting while they drain; changing revisions, refreshing, expanding context, and undo wait for an empty queue.
- **`u`:** undo the last app squash when the queue is empty and the repository is unchanged.
- **Escape:** clear the selection. **`r`:** refresh. **`f`:** focus the diff. **`l`:** toggle the graph.
- The file tree supports collapsible folders, arrow-key navigation, Enter to open a file, change-status indicators, and live **`+ / −` counts**. Folder choices survive refresh and squash/undo updates.
- **Split / Stacked** switches layouts without changing the exact selection. Split drags select aligned rows in both columns. Stacked lets you select an individual addition or deletion.
- **↑ 10 / ↓ 10** reveals ten context lines at a time.
- Both sidebars collapse to narrow rails. Sidebar and diff-layout preferences are stored locally in the browser.

The heading and browser tab identify the **full repository path**. The graph is rendered by `jj`, with clickable change IDs and the selected change highlighted. It includes the selected change even when that change falls outside the configured default log view. Graph refreshes wait for queued operations to complete.

There is no demo creation or reset endpoint. Test fixtures live only in temporary directories.

## Safety and recovery

This is a **single-user local tool**, not a network service. Host and Origin checks reject cross-origin requests and DNS rebinding; mutations require JSON and an app-specific header. The browser cannot select a different repository or override a squash destination.

- Run **one jj-stamp process per repository**. Selection is shared by all tabs connected to that process; do not mutate from multiple tabs simultaneously.
- **Avoid concurrent file edits or jj operations while squashing or undoing.** The in-process queue cannot lock external processes. A race can be detected after a rewrite rather than prevented.
- Each operation validates the exact patch, changed-row indices, source and immediate parent, operation version, conflicts, and mutability. Execution pins full commit IDs and preserves the destination description and emptied source change.
- Conflicted repositories are rejected. Renames/copies, binary or mode changes, missing final newlines, and ambiguous paths/formats are read-only. Merge context is unsupported. Very large diffs are not yet virtualized.
- Undo uses **`jj op revert` for the attributed app operation**, never `jj op restore`.
- If a queued job fails, unsent jobs are canceled and the actual repository is reloaded. Completed jobs are not rolled back. Failed mutations are never automatically retried.
- Do not close the browser with queued work. An accepted request can finish after a disconnection, but unsent browser-local jobs are lost.

Recovery journals are stored outside the workspace and package:

```text
$XDG_STATE_HOME/jj-stamp/operations-<repository-hash>.json
# Default: ~/.local/state/jj-stamp/
```

An ambiguous history operation leaves a persistent guard that blocks further mutations and revision switching. Inspect `jj op log` and the journal; reconcile history manually before archiving the pending journal and restarting. Do not blindly retry a squash. See [backend notes](server/README.md).

## Development

```sh
nix develop
npm ci
npm run build
npm start -- --repository /path/to/workspace --no-open
```

Without Nix, provide Node.js 24+, `jj`, and `jj-hunk-tool` on `PATH`. `npm run build` typechecks and produces **`dist/cli.cjs`** plus **`dist/client/`**. The CLI is bundled, so it does not need `node_modules` at runtime. `npm run dev -- -R /path/to/workspace` rebuilds and runs it; restart after source edits.

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run test:cli
nix flake check
```

Tests use isolated real jj repositories. They cover exact line squashes, optimistic FIFO/recovery, revision selection and rewrite tracking, immutable/merge guards, stale requests, persisted undo, tree and graph interactions, full-path titles, local HTTP protections, browser launching, and graceful terminal-signal shutdown. Nix checks also exercise the installed CLI with an empty ambient `PATH` and run the upstream hunk-tool tests.

`@pierre/trees` is pinned to a beta release; review its API when upgrading.

## Source

- `cli.ts` — arguments, local startup, browser launch, shutdown
- `server/http.ts`, `server/api.ts` — loopback HTTP boundary and versioned API
- `server/service.ts`, `server/diff.ts` — revision tracking, exact patches, mutation safety and journals
- `src/main.tsx` — review shell, selectable graph, counts and shortcuts
- `src/ChangedFilesTree.tsx`, `src/CodeDiff.tsx` — Pierre rendering and selection
- `src/optimistic.ts`, `src/squash-queue.ts` — speculative UI and sequential dispatch
- `flake.nix`, `nix/` — reproducible package, runtime tools, installed-package checks

Licensed under Apache-2.0. The diff parser was adapted from the local `hunk-jj-squash` project without modifying its sources.
