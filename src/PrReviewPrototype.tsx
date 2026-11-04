import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  createSampleReviews,
  filterSamplePullRequests,
  resolveSamplePullRequest,
  SAMPLE_REPOSITORY,
  samplePullRequests,
  type PrScope,
  type SampleReview,
} from "./pr-review-prototype-data";
import "./pr-review-prototype.css";

type View = "menu" | "selector" | "comments" | "submit" | "dismiss";

/** Option A: an entirely local, opt-in PR metadata preview, not a workspace. */
export function PrReviewPrototype({
  disabled = false,
}: {
  disabled?: boolean;
}) {
  const id = useId();
  const toolbar = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const commentInput = useRef<HTMLTextAreaElement>(null);
  const nextComment = useRef(0);
  const [view, setView] = useState<View | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [reviews, setReviews] = useState(createSampleReviews);
  const [previewNumber, setPreviewNumber] = useState<number | null>(null);
  const [selectedNumber, setSelectedNumber] = useState<number | null>(284);
  const [scope, setScope] = useState<PrScope>("requested");
  const [query, setQuery] = useState("");
  const [direct, setDirect] = useState("");
  const [directError, setDirectError] = useState("");
  const [status, setStatus] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [reviewEvent, setReviewEvent] = useState("Comment");
  const [summary, setSummary] = useState("");

  const activeNumbers = Object.keys(reviews).map(Number);
  const matches = filterSamplePullRequests(query, scope, activeNumbers);
  const selected = matches.find((pr) => pr.number === selectedNumber);
  const preview = samplePullRequests.find((pr) => pr.number === previewNumber);
  const review = preview ? reviews[preview.number] : undefined;
  const stagedCount = review?.comments.length ?? 0;
  const unmappedCount =
    review?.comments.filter((comment) => comment.unmapped).length ?? 0;

  const close = () => setView(null);
  const go = (next: View) => {
    setStatus("");
    setView(next);
  };
  const openMenu = () => {
    if (disabled) return;
    const rect = toolbar.current?.getBoundingClientRect();
    setPosition({
      left: Math.max(
        8,
        Math.min((rect?.right ?? 380) - 380, window.innerWidth - 388),
      ),
      top: Math.max(8, (rect?.bottom ?? 38) + 6),
    });
    go("menu");
  };
  const updateReview = (update: (current: SampleReview) => SampleReview) => {
    if (!preview) return;
    setReviews((current) => ({
      ...current,
      [preview.number]: update(
        current[preview.number] ?? { comments: [], refreshed: false },
      ),
    }));
  };
  const beginPreview = () => {
    if (!selected) return;
    setReviews((current) =>
      current[selected.number]
        ? current
        : {
            ...current,
            [selected.number]: { comments: [], refreshed: true },
          },
    );
    setPreviewNumber(selected.number);
    setCommentBody("");
    setEditingId(null);
    setSummary("");
    close();
  };

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    if (view) {
      if (!modal.open) modal.showModal();
      if (view === "selector") {
        search.current?.focus({ preventScroll: true });
      } else {
        const initialFocus =
          modal.querySelector<HTMLElement>("[data-pr-initial-focus]") ??
          modal.querySelector<HTMLElement>("button:not(:disabled)");
        initialFocus?.focus({ preventScroll: true });
      }
    } else if (modal.open) {
      modal.close();
      toolbar.current?.focus({ preventScroll: true });
    }
  }, [view]);

  useEffect(() => {
    if (disabled) setView(null);
  }, [disabled]);

  // React updates the existing input/list nodes: typing never replaces the
  // search field, steals focus, or attaches document-level shortcuts.
  const handleKeys = (event: KeyboardEvent<HTMLDialogElement>) => {
    event.stopPropagation();
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ),
    ).filter((element) => element.getClientRects().length > 0);
    if (event.key === "Tab") {
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    if (
      view === "menu" &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? controls.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + controls.length) %
              controls.length;
      controls[next]?.focus();
    }
  };

  const title =
    view === "selector"
      ? "Pull requests"
      : view === "comments"
        ? "Staged comments preview"
        : view === "submit"
          ? "Submit review — simulation"
          : view === "dismiss"
            ? "Dismiss local preview?"
            : "PR actions";

  return (
    <>
      <button
        ref={toolbar}
        className="action-button prp-toolbar-button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={view !== null}
        aria-controls={id}
        title="PR review prototype — sample metadata only"
        onClick={openMenu}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
          }
        }}
        onKeyUp={(event) => event.stopPropagation()}
      >
        {preview ? `PR preview #${preview.number}` : "PR preview"}
        <span className="prp-toolbar-demo">DEMO</span>
        <span aria-hidden="true">▾</span>
      </button>
      <dialog
        ref={dialog}
        id={id}
        className={`prp-dialog ${view === "selector" ? "prp-selector" : view === "menu" ? "prp-menu" : "prp-sheet"}`}
        style={view === "menu" ? position : undefined}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-scope`}
        onCancel={(event) => {
          event.preventDefault();
          close();
        }}
        onClose={() => {
          setView(null);
          toolbar.current?.focus({ preventScroll: true });
        }}
        onKeyDown={handleKeys}
        onKeyUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          if (view !== "menu" || event.target !== event.currentTarget) return;
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            close();
        }}
      >
        <header className="prp-heading">
          <div>
            <div className="prp-kicker">PROTOTYPE / SAMPLE DATA</div>
            <h2 id={`${id}-title`}>{title}</h2>
            <p className="prp-muted" id={`${id}-scope`}>
              {SAMPLE_REPOSITORY} · sample repository only
            </p>
          </div>
          <button
            className="prp-back"
            aria-label="Back to workspace"
            onClick={close}
          >
            {view === "selector" ? "← Back to workspace" : "×"}
          </button>
        </header>

        {view === "selector" ? (
          <>
            <section className="prp-direct" aria-label="Open a PR directly">
              <form
                onSubmit={(event) => {
                  event.preventDefault();
                  const result = resolveSamplePullRequest(direct);
                  if (result.error) {
                    setDirectError(result.error);
                    return;
                  }
                  if (!result.pr) return;
                  setDirectError("");
                  setScope("all");
                  setQuery("");
                  setSelectedNumber(result.pr.number);
                  setStatus(
                    `Selected sample #${result.pr.number}. Start or resume its metadata preview below.`,
                  );
                }}
              >
                <label className="prp-direct-field">
                  Open a PR by number or URL
                  <input
                    value={direct}
                    onChange={(event) => {
                      setDirect(event.target.value);
                      setDirectError("");
                    }}
                    placeholder="#284 or https://github.com/orbit/notifications/pull/284"
                    aria-invalid={!!directError}
                    aria-describedby={
                      directError ? `${id}-direct-error` : undefined
                    }
                    required
                  />
                </label>
                <button className="prp-primary" type="submit">
                  Open directly
                </button>
              </form>
              {directError && (
                <p id={`${id}-direct-error`} className="prp-error" role="alert">
                  {directError}
                </p>
              )}
              {status && <p role="status">{status}</p>}
            </section>
            <div className="prp-selector-body">
              <section className="prp-list-pane" aria-label="Pull request list">
                <div className="prp-list-tools">
                  <div className="prp-filters" aria-label="Filter PRs">
                    {(
                      [
                        [
                          "requested",
                          "Review requested",
                          samplePullRequests.filter((pr) => pr.requested)
                            .length,
                        ],
                        ["active", "Active locally", activeNumbers.length],
                        ["all", "All sample PRs", samplePullRequests.length],
                      ] as const
                    ).map(([value, label, count]) => (
                      <button
                        key={value}
                        aria-pressed={scope === value}
                        onClick={() => {
                          setScope(value);
                          setStatus("");
                        }}
                      >
                        {label} · {count}
                      </button>
                    ))}
                  </div>
                  <label htmlFor={`${id}-search`}>
                    Filter by title, author, or number
                  </label>
                  <input
                    ref={search}
                    id={`${id}-search`}
                    value={query}
                    placeholder="Filter pull requests…"
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setStatus("");
                    }}
                  />
                  <output aria-live="polite">
                    {matches.length} sample pull request
                    {matches.length === 1 ? "" : "s"}
                  </output>
                </div>
                <div className="prp-results">
                  {matches.map((pr) => (
                    <button
                      className="prp-choice"
                      key={pr.number}
                      aria-pressed={selected?.number === pr.number}
                      onClick={() => setSelectedNumber(pr.number)}
                    >
                      <span className="prp-choice-top">
                        <span className="prp-number">#{pr.number}</span>
                        <strong>{pr.title}</strong>
                      </span>
                      <span className="prp-choice-meta">
                        <span>@{pr.author}</span>
                        <span>{pr.updated} (sample)</span>
                        <span>
                          {pr.files.length} files · +{pr.additions} −
                          {pr.deletions}
                        </span>
                        {reviews[pr.number] && (
                          <span className="prp-local">
                            Local sample · {reviews[pr.number].comments.length}{" "}
                            staged
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                  {!matches.length && (
                    <p className="prp-empty">
                      No sample PRs match. Try a different filter or scope.
                    </p>
                  )}
                </div>
              </section>
              <aside
                className="prp-detail"
                aria-label="Selected PR details"
                tabIndex={0}
                key={selected?.number ?? "empty"}
              >
                {selected ? (
                  <>
                    <div className="prp-number">
                      {SAMPLE_REPOSITORY} #{selected.number}
                    </div>
                    <h3>{selected.title}</h3>
                    <p>{selected.summary}</p>
                    <dl className="prp-facts">
                      <dt>Author</dt>
                      <dd>@{selected.author}</dd>
                      <dt>Updated</dt>
                      <dd>{selected.updated} (fixed sample)</dd>
                      <dt>Branches</dt>
                      <dd>{selected.branch} → main</dd>
                      <dt>Changes</dt>
                      <dd>
                        {selected.files.length} files · +{selected.additions} −
                        {selected.deletions}
                      </dd>
                    </dl>
                    <div className="prp-notice">
                      <strong>
                        {reviews[selected.number]
                          ? "Continue your local sample preview"
                          : "Start a local sample preview"}
                      </strong>
                      <p>
                        {reviews[selected.number]
                          ? `${reviews[selected.number].comments.length} staged sample comments. `
                          : "No sample comments staged yet. "}
                        Metadata only: no workspace is created or switched.
                      </p>
                    </div>
                    <h4>Changed files (sample)</h4>
                    <ul className="prp-files">
                      {selected.files.map((file) => (
                        <li key={file}>{file}</li>
                      ))}
                    </ul>
                    <p className="prp-muted">
                      These files are fixture metadata, not the diff behind this
                      dialog.
                    </p>
                  </>
                ) : (
                  <p className="prp-empty">
                    Select a sample PR from the current results to preview its
                    details.
                  </p>
                )}
              </aside>
            </div>
            <footer className="prp-selector-footer">
              <div>
                <p>
                  {selected
                    ? `#${selected.number} · ${selected.title}`
                    : "No PR selected in current results"}
                </p>
                <p className="prp-muted">
                  Preview metadata only. The underlying diff stays current. No
                  GitHub, API, or jj calls.
                </p>
              </div>
              <button
                className="prp-primary"
                disabled={!selected}
                onClick={beginPreview}
              >
                {selected && reviews[selected.number] ? "Resume" : "Start"} PR
                preview
              </button>
            </footer>
          </>
        ) : view === "menu" ? (
          <div className="prp-menu-body">
            {preview ? (
              <>
                <h3>
                  #{preview.number} · {preview.title}
                </h3>
                <p className="prp-muted">
                  Preview metadata, not a PR workspace.
                </p>
                <div className="prp-notice">
                  {review?.refreshed
                    ? "Sample head is current (simulated)."
                    : "Sample PR head update available."}
                  <p>Refresh below changes only this demo’s update badge.</p>
                </div>
                <nav aria-label="PR preview actions">
                  <button
                    onClick={() => {
                      updateReview((current) => ({
                        ...current,
                        refreshed: true,
                      }));
                      setStatus(
                        "Simulated import complete. No remote request, workspace change, or diff refresh occurred.",
                      );
                    }}
                  >
                    Refresh PR (simulate)
                  </button>
                  <button onClick={() => go("comments")}>
                    Staged comments preview · {stagedCount}
                    {unmappedCount > 0 && ` / ${unmappedCount} unmapped`}
                  </button>
                  <button className="prp-primary" onClick={() => go("submit")}>
                    Submit review… (simulate)
                  </button>
                  <hr />
                  <button onClick={() => go("selector")}>Open PR…</button>
                  <button className="prp-danger" onClick={() => go("dismiss")}>
                    Dismiss local preview…
                  </button>
                </nav>
              </>
            ) : (
              <>
                <p>
                  Explore sample PR metadata alongside your current workspace.
                  Nothing is fetched, imported, or published.
                </p>
                <nav aria-label="PR preview actions">
                  <button
                    className="prp-primary"
                    onClick={() => go("selector")}
                  >
                    Open PR…
                  </button>
                </nav>
              </>
            )}
            {status && (
              <p className="prp-notice" role="status">
                {status}
              </p>
            )}
            <p className="prp-fine">
              In-memory only; reloading resets the prototype.
            </p>
          </div>
        ) : view === "comments" && preview ? (
          <div className="prp-sheet-body">
            <p>
              #{preview.number} · Local sample drafts only, not on GitHub.
              Line-diff commenting is not connected.
            </p>
            <div className="prp-comment-list">
              {review?.comments.map((comment) => (
                <article className="prp-comment" key={comment.id}>
                  <code>{comment.location}</code>
                  <p>{comment.body}</p>
                  <p className={comment.unmapped ? "prp-warning" : "prp-muted"}>
                    {comment.unmapped
                      ? "Needs manual review — sample location is unmapped. Kept locally; never submitted."
                      : "Staged locally (sample)"}
                  </p>
                  <div className="prp-actions">
                    <button
                      aria-label={`Edit comment: ${comment.body}`}
                      onClick={() => {
                        setEditingId(comment.id);
                        setCommentBody(comment.body);
                        commentInput.current?.focus();
                      }}
                    >
                      Edit
                    </button>
                    <button
                      aria-label={`Remove comment: ${comment.body}`}
                      onClick={() => {
                        updateReview((current) => ({
                          ...current,
                          comments: current.comments.filter(
                            (item) => item.id !== comment.id,
                          ),
                        }));
                        if (editingId === comment.id) {
                          setEditingId(null);
                          setCommentBody("");
                        }
                        setStatus("Sample comment removed locally.");
                      }}
                    >
                      Remove locally
                    </button>
                  </div>
                </article>
              ))}
              {!stagedCount && <p>No staged sample comments.</p>}
            </div>
            <form
              className="prp-composer"
              onSubmit={(event) => {
                event.preventDefault();
                const body = commentBody.trim();
                if (!body) return;
                const commentId = `local-${++nextComment.current}`;
                updateReview((current) => ({
                  ...current,
                  comments: editingId
                    ? current.comments.map((comment) =>
                        comment.id === editingId
                          ? { ...comment, body }
                          : comment,
                      )
                    : [
                        ...current.comments,
                        {
                          id: commentId,
                          body,
                          location: "General PR note (local sample)",
                        },
                      ],
                }));
                setStatus(
                  editingId
                    ? "Sample comment updated locally."
                    : "Sample note staged locally. Nothing was published.",
                );
                setEditingId(null);
                setCommentBody("");
                commentInput.current?.focus();
              }}
            >
              <label htmlFor={`${id}-comment`}>
                {editingId ? "Edit sample comment" : "Add a local sample note"}
              </label>
              <textarea
                ref={commentInput}
                id={`${id}-comment`}
                value={commentBody}
                onChange={(event) => setCommentBody(event.target.value)}
                maxLength={10000}
                required
              />
              <div className="prp-actions">
                {editingId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingId(null);
                      setCommentBody("");
                    }}
                  >
                    Cancel edit
                  </button>
                )}
                <button
                  className="prp-primary"
                  type="submit"
                  disabled={!commentBody.trim()}
                >
                  {editingId ? "Save locally" : "Stage sample note"}
                </button>
              </div>
            </form>
            {status && (
              <p role="status" className="prp-notice">
                {status}
              </p>
            )}
            <div className="prp-actions">
              <button onClick={() => go("menu")}>Back to PR actions</button>
              <button onClick={() => go("submit")}>
                Submit review… (simulate)
              </button>
            </div>
          </div>
        ) : view === "submit" && preview ? (
          <div className="prp-sheet-body">
            <p>
              #{preview.number} · {preview.title}
            </p>
            <div className="prp-notice">
              This is a simulation. No review, approval, or comment will be
              sent. All {stagedCount} sample drafts stay staged.
              {unmappedCount > 0 &&
                ` ${unmappedCount} unmapped comment stays local.`}
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setStatus(
                  `Simulated “${reviewEvent}” preview complete. Nothing sent to GitHub. All sample drafts retained.`,
                );
              }}
            >
              <fieldset className="prp-review-events">
                <legend>Review type (simulation only)</legend>
                {["Comment", "Approve", "Request changes"].map((value) => (
                  <label key={value}>
                    <input
                      type="radio"
                      name={`${id}-event`}
                      value={value}
                      checked={reviewEvent === value}
                      onChange={() => setReviewEvent(value)}
                    />
                    {value}
                  </label>
                ))}
              </fieldset>
              <label htmlFor={`${id}-summary`}>
                Overall message (local sample)
              </label>
              <textarea
                id={`${id}-summary`}
                value={summary}
                onChange={(event) => setSummary(event.target.value)}
                maxLength={10000}
              />
              <div className="prp-actions">
                <button type="button" onClick={() => go("menu")}>
                  Cancel
                </button>
                <button className="prp-primary" type="submit">
                  Confirm simulation — send nothing
                </button>
              </div>
            </form>
            {status && (
              <p role="status" className="prp-notice">
                {status}
              </p>
            )}
          </div>
        ) : view === "dismiss" && preview ? (
          <div className="prp-sheet-body">
            <p>
              Discard the local sample session for #{preview.number}, including{" "}
              {stagedCount} staged sample comments? This cannot be undone during
              this page session.
            </p>
            <p className="prp-notice">
              Only prototype memory changes. GitHub and your actual jj workspace
              stay untouched. Reloading restores the original fixtures.
            </p>
            <div className="prp-actions">
              <button data-pr-initial-focus onClick={() => go("menu")}>
                Keep preview
              </button>
              <button
                className="prp-danger"
                onClick={() => {
                  setReviews((current) => {
                    const next = { ...current };
                    delete next[preview.number];
                    return next;
                  });
                  setPreviewNumber(null);
                  setCommentBody("");
                  setEditingId(null);
                  setSummary("");
                  close();
                }}
              >
                Discard local sample preview
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </>
  );
}
