# Design A: one squash-destination dropdown

Design only. No production UI, API, or squash engine changed. This develops
option A (the first/combined-dropdown option) from `custom-squash-options.html`
into the full review-workspace demo. The five-option gallery remains available
for comparison in `custom-squash-options.md`.

Open `design/custom-squash-destination.html`, or display the generated
`.planka-artifacts/interactive-mockups.html` with Shelley's `output_iframe`.

## Compact control, full workspace

The existing 44px top bar contains **Squash into →** and one bordered dropdown:

- Default: **Commit below · pqxvqmoo ⌄**.
- Confirmed custom: **Custom · rwpxovrz ⌄**.
- Unconfirmed row preview: **Choosing… · rwpxovrz ⌄**, with a dashed amber border.

The complete control is 26px high and about 288px wide, including its label.
There is no separate Change button, native mode select, or persistent destination
row in the log. The full mode and ID remain visible when the log is hidden. The
ID is content inside an obvious dropdown, not an unmarked standalone action.

## Dropdown anatomy

The menu names the reviewed source and provides:

1. **Commit below**: actual parent ID, commit title, and “Parent of <source>”.
   The checked radio indicates the committed mode, not a hover preview.
2. **Custom destination**, once one has been chosen: the remembered fixed ID and
   title. Switching to Commit below does not erase this choice; selecting the
   remembered row restores it without opening the log. Invalidated choices are
   disabled and explain why.
3. **Choose commit in log…**: an explicit action for picking a new custom target.
   Its description explains whether the log opens temporarily or is already open.
   During picking, it returns to the current preview rather than resetting it.

The note “Choosing a destination does not squash any lines” separates destination
selection from the existing Squash selection action. The menu is viewport-clamped,
flips above its trigger when needed, and scrolls if vertical space is limited.
Scrolling its trigger out of view dismisses the menu without changing the target.

## Default is source-relative, never `@-`

Commit below uses explicit parent metadata for the reviewed source, not working
copy position or adjacency in a filtered graph:

- Initially review `vqkqszmu`; its actual parent is `pqxvqmoo`.
- **Move @ (demo)** advances the working copy without changing the destination.
- **Review parent (demo)** reviews `pqxvqmoo`, so Commit below becomes `rwpxovrz`,
  even while `@` stays at `vqkqszmu` or moves to a new child.
- **Parent hidden by log filter** keeps the true parent destination. The menu and
  log notice explain that it is outside the filter; no visible commit substitutes.

Selecting Commit below explicitly returns to this mode from a custom choice or
preview. There is no generated revset or hidden working-copy-relative expression.

## Choose a custom target

1. Open the dropdown and select **Choose commit in log…**. The margin arrow is
   also a keyboard-accessible shortcut. Neither changes the reviewed source.
2. Hover or focus an eligible row. Its amber tint and dashed arrow preview the
   destination. The top bar says **Choosing…**, the diff footer says **Preview
   destination**, and Squash selection is disabled.
3. Click a row/ID, or press Enter, to confirm. The dropdown becomes **Custom**,
   the arrow becomes solid, and squash is available. The selected lines and
   source remain unchanged; nothing is squashed merely by choosing.
4. Escape or Cancel restores the prior committed mode/ID. Opening the dropdown
   while picking allows an explicit switch to the parent or remembered custom
   target instead. Cancelling only the menu leaves the underlying picker active.

There is no text field, revset parser, or Apply step. A clicked target stays fixed
when `@` moves. To change it again, use the same obvious dropdown and named action.

## Hidden-log and focus behavior

- Hiding the log does not change the destination. The diff reclaims the space
  beside the existing narrow rail; the top-bar control stays put.
- Picking temporarily opens a hidden log. Confirm, Cancel, Escape, or selecting a
  menu radio restores the previously hidden layout. If the log was already open,
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

- Source, immutable commits, and other ineligible fixture rows cannot be chosen.
  If a custom target becomes the reviewed source, show the reason and block
  squash—no stale-ID fallback or silent switch to Commit below. The menu still
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
- This is a static linear fixture, not jj evaluation. Merges, missing/immutable
  parents, conflicts, ancestry validation, operation/version checks, persistence,
  and navigation scope need production decisions and backend validation. Browser
  control state is not write authority.
- Source navigation, working-copy moves, filters, and queue states are demo
  fixtures. Headings and log highlights update; diff contents remain illustrative.
  Squash only describes what it would do. The actual engine is parent-only.

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

Browser checks cover the menu and keyboard/dismissal rules, remembered custom
choice, source/working-copy/filter independence, preview and confirmation,
cancel/focus/layout restoration, invalid/off-filter/queued destinations, compact
graph/arrow and toolbar geometry, live notice/error updates during preview,
narrow-screen popup placement and offscreen dismissal, and both offline bundles.
Uncaught page errors or HTTP/API requests fail the check. The local font
and license are bundled without CDNs. No backend mutation/build tests are run by
this design-only check.
