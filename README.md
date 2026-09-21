# Fold

A working web app for reviewing **Jujutsu working-copy diffs** and moving selected changes into earlier revisions with **jj-hunk-tool**. Diff rendering and native gutter selection use **@pierre/diffs** from diffs.com.

## Try the running demo

The VM serves Fold on port **8000**, managed by the `fold` systemd service. It starts with a real `orbit` repository: three TypeScript files, six independent hunks, and two mutable ancestors.

1. Check a hunk or file. Or click/drag line numbers for a range; Shift-click extends it.
2. Choose a destination revision in the right-hand panel.
3. **Preview squash** shows the exact selected patch and command. Nothing changes until you confirm.
4. Confirm to move the selected changes. The remaining diff stays in `@`; working-file contents stay unchanged.
5. **Undo squash** reverts the exact last app squash, if no other operation has occurred. **Start a fresh demo** creates a new repository and keeps the previous demo on disk.

Selections in separate hunks accumulate. A new range replaces the selection within its hunk. Unified view supports selecting individual additions or deletions; split view selects both sides of aligned display rows. Context rows are never squashed.

## Run locally

Requirements: Node.js 22.12+ (tested on 24), `jj`, and `jj-hunk-tool` on `PATH`.

```sh
npm ci
npm run dev
# Open http://localhost:8000
```

The initial request lazily creates a demo. `npm run demo` can initialize it explicitly and print its location; rerunning it does not reset anything. The active demo and last-operation journal persist in `.data/` (gitignored).

For a different, **trusted** jj workspace:

```sh
JJ_REPO=/absolute/path/to/workspace PORT=8001 npm start
```

The repository is configured on the server, not supplied in HTTP requests. Only the current `@` is reviewed, and only mutable ancestors are squash destinations. Demo reset is disabled for user repositories. Use a separate service/data directory if running multiple configured repositories; never run two Fold processes against the same repository.

### Production

```sh
npm run build
NODE_ENV=production npm start
```

`fold.service` is the installed VM-specific unit; it serves the production build on 8000. After code changes:

```sh
npm run build
sudo systemctl restart fold
journalctl -u fold -n 30 --no-pager
```

For hot-reload development, stop the service and run `npm run dev`, or use a separate port and a separate test repository. No credentials are required. Fonts, scripts, syntax grammars, and themes are served locally.

## Safety and scope

This is a single-user, trusted-repository prototype, not a public multi-tenant hosting service. The exe.dev proxy supplies authentication on this VM; the app itself has no login. Do not expose it without an authenticated proxy. Mutation endpoints require JSON, a custom header, and an allowed origin; no CORS permission is granted.

- Selections are translated to **jj-hunk-tool’s one-based patch-body rows**, not guessed from file line numbers.
- Preview verifies file identity, hunk position, context, and the exact selected additions/deletions. Execution repeats validation, pins commit hashes, preserves the destination description, and keeps emptied sources.
- Requests serialize; stale snapshots and replayed/expired preview tokens are refused. Tokens expire after ten minutes and on server restart.
- Undo uses a specific `jj op revert`, never `jj op restore`.
- Ambiguous or partially failed mutations are journaled and blocked from retry until an operator inspects history. The server never blindly retries, rolls back, or kills a rewrite on a timer.
- Binary files, renames, copies, mode changes, missing final newlines, whitespace/quoted paths, and other unsafe tool formats are displayed read-only. Conflicted repositories are rejected.
- **Do not concurrently edit files or run jj operations in the same workspace while confirming a squash.** External processes cannot be locked by the in-process queue; a race can be detected after a mutation, not necessarily prevented. See `server/README.md` for recovery and API details.
- This first version loads the diff eagerly; very large repositories are not yet virtualized.

## Tests

```sh
npm test                    # Unit tests and isolated real-jj integration tests
npx playwright install chromium
npm run test:browser        # Real Chromium + isolated jj repo; never touches the live demo
npm run build               # Type-check and build
```

Coverage includes full hunks, partial additions/deletions, cross-file/grandparent squash, untouched working files, exact persisted undo, stale/replayed/invalid requests, failed/interleaved operations, immutable/conflicted repositories, reset, native pointer selection, Shift-click, split layout, filtering, focus handling, and mobile overflow.

Test repositories are retained under `/tmp/fold-backend-*` and `/tmp/fold-browser-*` for inspection. The app project is Git-managed independently of the jj demo repositories.

## Structure

- `src/main.tsx` — review UI, selections, preview/confirmation workflow
- `src/selection.ts` — file-side coordinates → exact patch-body rows
- `server/api.ts` — validated JSON API
- `server/service.ts` — serialized, versioned preview/squash/undo operations
- `server/diff.ts` — fail-closed patch parsing and preview reconciliation
- `server/demo.ts` — isolated, non-destructive fixture creation
- `web.ts` — same-origin guards and Vite/production serving

The backend parser was adapted from the existing local `hunk-jj-squash` project without modifying it. Its core dependencies are React, Express, Pierre Diffs, Jujutsu, and mvzink/jj-hunk-tool.
