# Review backend

`server/api.ts` exports the Express router mounted at `/api`. It lazily initializes the active repository. Run `npx tsx scripts/setup-demo.ts` to initialize explicitly; rerunning this script preserves the existing active repo.

- Set `JJ_REPO=/absolute/path` to review a user repository. Otherwise `.data/active-repo.json` persists the active generated **orbit** demo.
- The demo has the current `Polish notification delivery` revision, two mutable ancestors, three TypeScript files, and six independent hunks.
- `POST /reset` only works on a generated demo. It creates another directory and retains the previous one. User repositories are never reset.

## API

- `GET /state`: current `@`, exact immediate mutable `parent: Revision | null`, `squashUnavailable?` reason, Git patches, reconciled tool hunk IDs and 1-based patch-body rows, operation/version, and `canUndo`. Legacy `targets` remains available, but is not used to choose a destination for immediate squash. An immutable parent or merge never falls back to an older ancestor.
- `POST /squash-lines {version,selections:[{id,lines}]}`: immediately squash the exact selected changed rows from `@` into its single mutable immediate parent. No target or other extra properties are accepted. Internally creates, validates, consumes, and revalidates a one-shot preview in one serial queue task, then uses the existing mutation journal and operation attribution. Returns `{state,output,warning?}`; no confirmation token is exposed.
- `GET /log`: `{version,output}` with real `jj log --no-pager --color=never --limit 100` output (default graph and configured jj template, not an app-generated log). State is validated before and after the read.
- `POST /file {version,path}`: `{oldFile:{name,contents}|null,newFile:{name,contents}|null}` containing the full pinned immediate-parent and `@` contents for one supported file in the current diff. New files have null `oldFile`; deleted files have null `newFile`. Arbitrary paths, unsupported diffs, merge context, and stale versions are rejected. Reads use literal root-relative filesets after `--`, never caller-supplied revisions, and validate state again afterward.
- Legacy `POST /preview {version,target,selections:[{id,lines}]}`: exact changed-row selections. Whole hunks mean all their `+`/`-` indices, never context rows. Returns `{token,patch,specs,command,selectedLines}`.
- `POST /squash {token}`: consumes a one-shot preview token, revalidates everything, and returns `{state,output,warning?}`.
- `POST /undo {version}`: reverts only the exact last attributed app squash via `jj op revert <operation>`.
- `POST /reset {version}`: returns `{state}` for a fresh demo.

Errors are JSON `{error,code,output?}`. Invalid requests/selections use 400, stale repository/preview/conflict/recovery states use 409, unsafe previews use 422, and tool failures use 500. Main server owns same-origin security middleware.

## Safety

All reads and mutations in the running router share one serial queue, since jj reads may snapshot the working copy. The operation, source commit, destinations, source diff, tool hunk bodies, and exact patch locations/rows are rechecked. Execution uses pinned full commit IDs and argument arrays, with `--use-destination-message --keep-emptied`. No shell interpolation, interactive editors, timeouts killing history rewrites, or automatic mutation retries are used.

Renames/copies, modes, binary/combined diffs, missing final newlines, ambiguous/header-like code rows, and whitespace/quoted paths fail closed. Conflicted repositories cannot be reviewed or squashed. Preview tokens expire after ten minutes and never survive a process restart. Tokens are consumed even on failures.

The mutation journal is written before execution. Successful operation attribution requires exactly one operation descended from the validated operation, the expected destination description, and tool command attributes naming the pinned source/destination. Any unexpected intervening history or ambiguous failure disables automatic undo and further mutations. A later fresh repository read never silently retries a failed mutation.

For `PARTIAL_FAILURE`, `HISTORY_CHANGED`, or `RECOVERY_REQUIRED`, inspect `jj op log --no-pager` and the matching `.data/operations-*.json` before proceeding. Never use `jj op restore` as recovery. Demo reset is always non-destructive. For a user repo, an operator must reconcile history manually and then archive its pending journal to acknowledge recovery. Do not blindly repeat the prior squash.

External jj processes cannot be locked by the app's in-process queue. External changes before execution are rejected; unexpected intervening operations during execution are detected afterward and left for explicit recovery rather than unsafe automatic rollback. **This is not an atomic cross-process transaction:** another jj command or filesystem write can race the final validation and tool execution. Detection does not mean the squash was prevented. Avoid concurrent edits/history operations in the same real repository while squashing or undoing, and inspect `jj op log` after any race warning before taking another action. Run only one app process against a given active repository; independent app instances do not share the in-memory queue.

## Tests

`npx tsx --test tests/backend.test.ts` uses isolated real jj repositories and the installed jj-hunk-tool. Covers immediate-parent-only squash, immutable/merge parent rejection without ancestor fallback, target-override rejection, real graph output, pinned full-file context (modified/new/deleted), stale and forbidden context requests, concurrent/replayed immediate requests, internal preview races, full/partial addition/deletion, legacy multiple files and grandparent destinations, exact preview validation, stale/replayed requests, persisted undo, invalid selections, immutable targets, conflicts, reset preservation, Express contracts, and simulated failures/interleavings around real history mutations. Fixture repositories are retained in `/tmp/fold-backend-*` for diagnosis.

The parser was adapted from `/home/exedev/hunk-jj-squash/src/diff.ts`; original sources were not modified. Local jj-surgeon guidance was read from `/home/exedev/upstream/jj-hunk-tool/skills/jj-surgeon/SKILL.md`.
