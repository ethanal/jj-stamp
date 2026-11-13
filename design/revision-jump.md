# Go to revision: two UI concepts

Static mockups only; no application behavior changed. Both accept change IDs or commit IDs (full IDs or unique prefixes) and display the resolved revision without checking it out.

- **Inline field:** always-visible toolbar input and Open button. Enter submits. Help appears on focus; failed or ambiguous lookups keep the current review visible.
- **Dialog:** a Go to revision button opens a focused input with a resolved-revision preview. Enter opens the match; Escape cancels. More space for ambiguity and error messages, less permanent toolbar space.

The backdrop assets are from the existing isolated-fixture UI capture in `capture-pr-review.ts`. The new controls and example lookup result are illustrative, not wired to the API.

Regenerate PNGs from the repository root:

```sh
node design/capture-revision-jump.mjs
```
