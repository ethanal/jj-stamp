# Squash destination: margin-arrow refinement

Design only. No production UI, API, or squash behavior changed. This refines the
previous three concepts in response to feedback: keep the destination color,
remove the left stripe and visually heavy role labels, and connect the source to
the destination with an arrow in the log's left margin.

Open `design/custom-squash-destination.html`, or display the generated
`.planka-artifacts/interactive-mockups.html` with Shelley's `output_iframe`.

## Visual treatment

- Retain the source's blue highlight and the destination's quiet amber tint.
  Remove the destination stripe and all `[reviewing]`, `[target]`, and
  `[immutable]` annotations from the graph. Accessible names/descriptions and
  tooltips still identify roles and unavailable destinations.
- A thin amber elbow arrow starts at the source's row center and points at the
  destination's row center. It occupies the **existing 20px left margin**, not a
  new graph column. It is distinct from jj's graph glyphs.
- Preserve the existing **monospace graph with normal line height**. Each graph
  prefix, change ID, bookmark, and description stays on a single line, with no
  row padding, cards, extra connector rows, or title truncation. Long lines scroll
  horizontally while the arrow remains in the fixed margin.
- Default to the source's immediate parent—not the next filtered row. The example
  starts at `vqkqszmu → pqxvqmoo`. Reset restores that parent.
- Keep a compact destination summary above the log and the destination ID beside
  the squash action and in the existing file-sidebar footer.

## How to choose a destination

1. **Click the amber arrow**, or use the explicit **Change…** button. No dragging
   or modifier key is required. The arrow button is also reachable with Tab.
2. Move over an eligible commit row. A **dashed arrow** previews its destination;
   the confirmed destination retains its tint and ID until the choice is made.
3. **Click the row to set it.** The arrow becomes solid and the amber tint moves.
   The source diff and selected lines stay in place; nothing is squashed yet.

Keyboard: Enter on the arrow opens the picker; Up/Down moves among eligible
rows; Enter sets the destination. Escape or Cancel leaves the previous target
unchanged and returns focus to Change…. Source/immutable rows are unavailable.

Commit IDs keep their review-navigation role **outside** pick mode. During pick
mode, the banner makes the temporary destination-selection behavior explicit.
The walkthrough at the top shows the default, picking, and custom-target states
of this single recommendation—not three competing designs.

For older or off-filter targets, **Search…** is available inside pick mode. The
fixture picker accepts a title or change ID and supports Up/Down + Enter. Empty
results, Escape, Close, or clicking outside never change the confirmed target.
An off-filter target gets a compact summary instead of an invented graph arrow.
Change… remains available to choose a visible target again.

## Guardrails and limitations

These are fixtures, not live jj reads. Squash only reports what would happen;
review navigation, Go to, and Settings are intentionally not simulated. The
example-state selector also demonstrates queued work and an off-filter target.

For production implementation after design approval:

- Scope an override to the reviewed source. Switching sources should begin with
  that source's immediate-parent default, not inherit a hidden target.
- Pin each queued batch's source and destination. Lock the arrow, Change…, and
  Reset until the queue drains, as illustrated in the mockup.
- Resolve by full change identity and revalidate/pin commit IDs at mutation time.
  A graph row or search result is not write authority.
- Multiple parents or an immutable parent require an explicit no-default reason,
  never substitution of the next visible row. This fixture has one mutable parent.
- Decide allowed relationships (ancestors versus other branches), conflict
  handling, descriptions, undo, and stale/missing target recovery before adding
  custom squash. The illustration only offers older mutable ancestors.
- The backend and native selection engine remain immediate-parent-only; this
  design is not a claim that custom-destination mutations already work.

## Checks and presentation

With npm dependencies and Playwright Chromium installed, run from repository root:

```sh
node design/custom-squash-destination.e2e.mjs
```

The check generates the local HTML/font bundle, the self-contained
`interactive-mockups.html`, and three browser screenshots cropped to the actual
log pane in the ignored `.planka-artifacts/` directory:

- `arrow-01-parent-default.png`: solid arrow to the default immediate parent.
- `arrow-02-choose-destination.png`: dashed candidate preview, before confirming.
- `arrow-03-custom-destination.png`: solid arrow and retained tint on a new target.

Attach screenshots directly to the ticket; display the interactive document with
`output_iframe` in the linked Shelley conversation. Planka cannot display raw
HTML/sandbox links as interactive previews.

Checks exercise click-arrow/full-row selection, keyboard navigation, cancellation,
reset, source/selection preservation, absent labels/stripe, retained color, search,
queue locking, off-filter targets, both HTML bundles, and narrow layouts. They
verify arrow endpoints against real row centers, unchanged compact graph metrics,
and a fixed arrow margin during horizontal scrolling. Uncaught page errors and
HTTP/API requests fail the check.

The existing local Source Code Pro font is bundled without CDN dependencies.
No production build, backend tests, or real-jj mutations are needed to exercise
these design files.
