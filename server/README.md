# Review backend

The CLI constructs `ReviewService({ repoPath, dataDir, revision })` and passes it to `createApi(service)`. Repository and journal paths are explicit. There is no default singleton, demo repository, environment-based repository switch, or reset API. `revision` defaults to `@` and is resolved once at startup to one visible, non-divergent full change ID.

`server/http.ts` serves the bundled UI and router on `127.0.0.1`. It validates Host and Origin before any route, rejects cross-site requests, and requires JSON plus `X-Fold-Request: 1` for mutations. Browser launch and graceful shutdown live in `cli.ts`.

## Revision identity

Reads use `change_id("<full-id>")`, not a moving `@`, bookmark, or mutable commit hash. Source commits are re-resolved live to follow rewrites. An abandoned or divergent selected change returns `SOURCE_UNAVAILABLE`; it never silently redirects to the working copy. Startup rejects an empty, ambiguous, hidden, or divergent selection with `INVALID_REVISION`.

Explicit `POST /revision` is the only way a running session changes its source. It is serialized and version-checked, rejects immutable changes, preserves the previous source on validation failure, and invalidates old preview tokens on success. The repository-scoped journal remains in place. A pending recovery journal blocks revision switching as well as mutations.

Every state exposes the exact single **mutable immediate parent**, or `parent: null` and `squashUnavailable`. Merges and immutable parents cannot squash; an older ancestor is never substituted. A merge can be selected and displays its reason in the UI.

## API

- `GET /state`: selected source, mutable ancestors (`targets`, for the legacy preview API), exact `parent`, optional `squashUnavailable`, Git patches, reconciled tool hunk IDs and one-based patch-body rows, operation/version, and `canUndo`.
- `POST /revision {version,changeId}`: select one visible mutable change; returns `{state}`. The browser supplies a full change ID from the graph. Revision expressions are accepted only as the CLI's initial positional argument, not through this endpoint.
- `GET /log`: `{version,output,rows}`. `output` preserves configured `jj log --limit 100` text. `rows` uses the actual jj graph renderer and a machine-readable template. Each row has `graph` and optional `revision`, `mutable`, `isWorkingCopy`. Connector rows contain only `graph`. The structured view includes up to 99 changes from the configured log revset plus the selected change. A random delimiter separates graph prefixes from JSON metadata. Descriptions are never interpreted as markup.
- `POST /file {version,path}`: full pinned immediate-parent/source file contents for a supported file in the current diff. New/deleted sides are null. Invalid paths, unsupported formats, merge context, and stale versions are rejected. Reads use literal root-relative filesets after `--`.
- `POST /squash-lines {version,selections:[{id,lines}]}`: squash the exact selected changed rows from the selected change into its single mutable immediate parent. No target override or extra properties are accepted. Validates one exact pinned preview, rechecks live state in the same serialized task, and journals the operation before execution. Returns `{state,output,warning?}`.
- `POST /undo {version}`: revert only the last exactly attributed app squash via `jj op revert <operation>`, while the selected-source state and repository operation still match.
- Legacy `POST /preview {version,target,selections:[{id,lines}]}` and `POST /squash {token}` remain for internal compatibility/tests. They are not used by the UI. Whole-hunk selections contain only changed rows; tokens are one-shot, expire after ten minutes, and do not survive restart.

Unknown routes, including `/reset`, return 404. Errors are JSON `{error,code,output?}`. Invalid inputs use 400; stale, conflict, unavailable-source and recovery conditions use 409; unsupported/unsafe previews use 422; tool failures use 500.

## Safety

All requests, including reads (which may snapshot jj), share one serial queue. The operation head, source, conflicts, parent and mutability are read live. Execution uses full pinned commit IDs and argument arrays, with `--use-destination-message --keep-emptied`. There is no shell interpolation, interactive editor, mutation timeout, or automatic retry.

On POSIX, child tools run in separate process groups with referenced pipes. Terminal Ctrl-C therefore stops the CLI from accepting requests without interrupting a jj history rewrite. Shutdown waits for HTTP requests and the service queue to drain; child processes are not abandoned.

Source diffs and reconciled hunk bodies use a bounded 16-entry cache keyed by repository and immutable commit ID. Returned data is cloned. Unsupported interpretations and transient tool failures are not cached. Operation tokens, working-copy snapshots, mutability/configuration, graph output and full states are never cached. Exact preview rows and locations are checked before every mutation.

Binary/combined diffs, renames/copies, mode changes, missing final newlines, ambiguous/header-like rows, and whitespace/quoted paths fail closed. Conflicted repositories cannot be reviewed or squashed.

The mutation journal is written before execution. Successful attribution requires exactly one operation descended from the validated operation, the expected destination description, and tool attributes naming the pinned source/destination. Unexpected intervening history or ambiguous failure disables undo and further mutations. A later repository read never retries the failed operation.

External jj processes and file edits cannot be locked by this in-process queue. **This is not an atomic cross-process transaction.** An external edit can race final validation and tool execution; detection may occur after squash. Avoid concurrent edits/history operations and run only one app process per repository. Multiple browser tabs share the process's selected change; do not mutate concurrently across tabs.

## Recovery state

The CLI uses `$XDG_STATE_HOME/jj-stamp`, falling back to `~/.local/state/jj-stamp` when the variable is unset or not absolute. `operations-<repository-hash>.json` contains pending-operation guards and attributed undo state. Files are written atomically with mode 0600; no app files are written into the Nix store, checkout, or reviewed working tree.

For `PARTIAL_FAILURE`, `HISTORY_CHANGED`, or `RECOVERY_REQUIRED`, inspect `jj op log --no-pager` and the matching journal. Reconcile history manually, then archive the pending journal and restart to acknowledge recovery. Never blindly repeat the prior squash or use `jj op restore` as an automatic rollback.

Initialization failures are memoized, including corrupt recovery journals. Retrying cannot reinterpret the original `@` or bypass an unread guard. Repair the underlying problem and restart the process.

## Tests

`tests/fixtures.ts` creates isolated real jj repositories solely for tests. Backend/revision tests exercise exact patches, persisted undo, non-@ changes, source switching, workspace and bookmark moves, abandonment/divergence, immutable/merge parents, stale and forbidden requests, graph metadata, cache isolation, failures and interleavings. Browser tests exercise the actual code/tree/graph interactions. CLI tests run the bundled executable outside the source tree and exercise loopback security, opening, validation, and foreground process-group shutdown. Nix checks run the installed package without ambient runtime tools.
