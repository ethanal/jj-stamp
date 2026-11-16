# Squash destination: Commit below or Custom

Design only. No production UI, API, or squash behavior changed. The main control
is a **select** with two choices: **Commit below** (default) and **Custom…**.
The amber destination tint and thin source-to-destination margin arrow remain;
there are no role labels, colored left stripe, or extra graph-row spacing.

Open `design/custom-squash-destination.html`, or display the generated
`.planka-artifacts/interactive-mockups.html` with Shelley's `output_iframe`.

## Commit below is source-relative, not `@-`

**Commit below** means the reviewed source's actual immediate parent, resolved
from explicit parent metadata. It is not a generated revset, not working-copy
relative, and not the next visible row in the filtered graph.

The prototype demonstrates the distinction:

- Initially review `vqkqszmu`; its parent is `pqxvqmoo`.
- **Move @ (demo)** advances the working copy without changing that default.
- **Review parent (demo)** selects `pqxvqmoo`, so Commit below becomes `rwpxovrz`,
  even while the working copy remains at `vqkqszmu` or its new child.
- **Parent hidden by log filter** removes `pqxvqmoo` from the displayed graph but
  keeps it as the destination. Show an outside-filter notice, not an arrow to the
  next visible commit.

Switching the select back to Commit below explicitly restores this behavior from
any custom selection or invalid custom draft. There is no default `@-` field,
source-ID expression, or hidden working-copy dependency.

## Custom: click a commit

1. Select **Custom…**, or click the margin arrow. This explicitly enters a
   destination picker without changing the current review.
2. Hover an eligible row to preview a dashed arrow. **Click the row** to confirm
   a fixed custom destination. Source and immutable/ineligible rows are disabled.
3. The arrow becomes solid, the amber tint moves, and squash is available. The
   selector remains Custom; **Change…** reopens the picker.

Keyboard: the arrow and selector are focusable; Up/Down inside the focused log
move among eligible rows and Enter chooses. Escape or Cancel restores the
previous committed mode and destination—including returning to Commit below if
that was active before opening the picker.

Commit IDs keep their review-navigation role outside pick mode. Choosing a
custom destination preserves the source and selected lines and does not squash.
After clicking a fixed commit, collapse the extra editor row: the resolved ID is
already visible beside the select. Change… can reveal it again.

## Optional revset, only under Custom

The custom picker also accepts a revset or change ID instead of a row click.
A typed rule previews with a dashed arrow; Enter/Apply saves it. Unapplied edits
cannot squash, and Escape restores the previous choice.

An explicitly chosen `@--` retains working-copy-relative meaning and re-resolves
when `@` moves. A clicked or typed fixed change ID stays fixed. This is **opt-in
custom behavior**, never the default. Applied moving expressions stay visible
in the custom editor so the rule is not confused with a fixed destination.

Zero/multiple matches, unsupported fixture syntax, the source itself, immutable
commits, or other ineligible targets show a reason and block squash, with no
stale-target fallback. If a custom target becomes the selected source, block it;
do not silently switch to Commit below. The user can explicitly select that
mode to recover.

## Guardrails and limitations

- This is a finite fixture resolver, **not jj evaluation**. It recognizes `@`
  with parent steps, listed IDs, `vqkqszmu-`, `parents(vqkqszmu)`, `all()`, and
  `none()`. Unknown expressions are labeled unsupported by this fixture, not
  necessarily invalid jj syntax. `all()` counts fixture commits.
- The default uses a separate parent-metadata path and never calls that resolver.
  The fixture is linear; merges, missing parents, immutable parents, and conflicts
  require explicit production diagnostics rather than guessed destinations.
- Accepted queued batches pin source/destination IDs. The selector, arrow,
  custom editor, and demo navigation lock while work drains. Neither a moving
  custom revset nor a later source selection may reroute accepted work.
- Production must validate source/version and target eligibility at a captured
  operation, re-resolve moving rules for new work, and repeat checks immediately
  before accepting mutations. Disabled browser controls are not write authority.
- Preserve normal monospace log line height and the existing 20px arrow margin.
  No row cards, vertical padding, wrapping, extra connectors, or title truncation.
  Horizontal scrolling does not move the arrow gutter.
- The prototype stores custom choice/rules only in runtime state. Persistence
  scope across reloads/restarts and custom-mode behavior across navigation need
  explicit production decisions; default mode always follows the reviewed source.
- Source navigation controls, working-copy moves, queue states, and graph filters
  are demo fixtures. Source headings and log highlights update, but the diff
  content remains illustrative. Squash only prints what it would do.
- The actual backend/native selection engine remain immediate-parent-only. This
  design does not implement custom-target mutations, conflict handling, undo, or
  cross-branch destination safety.

## Checks and presentation

With npm dependencies and Playwright Chromium installed, from repository root:

```sh
node design/custom-squash-destination.e2e.mjs
```

The check generates local and iframe-ready HTML bundles and actual browser
screenshots of the log in ignored `.planka-artifacts/`:

- `selector-01-commit-below.png`: the source is not `@`; the default still selects
  its correct immediate parent.
- `selector-02-click-custom.png`: Custom selected and an eligible row previewed.
- `selector-03-custom-selected.png`: confirmed clicked destination, with the
  optional editor collapsed.

Attach screenshots directly to the ticket. Display the interactive document with
`output_iframe` in the linked Shelley conversation; raw HTML/sandbox links are
not interactive previews in Planka.

Checks cover source-relative defaults independent of `@` and filtering, source
switches, the native selector, click/keyboard custom choice, cancel/mode restore,
optional moving revsets, fail-closed validation, queue pinning, off-filter targets,
source/selection preservation, compact graph metrics, arrow geometry, mobile
scrolling, and both standalone bundles. Uncaught page errors or HTTP/API requests
fail the check.

Source Code Pro is bundled locally without CDNs. No live jj evaluation,
repository mutations, production build, or backend tests run in this mockup check.
