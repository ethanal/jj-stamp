# Review backend

The CLI constructs `ReviewService({ repoPath, dataDir, revision })` and passes it to `createApi(service)`. Repository and journal paths are explicit. There is no default singleton, demo repository, environment-based repository switch, or reset API. `revision` defaults to `@` and is resolved once at startup to one visible, non-divergent full change ID.

`server/http.ts` serves the bundled UI and router on `127.0.0.1`. It validates Host and Origin before any route, rejects cross-site requests, and requires JSON plus `X-Fold-Request: 1` for mutations. Browser launch and graceful shutdown live in `cli.ts`.

## Tool runtime

The tested `jj-hunk-tool` protocol is pinned to commit `817a3d19cab8ed9bf04ebf64f2f3073fe195d641` in `nix/jj-hunk-tool.nix`. Its `--version` reports only `0.1.0`, so that output alone cannot establish the source revision. The pinned implementation runs `jj squash --tool jj-hunk-tool`; its `_jj-tool` callback then executes the external `patch -p1 --silent` program. **Hunk listings and previews do not exercise this dependency.** Both `jj` and GNU `patch` must be available to the actual tool process (including the nested callback), not merely to the interactive shell. Nix packages must bundle these runtime dependencies; installed checks must perform a real squash, not just a state/preview read.

An installed runtime missing `patch` reproduces `TOOL_FAILED` with `failed to run patch` / `No such file or directory`, even when previews succeed. The API preserves the complete subprocess output and adds an actionable dependency hint. Repair the runtime, refresh and explicitly review/submit again. No dependency fix, read, restart, fallback or error handler automatically retries a squash; unexpected history still retains the recovery guard.

## Revision identity

Reads use `change_id("<full-id>")`, not a moving `@`, bookmark, or mutable commit hash. Source commits are re-resolved live to follow rewrites. Every revision includes `author` (the author name) and `changeIdPrefix` (jj's shortest distinguishing prefix), fetched in the existing metadata queries for state, selection and graph reads. An abandoned or divergent selected change returns `SOURCE_UNAVAILABLE`; it never silently redirects to the working copy. Startup rejects an empty, ambiguous, hidden, or divergent selection with `INVALID_REVISION`.

Explicit `POST /revision` is the only way a running session changes its source. It is serialized and version-checked, rejects immutable changes, preserves the previous source on validation failure, and invalidates old preview tokens on success. The repository-scoped journal remains in place. A pending recovery journal blocks revision switching as well as mutations.

Every state exposes the exact single **conflict-free mutable immediate parent**, or `parent: null` and `squashUnavailable`. Merges and immutable parents cannot squash; an older ancestor is never substituted. A merge can be selected and displays its reason in the UI.

## API

- `GET /state`: selected source, mutable ancestors (`targets`, for the legacy preview API), exact `parent`, optional `squashUnavailable`, Git patches, reconciled tool hunk IDs and one-based patch-body rows, operation/version, and `canUndo`.
- `POST /revision {version,changeId}`: select one visible mutable change; returns `{state}`. The browser supplies a full change ID from the graph. Revision expressions are accepted only as the CLI's initial positional argument, not through this endpoint.
- `GET /graph`: `{version,rows}`. The browser uses this read-only revision-graph endpoint; it skips rendering unused compatibility text and avoids the logging-shaped `/log` path that browser filters may block. Legacy `GET /log` returns `{version,output,rows}` and `GET /log?format=rows` remains an alias for the rows-only response. `output` uses the configured text template with the explicit review revset `trunk() | ((tracked_remote_bookmarks() & ~::trunk())::) | (mutable() & mine())::`. `rows` uses the actual jj graph renderer and a machine-readable template. Each row has `graph` and optional `revision`, `mutable`, `isWorkingCopy`. Connector rows contain only `graph`. The structured view uses the same revset plus the selected change, with no arbitrary 100-entry cap. The app supplies this revset directly instead of fetching the default `revsets.log`. A random delimiter separates graph prefixes from JSON metadata. Descriptions are never interpreted as markup.
- `POST /file {version,path}`: full pinned immediate-parent/source file contents for a supported file in the current diff. New/deleted sides are null. Invalid paths, unsupported formats, merge context, and stale versions are rejected. Reads use literal root-relative filesets after `--`.
- `POST /squash-lines {version,selections:[{id,lines}]}`: squash the exact selected changed rows from the selected change into its single conflict-free mutable immediate parent. No target override or extra properties are accepted. Validates one exact pinned preview, rechecks live state in the same serialized task, and journals the operation before execution. Returns `{state,output,warning?}`.
- `POST /undo {version}`: revert only the last exactly attributed app squash via `jj op revert <operation>`, while the selected-source state and repository operation still match.
- Legacy `POST /preview {version,target,selections:[{id,lines}]}` and `POST /squash {token}` remain for internal compatibility/tests. They are not used by the UI. Whole-hunk selections contain only changed rows; tokens are one-shot, expire after ten minutes, and do not survive restart.

Unknown routes, including `/reset`, return 404. Errors are JSON `{error,code,output?}`. Invalid inputs use 400; stale, conflict, unavailable-source and recovery conditions use 409; unsupported/unsafe previews use 422; tool failures use 500.

## Safety

All requests, including reads (which may snapshot jj), share one serial queue. For diff reads and mutations, one metadata query snapshots the workspace and reads the source, conflicts, parent and mutability; a second query revalidates them after the requested work, followed by an operation-head check. Revision selection batches the old and candidate views into the same two queries. Graph reads use lightweight metadata queries with `--ignore-working-copy` (including cold initialization), never load diffs or invoke the hunk tool, and render with `--at-operation` at the captured operation. Showing the log never snapshots the working copy: it reflects recorded repository history, not unsnapshotted edits. External recorded operations and relevant eligibility/configuration changes during graph reads still invalidate the response. Execution uses full pinned commit IDs and argument arrays, with `--use-destination-message --keep-emptied`. There is no shell interpolation, interactive editor, mutation timeout, or automatic retry.

On POSIX, child tools run in separate process groups with referenced pipes. Terminal Ctrl-C therefore stops the CLI from accepting requests without interrupting a jj history rewrite. Shutdown waits for HTTP requests and the service queue to drain; child processes are not abandoned.

Startup resolves the requested expression and checks `hidden`/`divergent` in one jj query, rather than spawning another process to resolve its visibility. The initial pinned diff/cache read overlaps the non-snapshot operation query; both finish (including on failure) before the queue can advance. Final metadata revalidation and the operation-head check remain sequential. This reduces the deterministic cold-state budget from nine to eight service-launched subprocesses without caching live eligibility or skipping safety checks.

Source diffs and reconciled hunk bodies use a bounded 16-entry cache keyed by repository and immutable commit ID. A cache miss reads one pinned Git diff and one whole-revision hunk listing, regardless of file count. Every file, ordered hunk, ID and body row is reconciled before selections are exposed; malformed file entries are quarantined, while ambiguous paths or duplicate IDs fail the entire listing closed. Returned data is cloned. Unsupported interpretations and transient tool failures are not cached. Operation tokens, working-copy snapshots, mutability/configuration, graph output and full states are never cached. Versions identify the repository path, operation and live revision/eligibility metadata; source commit IDs pin all diff bytes. Transient rendering/tool errors do not change repository versions, and they are retried on the next state read rather than cached. Exact preview rows and locations are still checked before every mutation.

Binary/combined diffs, renames/copies, mode changes, missing final newlines, ambiguous/header-like rows, and whitespace/quoted paths fail closed. Conflicts elsewhere in the repository do not block review or squash. The selected source must be conflict-free, and conflicted ancestors are never squash destinations. A conflicted immediate parent disables immediate-parent squash rather than substituting an older ancestor. Post-squash warnings report newly conflicted changes, not pre-existing conflicts.

The mutation journal is written before execution. Successful attribution requires exactly one operation descended from the validated operation, the expected destination description, and tool attributes naming the pinned source/destination. Unexpected intervening history or ambiguous failure disables undo and further mutations. A later repository read never retries the failed operation.

External jj processes and file edits cannot be locked by this in-process queue. **This is not an atomic cross-process transaction.** An external edit can race final validation and tool execution; detection may occur after squash. Avoid concurrent edits/history operations and run only one app process per repository. Multiple browser tabs share the process's selected change; do not mutate concurrently across tabs.

## Recovery state

The CLI uses `$XDG_STATE_HOME/jj-stamp`, falling back to `~/.local/state/jj-stamp` when the variable is unset or not absolute. `operations-<repository-hash>.json` contains pending-operation guards and attributed undo state. Files are written atomically with mode 0600; no app files are written into the Nix store, checkout, or reviewed working tree.

For `PARTIAL_FAILURE`, `HISTORY_CHANGED`, or `RECOVERY_REQUIRED`, inspect `jj op log --no-pager` and the matching journal. Reconcile history manually, then archive the pending journal and restart to acknowledge recovery. Never blindly repeat the prior squash or use `jj op restore` as an automatic rollback.

Initialization failures are memoized, including corrupt recovery journals. Retrying cannot reinterpret the original `@` or bypass an unread guard. Repair the underlying problem and restart the process.

## Tests

`tests/fixtures.ts` creates isolated real jj repositories solely for tests. Backend/revision tests exercise exact patches, persisted undo, non-@ changes, source switching, workspace and bookmark moves, abandonment/divergence, immutable/merge parents, stale and forbidden requests, graph metadata, cache isolation, failures and interleavings. Browser tests exercise the actual code/tree/graph interactions. CLI tests run the bundled executable outside the source tree and exercise loopback security, opening, validation, and foreground process-group shutdown. Nix checks run the installed package without ambient runtime tools. Performance regressions have deterministic subprocess-count tests (not wall-clock assertions). `npm run benchmark -- --runs 3 --extra-files 50` measures real temporary repositories locally.
