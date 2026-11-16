# Squash destination: Commit below or Custom

Design only. No production UI, API, or squash behavior changed. The main control
is a **select** with two choices: **Commit below** (default) and **Custom…**.
The amber destination tint and thin source-to-destination margin arrow remain.
The arrow has a plain source end and an arrowhead at the destination—no source
dot. There are no role labels, colored left stripe, or extra graph-row spacing.

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
any custom selection or invalidated target. There is no default `@-` field,
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
After clicking a commit, the picking instructions and Cancel disappear. The
chosen ID stays visible beside the select, with Change… to choose another row.

## Click-only custom destinations

There is no custom text field, revset parser, or Apply step. A clicked destination
stays fixed when the working copy moves; it is not a moving expression.

While picking, squash is disabled until a row is confirmed. Escape or Cancel
restores the previous committed choice.

The source itself, immutable commits, and other ineligible targets cannot be
chosen. If a custom target becomes the selected source, show a reason and block
squash with no stale-target fallback. Do not silently switch to Commit below;
the user can explicitly select that mode to recover.

A previously clicked target may later leave the log filter. Keep its ID and show
the outside-filter notice rather than drawing a misleading arrow. To select a
different target, it must be visible in the log; there is no text-entry shortcut.

## Guardrails and limitations

- This is a static linear fixture, **not jj evaluation**. Default destinations
  use explicit parent metadata; custom destinations use clicked fixture IDs.
  Merges, missing parents, immutable parents, and conflicts require explicit
  production diagnostics rather than guessed destinations.
- Accepted queued batches pin source/destination IDs. The selector, arrow,
  custom picker, and demo navigation lock while work drains. Neither a later
  destination nor source selection may reroute accepted work.
- Production must validate source/version and target eligibility at a captured
  operation and repeat checks immediately before accepting mutations. Disabled
  browser controls are not write authority.
- Preserve normal monospace log line height and the existing 20px arrow margin.
  No row cards, vertical padding, wrapping, extra connectors, or title truncation.
  Horizontal scrolling does not move the arrow gutter.
- The prototype stores custom choice only in runtime state. Persistence
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

- `click-only-01-commit-below.png`: the source is not `@`; the default still selects
  its correct immediate parent.
- `click-only-02-choosing.png`: Custom selected and an eligible row previewed,
  with only picking instructions and Cancel.
- `click-only-03-selected.png`: confirmed clicked destination, without a text
  field or arrow source dot.

Attach screenshots directly to the ticket. Display the interactive document with
`output_iframe` in the linked Shelley conversation; raw HTML/sandbox links are
not interactive previews in Planka.

Checks cover source-relative defaults independent of `@` and filtering, source
switches, the native selector, click/keyboard custom choice, cancel/mode restore,
absence of text entry and the arrow source dot, fail-closed eligibility checks,
queue pinning, off-filter targets, source/selection preservation, compact graph
metrics, arrow geometry, mobile scrolling, and both standalone bundles. Uncaught
page errors or HTTP/API requests fail the check.

Source Code Pro is bundled locally without CDNs. No live jj evaluation,
repository mutations, production build, or backend tests run in this mockup check.
