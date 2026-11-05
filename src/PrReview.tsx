import { useEffect, useId, useRef, useState } from "react";
import { api, errorMessage } from "./api";
import type {
  PrContext,
  PrListResult,
  PrOpenResult,
  PrReviewSummary,
} from "./pr-review-types";
import "./pr-review.css";

function navigateToWorkspace(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("The server returned an invalid local workspace address.");
  window.location.assign(url.href);
}

/** Real PR discovery/opening. Remote updates and submission are not implemented. */
export function PrReview({ disabled = false }: { disabled?: boolean }) {
  const id = useId();
  const toolbar = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const request = useRef(0);
  const opening = useRef(false);
  const [context, setContext] = useState<PrContext | null>(null);
  const [view, setView] = useState<"menu" | "selector" | null>(null);
  const [listing, setListing] = useState<PrListResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [direct, setDirect] = useState("");
  const [selectedNumber, setSelectedNumber] = useState<number | null>(null);
  const active = context?.pullRequest;
  const repository = listing?.repository ?? context?.repository;
  const normalized = query.trim().toLocaleLowerCase().replace(/^#/, "");
  const matches =
    listing?.pullRequests.filter((pr) =>
      `${pr.number} ${pr.title} ${pr.author?.login ?? ""}`
        .toLocaleLowerCase()
        .includes(normalized),
    ) ?? [];
  const selected = matches.find((pr) => pr.number === selectedNumber);

  useEffect(() => {
    let disposed = false;
    // Local session metadata only: this endpoint never contacts GitHub.
    void api<PrContext | null>("pr/context")
      .then((result) => {
        if (!disposed) setContext(result);
      })
      .catch(() => {
        // Embedders without PR support retain ordinary local reviewing.
      });
    return () => {
      disposed = true;
      request.current++;
    };
  }, []);

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (view) {
      if (!modal.open) modal.showModal();
      if (view === "selector") search.current?.focus();
      else modal.querySelector<HTMLButtonElement>("button")?.focus();
    } else if (modal.open) {
      modal.close();
      toolbar.current?.focus();
    }
  }, [view]);

  useEffect(() => {
    if (!busy) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (!opening.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [busy]);

  const close = () => {
    if (opening.current) return;
    request.current++;
    setView(null);
  };
  const loadList = async () => {
    const token = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await api<PrListResult>("pr/list");
      if (token !== request.current) return;
      setListing(result);
      setSelectedNumber((previous) =>
        result.pullRequests.some((pr) => pr.number === previous)
          ? previous
          : (result.pullRequests[0]?.number ?? null),
      );
    } catch (error) {
      if (token === request.current) setError(errorMessage(error));
    } finally {
      if (token === request.current) setLoading(false);
    }
  };
  const openSelector = () => {
    setView("selector");
    void loadList();
  };
  const openPr = async (input: string) => {
    if (opening.current || disabled || !input.trim()) return;
    opening.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api<PrOpenResult>("pr/open", {
        input: input.trim(),
      });
      // Do not prompt our own navigation after the accepted operation finished.
      opening.current = false;
      setBusy(false);
      navigateToWorkspace(result.url);
    } catch (error) {
      setError(errorMessage(error));
      opening.current = false;
      setBusy(false);
    }
  };
  const identity = (pr: PrReviewSummary) => `#${pr.number} · ${pr.title}`;

  return (
    <>
      <button
        className="action-button"
        ref={toolbar}
        disabled={disabled || busy}
        aria-haspopup="dialog"
        aria-expanded={view !== null}
        aria-controls={id}
        title={active ? identity(active) : "Open a GitHub pull request"}
        onClick={() => {
          setError("");
          if (active) setView("menu");
          else openSelector();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        onKeyUp={(event) => event.stopPropagation()}
      >
        {active ? `PR #${active.number} ▾` : "Open PR…"}
      </button>
      <dialog
        ref={dialog}
        id={id}
        className={`pr-review-dialog ${view === "selector" ? "pr-review-selector" : ""}`}
        aria-labelledby={`${id}-title`}
        aria-busy={busy || loading}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
        }}
        onKeyUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            close();
        }}
      >
        <header className="pr-review-heading">
          <div>
            <h2 id={`${id}-title`}>
              {view === "selector" ? "Pull requests" : "PR review"}
            </h2>
            <p>
              {repository?.url.replace(/^https:\/\//, "") ??
                "Current repository"}
            </p>
          </div>
          <button disabled={busy} onClick={close}>
            Back to workspace
          </button>
        </header>
        {view === "selector" ? (
          <>
            <form
              className="pr-review-direct"
              onSubmit={(event) => {
                event.preventDefault();
                void openPr(direct);
              }}
            >
              <label>
                Open a PR by number or URL
                <input
                  value={direct}
                  onChange={(event) => setDirect(event.target.value)}
                  placeholder={
                    repository
                      ? `#284 or ${repository.url}/pull/284`
                      : "#284 or a PR URL on your GitHub host"
                  }
                  disabled={busy}
                  autoComplete="off"
                  spellCheck={false}
                />
              </label>
              <button disabled={busy || disabled || !direct.trim()}>
                Open directly
              </button>
            </form>
            {error && (
              <p className="pr-review-error" role="alert">
                {error}
              </p>
            )}
            <div className="pr-review-body">
              <section className="pr-review-list" aria-label="Review requests">
                <div className="pr-review-search">
                  <label>
                    Filter by title, author, or number
                    <input
                      ref={search}
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      disabled={busy}
                      autoComplete="off"
                      placeholder="Filter pull requests…"
                    />
                  </label>
                  <div className="pr-review-list-status">
                    <span role="status">
                      {loading
                        ? "Finding review requests for you and your teams…"
                        : `${matches.length} shown · first ${listing?.limit ?? 50} unmerged PRs for you and your teams`}
                    </span>
                    <button
                      disabled={loading || busy}
                      onClick={() => void loadList()}
                    >
                      Reload list
                    </button>
                  </div>
                </div>
                <div className="pr-review-results">
                  {matches.map((pr) => (
                    <button
                      key={pr.number}
                      className="pr-review-choice"
                      aria-pressed={selectedNumber === pr.number}
                      disabled={busy}
                      onClick={() => setSelectedNumber(pr.number)}
                    >
                      <strong>{identity(pr)}</strong>
                      <span>
                        @{pr.author?.login ?? "unknown"} · {pr.headRefName} →{" "}
                        {pr.baseRefName}
                        {pr.isDraft ? " · Draft" : ""}
                      </span>
                    </button>
                  ))}
                  {!matches.length && !loading && (
                    <p className="pr-review-empty">
                      {listing
                        ? "No review requests match. You can still enter a number or URL."
                        : "Use Reload list or enter a PR number or URL above."}
                    </p>
                  )}
                </div>
              </section>
              <aside
                className="pr-review-details"
                aria-label="Selected PR details"
              >
                {selected ? (
                  <>
                    <p>#{selected.number}</p>
                    <h3>{selected.title}</h3>
                    <dl>
                      <dt>Author</dt>
                      <dd>@{selected.author?.login ?? "unknown"}</dd>
                      <dt>Branches</dt>
                      <dd>
                        {selected.headRefName} → {selected.baseRefName}
                      </dd>
                      <dt>Head</dt>
                      <dd>
                        <code>{selected.headRefOid.slice(0, 12)}</code>
                      </dd>
                    </dl>
                  </>
                ) : (
                  <p>Select a PR to see its details.</p>
                )}
                <div className="pr-review-notice">
                  <strong>Review in a separate local workspace</strong>
                  <p>
                    Opening creates or resumes a managed jj workspace and its
                    review stack. Your original checkout stays untouched.
                  </p>
                  <p>
                    Existing reviews resume local progress, not a newly imported
                    remote head. Remote updates and GitHub submission are not
                    implemented yet.
                  </p>
                </div>
              </aside>
            </div>
            <footer className="pr-review-footer">
              <p role="status">
                {busy
                  ? "Opening the managed workspace… Keep this window open."
                  : selected
                    ? identity(selected)
                    : "Choose a PR or enter its number or URL."}
              </p>
              <button
                className="pr-review-primary"
                disabled={!selected || busy || disabled}
                onClick={() => selected && void openPr(String(selected.number))}
              >
                {busy ? "Opening…" : "Open / resume review"}
              </button>
            </footer>
          </>
        ) : active ? (
          <div className="pr-review-menu">
            <h3>{identity(active)}</h3>
            <p>Imported head: {active.headRefOid.slice(0, 12)}</p>
            <p>
              Local review workspace. Add comments from a selected new-side code
              line; drafts are saved as JJ-STAMP markers in the file.
            </p>
            <button onClick={openSelector}>Open another PR…</button>
            {context?.originalWorkspaceUrl && (
              <button
                onClick={() => {
                  try {
                    navigateToWorkspace(context.originalWorkspaceUrl!);
                  } catch (error) {
                    setError(errorMessage(error));
                  }
                }}
              >
                Return to original workspace
              </button>
            )}
            <p className="pr-review-notice">
              Refresh PR, GitHub submission, and dismissal are not implemented
              yet. The existing Refresh button only rereads local files/history.
            </p>
            {error && <p role="alert">{error}</p>}
          </div>
        ) : null}
      </dialog>
    </>
  );
}
