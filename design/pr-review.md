# PR review workspaces

Status: design draft; no implementation yet. Confirmed requirements are separated
from proposals and open questions below.

## Confirmed behavior

- Start a review from a PR URL, a number in the current repository, or a picker
  listing PRs requesting the current user's review in that repository.
- Use `gh` for GitHub access.
- Create an automatically located jj workspace without changing the invoking
  workspace's checkout or files.
- Start with the PR's merge-base, an empty reviewed commit, and one synthetic
  commit containing the PR's effective change.
- The reviewed commit accumulates reviewed changes. Updates append an interdiff
  above the last unreviewed commit; they do not reset review progress.
- If the merge-base changes, first attempt to rebase the review stack onto the new
  merge-base, then append the interdiff.
- Detect updates automatically, but import them only through an explicit Refresh.
- New inline comments start staged in local JSON documents under
  `~/.local/share/jj-stamp`. Do not create GitHub drafts while composing.
- Submit staged comments as Comment, Approve, or Request changes, with an optional
  overall message.
- Report comments whose locations cannot be mapped unambiguously, including their
  full text and a GitHub link for manual handling.
- Dismiss archives the local review and discards unpublished comments. It does not
  modify GitHub.
- Do not import existing discussion in this version.

## History model

```text
Initial:       B  → R  → U1
After review:  B  → R' → U1'
After refresh: B  → R' → U1' → U2
Base change:   B2 → R* → U1* → U2* → U3
```

`B` is the captured merge-base, `R` is the reviewed accumulator, and `U` commits
hold remaining changes and subsequent updates. Squashing moves content between
commits; imported snapshot identities must therefore live in metadata, not be
inferred from current synthetic commit hashes.

The central invariant is that the complete review stack's tip tree equals the
last imported PR head tree. Moving content into reviewed commits must preserve
that aggregate tree. Local synthetic commit IDs must never be used as GitHub
review `commit_id` values.

An unchanged-base refresh does not rewrite existing stack commits. A base-change
refresh necessarily rewrites them, preserving their jj change identities and the
reviewed/unreviewed partition wherever the rebase is clean.

For an unchanged base, construct the new child with the new PR head's exact tree.
Its parent is the live review tip, not a saved synthetic commit from before the
user squashed lines. Its diff is therefore exactly the remaining tip-to-head
interdiff.

For a changed base, rebase first. Compare the resulting clean tip tree against the
new PR head tree and construct the new child from that difference. Comparing old
and new PR heads before rebasing would incorrectly include upstream-only changes.
Conflicts anywhere in the rebased stack must be handled explicitly, not hidden by
restoring a clean head tree over a conflicted parent.

Preserve full trees, including binary files, executable bits, symlinks, and
deletions. Do not build snapshots by concatenating patches or by using the
text-only line-selection engine.

## Start and refresh orchestration (proposed)

1. Resolve and validate the repository, GitHub hostname, PR number, and account.
   A number always means the current repository. Cross-repository URLs remain an
   open scope decision.
2. Read pinned head and target-branch OIDs through `gh`, fetch the necessary Git
   objects without checking out a branch in the invoking workspace, and compute
   the merge-base locally. Fork PRs must not require a locally named head branch.
   `gh` owns API/auth access; Git/jj object transport is a separate implementation
   detail to validate without modifying the user's global credential config.
3. Re-read remote metadata after fetching and verify that the objects match the
   captured OIDs. If the PR moved, do not publish a mixed snapshot.
4. Create/resume one active review per local repository and PR, with an explicitly
   named, described accumulator so an empty commit remains intentional.
5. Execute workspace mutations only in the managed workspace. Record the source
   workspace identity and verify that it was not moved or rewritten.
6. Publish a successful import only after checking the stack tree, conflict state,
   workspace identity, and durable metadata.

Detection checks both the head and target branch, since a target-branch move can
change the merge-base without changing the PR head. Polling and window focus may
update a banner, but must not fetch/rewrite history automatically. Refresh
revalidates rather than trusting the banner's cached OIDs.

Repeated refresh of the same imported head/base is a no-op. If a new head has the
same effective tree, record its identity for comment submission without creating
a meaningless content update commit.

Multiple merge-bases, missing/divergent managed changes, unexpected local edits,
or an externally rearranged stack require a diagnostic rather than guessing.
Ordinary squash rewrites are expected and tracked by jj change ID.

The repository is shared by jj workspaces: isolation means not changing the
original workspace's files, selected change, or unrelated history, not hiding new
review commits from its log.

## Local persistence (proposed)

```text
~/.local/share/jj-stamp/
  reviews/<review-id>/
    review.json
    comments.json
    operations/<operation-id>.json
  workspaces/<review-id>/
```

Use generated IDs for paths, not untrusted repository names or PR titles. Use
private directories/files, atomic replacement, schema versions, and per-review
cross-process mutation locking.

`review.json` records:

- Review ID, lifecycle state, repository identity/location, host/repository/PR,
  GitHub account, managed workspace name/path, and selected jj change.
- Accumulator and tip change IDs, current imported merge-base/head OIDs, and
  import history with captured target OID and operation IDs.
- Last observed remote state, refresh/recovery state, and submission receipts.

`comments.json` records stable comment IDs, Markdown bodies, local staged state,
creation/edit timestamps, and immutable original anchors: imported head/base,
displayed revision pair, path, side, line/range, selected text, and context.
Derived current mappings are separate from original anchors.

`operations` journals distinguish prepared, running, completed, failed, and
outcome-unknown operations. jj changes and JSON writes are not one atomic
transaction. Restart must reconcile an interrupted operation before offering
another mutation; it must not blindly re-run a refresh or GitHub submission.

Dismiss removes unpublished bodies from comment documents and operation payloads,
not merely from the visible list. Retain only non-content recovery metadata needed
to diagnose an outcome-unknown submission. Warn before dismissing such a submission:
it may already exist on GitHub, and dismissal will not retract it.

Proposed default: retain the archived workspace/history; workspace deletion is a
separate, explicit cleanup action. Reopening an archive does not resurrect
discarded comments.

## Inline comment mapping and submission

The UI displays synthetic commit diffs, but GitHub needs anchors in the real PR
diff. A local line number alone is insufficient, especially for deletions in an
interdiff that did not exist at the PR's merge-base.

Map using pinned file versions and line correspondence, including path changes.
Only accept an unambiguous mapping to a commentable location in the real PR diff.
Do not assume that a line on the left of a synthetic diff belongs on the left of
the GitHub diff. Do not use fuzzy matching to silently select a repeated snippet.

At submission:

1. Freeze the selected staged comment IDs/bodies, event, overall message, and
   imported PR head. Revalidate the remote head/base and local review version.
2. Partition comments into mapped and failed. For each failure, print/show its
   body, original path/range, reason, and an appropriate GitHub PR/files link.
   Provide a precise line link only if it is known to be valid.
3. Confirm the policy for submitting the mapped subset (open question below).
4. Send a review through `gh api` with the real imported head OID, event, body,
   and supported inline-comment coordinates. Validate batch/multiline payloads
   against the documented API and integration fixtures before implementation.
   Verify event-specific message requirements and validate empty-message
   combinations before implementation. Prompt when necessary rather than
   inventing an overall message on the user's behalf.
5. Mark only confirmed submitted comments as submitted and retain the review
   receipt/URL. Mapping failures and definite API failures retain staged bodies.
   An uncertain network outcome remains pending reconciliation, not retryable by
   default; avoid duplicate reviews.

The API request pins the reviewed head, but cannot prevent a remote push during
submission. Report that condition rather than claim the latest head was reviewed.
Proposed default: if already stale during preflight, require Refresh before submit.
Submitting a review does not automatically mark local lines reviewed or archive
the local review.

## Integration boundaries (proposed)

- Add a durable review registry/store and a `gh` adapter, separate from the
  existing in-memory `ReviewService`.
- Use a workspace-scoped `ReviewService` for each selected managed review.
  Switching reviews must also switch file-read/watch scopes and invalidate
  previews, never reuse a different workspace's mutation token.
- Keep existing Host/Origin protections, mutation version checks, serialization,
  no-shell subprocess invocation, and shutdown draining.
- Add a review picker, update banner/Refresh, staged-comment editor/list,
  submission dialog, failed-comment report, and local Dismiss confirmation.
- Do not change ordinary non-PR review behavior.
- Account for `gh` availability/authentication and Git object transport in the Nix
  package and CLI diagnostics.

## Decisions still needed

1. **Squash destination after updates:** currently `s` squashes into the immediate
   parent. In `B → R → U1 → U2`, should reviewing `U2` move lines into `U1` as
   today, or directly into `R`? The latter requires a new non-adjacent operation,
   dependency/conflict handling, and a preserved aggregate-tree invariant; it is
   not just changing a destination ID.
2. **Rebase conflicts:** proposed default is to pause refresh with explicit
   recovery state, allow manual resolution in the managed workspace, then
   continue and append the interdiff. Do not silently reset review progress.
   An alternative is retaining the old active stack and rejecting the refresh.
3. **Failed comment mapping:** submit the valid subset and report the rest, or
   require confirmation first? Proposed default: confirm the subset explicitly,
   especially before approving; retain failures until fixed/discarded/dismissed.
4. **Other-repository URLs:** initially reject with a clear repository mismatch,
   or support selecting an existing local checkout? Automatic cloning has not
   been requested or approved.

## Acceptance tests

- Initial snapshot exactly matches the PR head; original checkout, dirty files,
  and selected change are untouched.
- Partially reviewed stack plus multiple updates preserves the accumulator and
  existing unreviewed commits on unchanged-base refresh.
- Base advancement, rebase/force-push, retargeting, and upstream-only changes
  produce the correct rebased stack and final head tree.
- Conflicts in any stack commit pause safely; repeated refresh and restart do not
  duplicate updates; metadata-only updates are recorded without content commits.
- Fork PR fetches, stale metadata/fetch races, non-text files, and unusual paths.
- Comments on additions/deletions/ranges, renames, repeated text, and lines present
  only in an older update either map correctly or produce a useful failure report.
- Submit all three events, including no inline comments; preserve failed drafts,
  handle API rejection/authentication failures, and reconcile unknown outcomes.
- Dismiss is entirely local and removes unpublished content from retained JSON.
- Concurrent tabs/processes, interrupted writes, stale UI versions, external jj
  operations, and archive/reopen flows cannot corrupt a review or duplicate a
  remote submission.

## UI alternatives

`design/pr-review-options.html` compares additions over screenshots of the actual
running jj-stamp, not an alternative app layout. "Current app" removes all proposed
controls; teal outlines identify additions. The captured baseline is not
interactive. Proposed controls use fictional PR metadata and in-memory drafts,
with no persistence or GitHub access.

- **A — Toolbar menu:** add a PR button before the existing Refresh/Settings.
  Open PR, update status, Refresh PR, staged comments, submission, and dismissal
  live in a popover or dialog.
- **B — Slim review strip:** add a 42px row below the unchanged toolbar. Surface
  PR identity, update status, Refresh PR, staged count, and submission there.
  This is the preferred direction for keeping remote and local state distinct.
- **C — Bottom comment tray:** use A's toolbar menu and add a 206px tray within
  the center diff column. Keep both sidebars full-height and preserve the footer.
  The production tray should be collapsible and resizable.

All three retain the actual file tree, diff/view controls, jj graph/revision
picker, and Squash/Undo/Clear actions. Add an anchored line-comment composer and
a separate Comment selection action; commenting never squashes. Review commits
will appear as ordinary entries in the existing jj graph, not a replacement
timeline. The screenshots deliberately retain the original test history rather
than pretending that the proposed PR stack has been implemented.

**PR selection is a full-screen modal in every layout**, not a small popover.
The study opens on this screen. It provides a full-width number/URL entry,
searchable PR rows, Review requested / Active locally filters, and a spacious
details pane with description, branch, changed files, and saved local progress.
The footer offers Start/Resume; Back to workspace or Escape returns to the
unchanged review UI. List and details scroll independently on desktop; narrow
screens stack them in a scrollable body while keeping the header and action
footer visible. The toolbar popover remains only a compact action menu—its
Open PR entry always opens the full-screen selector.

Existing Refresh remains a local repository refresh. New Refresh PR explicitly
imports remote changes into the managed review stack. Opening a review switches
the existing app's data scope to that workspace without replacing its layout.
Returning to the original workspace does not dismiss the saved review.

All three demonstrate explicit refresh, staged comments, submission, mapping
failures, and local dismissal. The partial-submission confirmation and archive
retention shown are proposals, not resolved requirements. The mockup does not
implement jj operations, anchor mapping, or API validation.

Regenerate embedded captures with `npx tsx design/capture-pr-review.ts` from the
repository root. This uses `tests/browser-fixture.ts`, the current application,
and an isolated disposable jj repository. Intermediate screenshots and geometry
go under ignored `.data/pr-review-capture`; only the self-contained HTML is
published. It does not modify the source checkout's jj history or workspace.

## Implementation references to verify

- GitHub CLI PR discovery and JSON fields:
  `https://cli.github.com/manual/gh_pr_list`
  and `https://cli.github.com/manual/gh_pr_view`.
- Authenticated API requests and JSON payload input:
  `https://cli.github.com/manual/gh_api`.
- GitHub review submission and inline anchors:
  `https://docs.github.com/en/rest/pulls/reviews`
  and `https://docs.github.com/en/rest/pulls/comments`.
- jj workspace/rebase operations and conflict semantics:
  `https://www.jj-vcs.dev/latest/cli-reference/`
  and `https://www.jj-vcs.dev/latest/conflicts/`.
