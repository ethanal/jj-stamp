# Design A: one squash-destination dropdown

Interactive design reference for the implemented production destination picker.
This standalone fixture develops option A (the first/combined-dropdown option)
from `custom-squash-options.html` into the full review-workspace demo; it never
calls the API or mutates a repository. The five-option gallery remains available
for comparison in `custom-squash-options.md`.

Open `design/custom-squash-destination.html`, or display the generated
`.planka-artifacts/interactive-mockups.html` with Shelley's `output_iframe`.

## Compact control, full workspace

The existing 44px top bar contains **Squash into →** and one bordered dropdown:

- Default: **Parent · pqxvqmoo ⌄**.
- Confirmed custom: **Custom · rwpxovrz ⌄**.
- Unconfirmed row preview: **Choosing… · rwpxovrz ⌄**, with a dashed amber border.

The complete control is 26px high and about 288px wide, including its label.
There is no separate Change button, native mode select, or persistent destination
row in the log. The full mode and ID remain visible when the log is hidden. The
ID is content inside an obvious dropdown, not an unmarked standalone action.

## Dropdown anatomy

The lean menu has exactly two items, with no heading, helper descriptions, or
footer notes:

1. **Parent**: the actual parent ID. The checked radio indicates the committed
   mode, not a hover preview. Choosing Parent clears the custom destination;
   there is no remembered Custom radio or restore shortcut.
2. **Choose revision in log…**: opens the picker for a new custom target. During
   picking, it returns to the current preview rather than resetting it.

Choosing a destination does not squash any lines. The menu is viewport-clamped,
flips above its trigger when needed, and scrolls if vertical space is limited.
Scrolling its trigger out of view dismisses the menu without changing the target.

## Default is source-relative, never `@-`

Parent uses explicit parent metadata for the reviewed source, not working
copy position or adjacency in a filtered graph:

- Initially review `vqkqszmu`; its actual parent is `pqxvqmoo`.
- **Move @ (demo)** advances the working copy without changing the destination.
- **Review parent (demo)** reviews `pqxvqmoo`, so Parent becomes `rwpxovrz`,
  even while `@` stays at `vqkqszmu` or moves to a new child.
- **Parent hidden by log filter** keeps the true parent destination. The menu keeps
  the true ID and the log notice explains the filter; no visible revision substitutes.

Selecting Parent explicitly returns to this mode from a custom choice or
preview, discarding the custom ID. Choosing a custom target again requires a new
row selection. There is no generated revset or hidden working-copy-relative
expression.

## Choose a custom target

1. Open the dropdown and select **Choose revision in log…**. The margin arrow is
   also a keyboard-accessible shortcut. Neither changes the reviewed source.
2. The picker banner says **Choose a revision**, with a **Cancel** button whose
   hit area is at least 44 × 44px. Hover or focus an eligible row. Its amber tint
   and dashed arrow preview the destination. The top bar says **Choosing…**, the diff footer says **Preview
   destination**, and Squash selection is disabled.
3. Click a row/ID, or press Enter, to confirm. The dropdown becomes **Custom**,
   the arrow becomes solid, and squash is available. The selected lines and
   source remain unchanged; nothing is squashed merely by choosing.
4. Escape or Cancel restores the prior committed mode/ID. Opening the dropdown
   while picking allows an explicit switch to Parent, clearing the custom choice.
   Cancelling only the menu leaves the underlying picker active. Replacing a
   current custom choice and then cancelling preserves that current choice.

There is no text field, revset parser, or Apply step. A clicked target stays fixed
when `@` moves. To change it again, use the same obvious dropdown and named action.

## Hidden-log and focus behavior

- Hiding the log does not change the destination. The diff reclaims the space
  beside the existing narrow rail; the top-bar control stays put.
- Picking temporarily opens a hidden log. Confirm, Cancel, Escape, or selecting
  Parent restores the previously hidden layout. If the log was already open,
  leave it open. Hiding the log during picking cancels the preview.
- Confirming/cancelling returns focus to the dropdown trigger. Closing only the
  menu restores trigger focus without cancelling the row preview.
- Enter/Space opens the menu. Up/Down on the trigger opens at the last/first item.
  Menu arrows, Home, and End move among enabled items. Enter/Space activates an
  item. In the graph, Up/Down skip unavailable rows; Enter confirms.
- Escape first closes the menu, then cancels an active picker on a second press.
  Tab or outside pointer/focus dismisses the menu without committing a choice.
- Narrow headers wrap compactly instead of hiding the destination or overflowing.

## Guardrails and limitations

- Source, immutable revisions, and other ineligible fixture rows cannot be chosen.
  If a custom target becomes the reviewed source, show the reason and block
  squash—no stale-ID fallback or silent switch to Parent. The menu still
  allows explicit recovery using the parent or a new eligible target.
- Previously chosen off-filter targets keep their ID, with an outside-filter
  notice, but no misleading graph arrow. Choosing a new target requires a visible
  row. The fixture includes an example of an already-chosen hidden target.
- Queue examples pin source/destination IDs and disable the dropdown, picker,
  squash, and source/working-copy demo navigation. Log visibility can still
  change. Queue/error notices remain outside the log, visible when it is hidden.
- Preserve 13px Source Code Pro with normal log line height, literal graph
  prefixes, no row gaps/padding/wrapping, and horizontal scrolling. The amber
  arrow stays in the existing 20px gutter, has no source dot, and lands at the
  destination. No extra role labels or destination stripe.
- This is a static linear fixture, not jj evaluation. Production separately
  validates eligible mutable ancestors, full IDs, mutability, divergence, source
  parentage, exact selected bytes, and operation/version state on the server.
  Merges and unavailable parents remain unsupported. Browser control state is
  never write authority; destination choices are local to the current review.
- Source navigation, working-copy moves, filters, and queue states are demo
  fixtures. Headings and log highlights update; diff contents remain illustrative.
  Squash only describes what it would do. The production engine supports Parent
  and eligible custom ancestors, with pinned queue destinations and undo.

Production coverage lives in `tests/custom-squash.e2e.ts`,
`tests/custom-squash.test.ts`, `tests/squash-destination.test.ts`, and
`tests/queue.test.ts`; the browser test exercises actual jj rewrites and undo,
not this fixture.

## Checks and presentation

With npm dependencies and Playwright Chromium installed, from repository root:

```sh
node design/custom-squash-destination.e2e.mjs
```

The check generates local `index.html`, a self-contained `interactive-mockups.html`
with the bundled font, and browser screenshots in ignored `.planka-artifacts/`:

- `design-a-01-default.png`: full workspace; reviewed source differs from `@`.
- `design-a-02-menu.png`: open destination menu with the log hidden.
- `design-a-03-picking.png`: temporary log and unconfirmed row preview.
- `design-a-04-custom.png`: confirmed custom target with hidden layout restored.
- `design-a-control.png`: close-up of the single combined control.

Attach actual PNGs to the ticket. Display the interactive document with
`output_iframe` in the linked Shelley conversation. Run this check after the
five-option gallery check to make the shared iframe show the developed A demo.

Browser checks cover the menu and keyboard/dismissal rules, custom reset and
replacement cancellation, source/working-copy/filter independence, preview and
confirmation,
cancel/focus/layout restoration, invalid/off-filter/queued destinations, compact
graph/arrow and toolbar geometry, live notice/error updates during preview,
narrow-screen popup placement and offscreen dismissal, and both offline bundles.
Uncaught page errors or HTTP/API requests fail the check. The local font
and license are bundled without CDNs. No backend mutation/build tests are run by
this design-only check.
