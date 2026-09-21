# Fold

Minimal, keyboard-first review of `@` in a real Jujutsu workspace. Diff rendering uses Pierre Diffs; selected lines move through `jj-hunk-tool`.

## Use

- **Drag directly on code** (or line numbers) to select a range. Shift-click extends it.
- **`s`** immediately squashes the selected changed lines **from `@` into `@-`**. No confirmation dialog or target picker.
- **`u`** undoes the last app squash, provided the repository is unchanged.
- **Escape** clears the selection. **`r`** refreshes.
- **Files / Log** in the sidebar switch between the diff and actual `jj log` graph output. Shortcuts: **`f` / `l`**.
- **↑ 10 / ↓ 10** reveal ten more context lines above or below the hunk (or the remaining lines at a file boundary).

Only changed rows are squashed, even when a range includes context or spans multiple hunks. Selections can include just one addition or deletion inside a long hunk. A new drag replaces the range; switching files/views clears it. Working-file contents are preserved.

An immutable immediate parent or merge is rejected, never silently redirected to an older ancestor.

The running VM demo is served on port **8000** by systemd unit **fold**. **reset demo** creates a new demo repository without deleting the previous one. Tests use independent repositories and never mutate the running demo.

## Run

Requires Node.js 22.12+ (tested on 24), `jj`, and `jj-hunk-tool` on `PATH`.

```sh
npm ci
npm run dev                          # http://localhost:8000
npm run demo                         # optional: initialize / print existing demo
```

The first request creates the persistent `orbit` demo. `.data/active-repo.json` records its path; repositories and mutation journals are gitignored.

To use a different **trusted** repository:

```sh
JJ_REPO=/absolute/path/to/workspace PORT=8001 npm start
```

Only server configuration chooses the repository. Reset is disabled for user repositories. Run one Fold process per repository, and use separate data directories/services for independent configured repositories.

### Production

```sh
npm run build
NODE_ENV=production npm start
```

The VM-specific `fold.service` serves the production build. To deploy changes:

```sh
npm run build
sudo systemctl restart fold
journalctl -u fold -n 30 --no-pager
```

The service drains accepted operations during normal shutdown rather than interrupting a history rewrite. Fonts, syntax grammars, themes, and scripts are served locally.

## Safety / limits

This is a single-user, trusted-repository app, **not public multi-tenant hosting**. The exe.dev proxy provides authentication on this VM; the app has no login. Do not expose it without authentication. Mutation requests require JSON, a custom header, and an allowed origin; no CORS access is granted.

- Code coordinates map through the renderer to original one-based **patch-body indices**, not guessed source-line ranges. Context expansion never changes the underlying tool hunk IDs.
- Before squashing, the backend internally validates the exact patch, source, immediate parent, operation version, and tool IDs. It pins commit hashes, keeps destination descriptions, and retains emptied source changes.
- Reads/writes serialize. Stale requests, target overrides, and replayed operations are refused. No interactive tools or automatic mutation retries.
- Undo reverts one attributed operation with `jj op revert`, never `jj op restore`.
- Ambiguous failures leave a durable recovery guard. Inspect `jj op log` before proceeding; see `server/README.md` for recovery details.
- **Avoid concurrent edits or jj commands while squashing/undoing.** The in-process queue cannot lock external processes. A race may be detected only after a mutation, not prevented. Never run two Fold instances against one repository.
- Unsupported tool formats (binary, renames/copies, mode changes, no final newline, ambiguous paths) are read-only. Conflicted repositories are rejected.
- Diffs load one file at a time; very large files are not virtualized yet.

## Test

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run build
```

Browser tests exercise real code dragging, exact single-line and 3-of-40-line squashes, immediate-parent routing, keyboard undo, Shift-click, graph output, ten-line context expansion, selections from expanded context, shortcut guards, and mobile layout. Backend tests cover stale versions, invalid paths, immutable/merge parents, target overrides, pinned file contents, exact patches, persisted undo, and failure/interleaving recovery.

Fixtures remain in `/tmp/fold-backend-*` and `/tmp/fold-browser-*` for inspection. App source is Git-managed separately from the demo jj repositories.

## Source

- `src/main.tsx` — minimal shell, Files / Log, shortcuts
- `src/CodeDiff.tsx` — code-drag selection and context expansion
- `src/selection.ts` — exact selected patch rows
- `server/api.ts`, `server/service.ts` — versioned reads and safe mutations
- `server/diff.ts` — fail-closed parsing and patch reconciliation
- `server/demo.ts` — non-destructive demo creation

The parser was adapted from the existing local `hunk-jj-squash` project without modifying it. UI styling takes cues from Hunk’s terminal diff viewer.
