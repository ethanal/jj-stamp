# Five compact squash-destination alternatives

Design only; the existing production UI and parent-only squash engine are
unchanged. These alternatives respond to the crowded combination of a select,
resolved ID, and Change button in the previous mockup.

Open `design/custom-squash-options.html`. Each option has independent default and
custom previews, starting with the log hidden. All controls are interactive.

## The five options

1. **One destination dropdown.** Combine mode and ID in a single, clearly bordered
   dropdown after “Squash into →”. Its menu offers Commit below and Choose commit
   in log. No separate Change button. The most direct simplification of the
   previous control.
2. **Two explicit choices.** Adjacent Commit below and Pick commit… buttons,
   followed by a read-only ID. No menu to navigate; Pick commit… also changes an
   existing custom choice. More visible controls, but clearer available actions.
3. **Plain summary + Change.** Read-only mode and ID, with one Change… button.
   Remove the always-visible select; Change opens the mode/choice menu. Visually
   quieter while retaining an explicit editing action.
4. **Choose directly in a popover.** Read-only ID and mode badge, plus Choose….
   It opens a small anchored commit graph rather than expanding the main log.
   The popover includes Use commit below, Cancel, and eligible commit rows.
5. **Stacked micro-control.** Put the label above the mode/ID summary, with Change…
   beside both lines. Uses less horizontal space within the same existing 44px
   toolbar. Only the control stacks; graph rows remain single-line.

## Shared behavior and scope

- Keep “Squash into →” visible. No custom text entry or revset parser.
- IDs are read-only, except as content inside option 1's clearly labeled dropdown
  with a chevron. No unmarked clickable commit ID to reopen editing.
- Default is the reviewed source's actual parent, using explicit fixture metadata.
  Working copy `xmturvkn` differs from reviewed source `vqkqszmu`; the correct
  default is `pqxvqmoo`, not `@-`.
- Options 1, 2, 3, and 5 show a temporary inline log when picking. Option 4 uses a
  non-modal local popover. Confirm or cancel returns to the hidden-log state.
- Hover previews only. Click a row or use arrows and Enter to confirm. Escape or
  Cancel preserves the prior committed choice and returns focus to the opener.
- Source, descendant, and immutable rows cannot be selected. Graphs keep 13px
  Source Code Pro, normal line height, literal prefixes, and horizontal scrolling.
  Amber arrows use the existing 20px margin and have no source dot.
- Each preview is independent runtime state. No repository writes or actual jj
  evaluation. Queue locking, conflicts, navigation/persistence, and backend
  validation remain production work; this gallery explores control design only.

## Browser checks and presentation

From repository root, with npm dependencies and Playwright Chromium installed:

```sh
node design/custom-squash-options.e2e.mjs
```

This generates ignored `.planka-artifacts/` files:

- `squash-options-01-dropdown.png`
- `squash-options-02-segments.png`
- `squash-options-03-summary.png`
- `squash-options-04-direct.png`
- `squash-options-05-stacked.png`
- `squash-options-04-picker.png` (additional open-popover state)
- `squash-options.html` (local presentation, sibling font)
- `interactive-mockups.html` (self-contained font for Shelley's `output_iframe`)

The five comparison images each show both default and custom states. Attach
actual screenshots to the ticket; display the interactive gallery in the linked
Shelley conversation. Running this check last makes the shared iframe
presentation show these five alternatives rather than the previous single
mockup.

Checks cover all five designs, explicit actions, read-only IDs, independent
previews, parent/default reset, row and keyboard selection, unavailable targets,
cancel/focus restoration, menu dismissal, the direct popover, compact graph and
arrow geometry, 390px layouts, and both standalone bundles. Any uncaught browser
error or HTTP/API request fails the check. Source Code Pro and its license are
bundled locally; no CDNs.
