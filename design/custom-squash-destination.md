# Squash destination: a saved, moving revset

Design only. No production UI, API, or squash behavior changed. This iteration
makes a revset text box the primary destination control, retaining the amber tint
and the thin source-to-destination arrow without stripes or role labels.

Open `design/custom-squash-destination.html`, or display the generated
`.planka-artifacts/interactive-mockups.html` with Shelley's `output_iframe`.

## Interaction

- The compact **Squash into** field starts at `@-` in this fixture, where the
  reviewed source is initially `@`. The resolved change ID appears next to it.
- Edit the expression. A valid one-commit result previews with a dashed arrow;
  squash stays disabled while the edit is unapplied. **Enter** or **Apply** saves
  the expression, not its current result. **Escape** restores the saved expression.
- Applying `@--` first resolves to `rwpxovrz`. Click **Move @ (demo)** above the
  mock workspace: the same `@--` then resolves to `pqxvqmoo`. The arrow and tint
  update; the reviewed source and selected lines remain unchanged.
- `@--` uses two ASCII hyphens and means two parent steps behind the working-copy
  commit. `@` is **not** an alias for the currently selected review. The example
  deliberately keeps the blue reviewed source fixed while moving the `@` marker
  to a newly created child row.
- Enter a specific change ID to keep a fixed target instead. The demo checks this
  contrast: `rwpxovrz` stays the destination when `@` moves.
- Clicking the arrow now focuses/selects the revset field. It no longer enters a
  competing graph-picking mode. Commit IDs retain their review-navigation role.

This prototype saves the expression only in its runtime state; durable settings
across reloads/restarts are not implemented. **Move @** and the walkthrough are
fixture controls, not production repository operations.

## Resolve exactly one eligible commit, or block

The expression must resolve to exactly one commit. Zero matches, multiple matches,
unsupported fixture syntax, the source itself, and immutable/ineligible targets
show an inline reason and disable squash. Invalid drafts hide the arrow, tint,
and resolved ID; **never silently fall back to the previous destination**.

An applied expression can become invalid after a working-copy move. In particular,
when `@` advances to a new child of the still-reviewed source, `@-` now names that
source. The prototype blocks squash instead of substituting an older ancestor.
Reset explicitly restores the selected source's actual parent: initially `@-`,
or `vqkqszmu-` once the working copy has moved in this example.

A valid target outside the log filter gets a compact notice. The field and
resolved ID remain visible; don't draw an arrow to a nonexistent row or silently
change the filter.

## Preserve the log

- Keep the source's blue highlight and destination's quiet amber tint. No left
  stripe or inline `[reviewing]` / `[target]` / `[immutable]` labels.
- The thin amber elbow arrow occupies the existing 20px left margin, not a new
  graph column. It connects real row centers and stays in the fixed margin while
  long text scrolls horizontally.
- Graph prefixes, IDs, bookmarks, and descriptions retain the existing monospace
  font and **normal line height**. No commit cards, extra vertical padding,
  invented connector rows, wrapping, or title truncation.
- Repeat the resolved ID next to the squash selection and in the file-sidebar
  footer. Unapplied edits and invalid resolution cannot authorize squash.

## Production semantics to implement after approval

- Use **jj**, not this fixture resolver, to evaluate arbitrary revsets. Require
  exactly one visible, non-divergent, eligible commit at a captured operation.
  The mockup recognizes only `@` plus parent steps, its listed full short IDs,
  `vqkqszmu-`, `parents(vqkqszmu)`, `all()`, and `none()`. It is not a jj parser;
  unknown expressions are labeled as unsupported by this fixture, not necessarily
  invalid jj syntax. `all()` counts fixture commits, not a live repository.
- Retain the expression as the user's destination rule, separately from the
  resolved change/commit IDs. Re-evaluate on validated refreshes, working-copy
  moves, and after completed rewrites, with another check immediately before
  accepting a new squash. Display the new resolution or block; don't pin a moving
  expression forever to its first match.
- **Pin accepted queued batches** to their validated source and destination IDs.
  A moving revset must not reroute work already accepted. The demo locks its field,
  arrow, Reset, and movement control during a pinned queue; re-evaluation for new
  work happens after draining. External history changes still require backend
  stale-state checks, not reliance on disabled browser controls.
- Decide persistence scope (for example, workspace-level preference) explicitly.
  Custom `@` expressions stay working-copy-relative across review navigation.
  A source-parent default for non-`@` reviews needs an explicit source-relative
  expression, not reinterpretation of `@` or substitution of the next log row.
- Preserve source selection, line selections, and queue recovery rules where safe;
  destination resolution is not permission to switch source or replay a mutation.
- Resolve allowed relationships (ancestors versus other branches), conflicts,
  descriptions, undo, and vanished/divergent destinations before adding mutations.
  This fixture only offers older mutable ancestors plus an off-filter example.
- The backend/native selection engine remain immediate-parent-only. Multiple
  parents or an immutable parent need an explicit no-default reason. This mockup
  does not claim custom-destination squashing already works.

## Checks and presentation

With npm dependencies and Playwright Chromium installed, run from repository root:

```sh
node design/custom-squash-destination.e2e.mjs
```

The check generates local and iframe-ready HTML bundles and three actual browser
screenshots of the mock log in ignored `.planka-artifacts/`:

- `revset-01-saved-expression.png`: applied `@--`, resolving to `rwpxovrz`.
- `revset-02-follows-working-copy.png`: unchanged `@--`, resolving to `pqxvqmoo`
  after `@` moves, while the reviewed source remains fixed.
- `revset-03-multiple-matches.png`: a multi-result draft blocks squash with an
  inline error instead of keeping a stale target.

Attach screenshots directly to the ticket. Present the interactive document with
`output_iframe` in the linked Shelley conversation; Planka cannot display raw
HTML/sandbox links as interactive previews.

Checks cover moving versus fixed expressions, Enter/Apply/Escape, invalid or
ineligible results and fail-closed behavior, dynamic invalidation, explicit reset,
queue pinning, off-filter targets, source/selection preservation, compact graph
metrics, arrow geometry, mobile scrolling, and both HTML bundles. Uncaught page
errors and HTTP/API requests fail the check.

The existing local Source Code Pro font is bundled without CDNs. These are design
fixtures: no actual jj revset evaluation, repository mutation, production build,
or backend tests are performed by this mockup check.
