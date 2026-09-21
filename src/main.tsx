import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { FileDiff } from "@pierre/diffs/react";
import { parsePatchFiles, type SelectedLineRange } from "@pierre/diffs";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Columns2,
  FileCode2,
  Files,
  GitBranch,
  GitCommitHorizontal,
  Layers2,
  List,
  LoaderCircle,
  MousePointer2,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import type { DiffFile, Hunk, Preview, RepoState, Selections } from "./types";
import { changed, rangeForRows, rowsForRange } from "./selection";
import "@fontsource-variable/dm-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { displayPatch } from "./patch-display";

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api/${path}`,
    body === undefined
      ? { cache: "no-store" }
      : {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fold-Request": "1",
          },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error || `Request failed (${response.status})`);
  return result;
}
const short = (id: string) => id.slice(0, 8);
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;
function Logo() {
  return (
    <span className="logo-mark">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <path d="M5 6h22L16 17z" fill="currentColor" />
        <path d="M5 15h22L16 26z" fill="currentColor" opacity=".6" />
      </svg>
    </span>
  );
}
function Checkbox({
  checked,
  partial = false,
  label,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  partial?: boolean;
  label: string;
  onChange: () => void;
  disabled?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial && !checked;
  }, [partial, checked]);
  return (
    <input
      ref={ref}
      className="checkbox"
      type="checkbox"
      aria-label={label}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
    />
  );
}
function HunkView({
  hunk,
  file,
  index,
  selection,
  onSelect,
  style,
  disabled,
}: {
  hunk: Hunk;
  file: DiffFile;
  index: number;
  selection: number[];
  onSelect: (lines: number[]) => void;
  style: "split" | "unified";
  disabled: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const count = changed(hunk).length;
  const fileDiff = useMemo(() => {
    const prefix = file.patch.split(/^@@ /m)[0];
    return parsePatchFiles(
      `${prefix}${hunk.header}\n${hunk.rows.map((row) => row.raw).join("\n")}\n`,
    )[0]?.files[0];
  }, [file.patch, hunk]);
  const onRange = useCallback(
    (range: SelectedLineRange | null) => {
      setDragging(false);
      if (!disabled && range) onSelect(rowsForRange(hunk, range, style));
    },
    [disabled, hunk, onSelect, style],
  );
  const exactSelectionCSS = useMemo(() => {
    if (dragging) return "";
    const selectors = hunk.rows
      .filter((row) => selection.includes(row.index))
      .flatMap((row) => {
        const type = row.raw[0] === "-" ? "change-deletion" : "change-addition";
        const line = row.raw[0] === "-" ? row.oldLine : row.newLine;
        return [
          `[data-line-type="${type}"][data-line="${line}"]`,
          `[data-line-type="${type}"][data-column-number="${line}"]`,
        ];
      });
    // A persistent selection paints only the exact changed rows, even after changing layouts.
    return (
      "[data-selected-line] { --diffs-computed-selected-line-bg: var(--diffs-computed-diff-line-bg); }" +
      (selectors.length
        ? `${selectors.join(",")} { background-color: #e3eef9; box-shadow: inset 2px 0 #789ebe; }`
        : "")
    );
  }, [hunk, selection, dragging]);
  const options = useMemo(
    () => ({
      theme: "pierre-light",
      themeType: "light" as const,
      diffStyle: style,
      diffIndicators: "classic" as const,
      disableFileHeader: true,
      hunkSeparators: "metadata" as const,
      enableLineSelection: !disabled,
      lineHoverHighlight: "both" as const,
      onLineSelected: onRange,
      onLineSelectionStart: () => setDragging(true),
      overflow: "scroll" as const,
      unsafeCSS: "[data-separator] { display: none; }" + exactSelectionCSS,
    }),
    [style, disabled, onRange, exactSelectionCSS],
  );
  const selectedLines = useMemo(
    () => rangeForRows(hunk, selection),
    [hunk, selection],
  );
  return (
    <section
      className={`hunk ${selection.length ? "hunk-selected" : ""}`}
      data-hunk-id={hunk.id}
    >
      <div className="hunk-toolbar">
        <label>
          <Checkbox
            checked={selection.length === count}
            partial={selection.length > 0}
            label={`Select hunk ${index + 1} in ${file.path}`}
            onChange={() =>
              onSelect(
                selection.length === count
                  ? []
                  : changed(hunk).map((row) => row.index),
              )
            }
            disabled={disabled}
          />
          <span>Hunk {index + 1}</span>
        </label>
        <code className="hunk-location">
          {hunk.header.replace(/ @@.*$/, " @@")}
        </code>
        <span className="hunk-selection">
          {selection.length ? (
            <>
              <Check size={12} />
              {selection.length} lines selected
            </>
          ) : (
            `${count} changed lines`
          )}
        </span>
      </div>
      {fileDiff && (
        <FileDiff
          fileDiff={fileDiff}
          options={options}
          selectedLines={selectedLines}
          className="code-diff"
        />
      )}
    </section>
  );
}
function DiffCard({
  file,
  selections,
  setSelection,
  style,
  busy,
  collapsed,
  toggleCollapse,
}: {
  file: DiffFile;
  selections: Selections;
  setSelection: (values: Selections) => void;
  style: "split" | "unified";
  busy: boolean;
  collapsed: boolean;
  toggleCollapse: () => void;
}) {
  const all = file.hunks.every(
    (h) => selections[h.id]?.length === changed(h).length,
  );
  const any = file.hunks.some((h) => selections[h.id]?.length);
  return (
    <article className="diff-card" id={`file-${file.path}`}>
      <header className="file-header">
        <Checkbox
          checked={all && file.hunks.length > 0}
          partial={any}
          label={`Select all changes in ${file.path}`}
          disabled={busy || !!file.unsupported || !file.hunks.length}
          onChange={() =>
            setSelection(
              Object.fromEntries(
                file.hunks.map((h) => [
                  h.id,
                  all ? [] : changed(h).map((r) => r.index),
                ]),
              ),
            )
          }
        />
        <button
          className="file-title"
          onClick={toggleCollapse}
          aria-expanded={!collapsed}
        >
          <ChevronDown size={15} className={collapsed ? "rotated" : ""} />
          <FileCode2 size={16} />
          <span>{file.path}</span>
        </button>
        <span className="file-hunk-count">
          {plural(file.hunks.length, "hunk")}
        </span>
        <span className="diff-stat">
          <span className="added">+{file.additions}</span>
          <span className="removed">−{file.deletions}</span>
        </span>
      </header>
      {!collapsed &&
        (file.unsupported ? (
          <div className="unsupported">
            <ShieldCheck size={20} />
            <div>
              <b>Read-only change</b>
              <p>{file.unsupported}</p>
              <pre>{file.patch}</pre>
            </div>
          </div>
        ) : (
          file.hunks.map((hunk, index) => (
            <HunkView
              key={hunk.id}
              hunk={hunk}
              file={file}
              index={index}
              selection={selections[hunk.id] || []}
              onSelect={(lines) => setSelection({ [hunk.id]: lines })}
              style={style}
              disabled={busy}
            />
          ))
        ))}
    </article>
  );
}
function PreviewDiff({ patch }: { patch: string }) {
  const files = useMemo(
    () => parsePatchFiles(displayPatch(patch)).flatMap((p) => p.files),
    [patch],
  );
  const options = useMemo(
    () => ({
      theme: "pierre-light",
      themeType: "light" as const,
      diffStyle: "unified" as const,
      diffIndicators: "classic" as const,
      hunkSeparators: "metadata" as const,
    }),
    [],
  );
  return (
    <>
      {files.map((file, i) => (
        <FileDiff key={`${file.name}-${i}`} fileDiff={file} options={options} />
      ))}
    </>
  );
}

function App() {
  const [state, setState] = useState<RepoState | null>(null);
  const [selections, setSelections] = useState<Selections>({});
  const [target, setTarget] = useState("");
  const [style, setStyle] = useState<"split" | "unified">("unified");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [help, setHelp] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeFile, setActiveFile] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const accept = useCallback((next: RepoState) => {
    setState(next);
    setSelections({});
    setPreview(null);
    setTarget((current) =>
      next.targets.some((t) => t.changeId === current)
        ? current
        : next.targets[0]?.changeId || "",
    );
  }, []);
  const refresh = useCallback(
    async (initial = false) => {
      setBusy("refresh");
      setError("");
      try {
        accept(await api<RepoState>("state"));
        if (!initial)
          setNotice(
            "Diff refreshed. You’re reviewing the latest working copy.",
          );
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy("");
      }
    },
    [accept],
  );
  useEffect(() => {
    void refresh(true);
  }, [refresh]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) {
        setPreview(null);
        setHelp(false);
        setResetConfirm(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [busy]);
  const modalOpen = !!preview || help || resetConfirm;
  useEffect(() => {
    if (!modalOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const background = [
      ...document.querySelectorAll<HTMLElement>(".topbar, .workspace"),
    ];
    background.forEach((node) => {
      node.inert = true;
    });
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !dialog) return;
      const controls = [
        ...dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), summary, [tabindex="0"]',
        ),
      ];
      const first = controls[0],
        last = controls.at(-1);
      if (!first) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog.contains(document.activeElement))
      ) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      background.forEach((node) => {
        node.inert = false;
      });
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, [modalOpen]);
  const files = state?.files || [];
  const hunks = files.flatMap((file) => file.hunks);
  const selected = hunks.filter((h) => selections[h.id]?.length);
  const selectedFiles = files.filter((f) =>
    f.hunks.some((h) => selections[h.id]?.length),
  );
  const selectedCount = selected.reduce(
    (n, h) => n + selections[h.id].length,
    0,
  );
  const additions = files.reduce((n, f) => n + f.additions, 0),
    deletions = files.reduce((n, f) => n + f.deletions, 0);
  const destination = state?.targets.find((t) => t.changeId === target);
  const setSelection = useCallback((values: Selections) => {
    setSelections((current) => ({ ...current, ...values }));
    setPreview(null);
  }, []);
  async function prepare() {
    if (!state) return;
    setBusy("preview");
    setError("");
    try {
      setPreview(
        await api<Preview>("preview", {
          version: state.version,
          target,
          selections: selected.map((h) => ({
            id: h.id,
            lines: selections[h.id],
          })),
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  async function squash() {
    if (!preview) return;
    setBusy("squash");
    setError("");
    try {
      const result = await api<{
        state: RepoState;
        output: string;
        warning?: string;
      }>("squash", { token: preview.token });
      const count = preview.selectedLines;
      accept(result.state);
      setNotice(
        `${plural(count, "changed line")} squashed into ${short(target)}. The rest of your working copy is untouched.`,
      );
      if (result.warning) setError(result.warning);
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy("");
    }
  }
  async function mutate(action: "undo" | "reset") {
    if (!state) return;
    setBusy(action);
    setError("");
    try {
      const result = await api<{ state: RepoState }>(action, {
        version: state.version,
      });
      accept(result.state);
      setNotice(
        action === "undo"
          ? "Squash undone. Your selected changes are back in the working copy."
          : "Fresh demo ready. Try selecting a few lines this time.",
      );
      setResetConfirm(false);
      setCollapsed({});
      setFilter("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  }
  function jumpTo(file: DiffFile) {
    setActiveFile(file.path);
    setCollapsed((current) => ({ ...current, [file.path]: false }));
    requestAnimationFrame(() =>
      document
        .getElementById(`file-${file.path}`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  }
  return (
    <>
      <header className="topbar">
        <a className="brand" href="/" aria-label="Fold home">
          <Logo />
          <span>fold</span>
          <span className="brand-tag">for jj</span>
        </a>
        <div className="breadcrumb">
          <span className="slash">/</span>
          <GitBranch size={15} />
          <span>{state?.repo.name || "orbit"}</span>
          <ChevronRight size={13} />
          <strong>Review</strong>
        </div>
        <div className="topbar-right">
          <span className="connection">
            <span />
            {state?.repo.demo
              ? "Live demo repository"
              : state
                ? "Connected repository"
                : "Connecting"}
          </span>
          <button
            className="icon-button"
            title="How Fold works"
            aria-label="How Fold works"
            onClick={() => setHelp(true)}
          >
            <CircleHelp size={19} />
          </button>
          <span className="avatar">EL</span>
        </div>
      </header>
      <div className="workspace">
        <aside className="sidebar">
          <div className="repo-label">
            <div className="repo-icon">
              <GitBranch size={19} />
            </div>
            <div>
              <strong>{state?.repo.name || "orbit"}</strong>
              <small>Jujutsu workspace</small>
            </div>
            <span className="tiny-badge">
              {state?.repo.demo === false ? "local" : "demo"}
            </span>
          </div>
          <div className="sidebar-section-title">WORKSPACE</div>
          <div className="nav-active">
            <Layers2 size={16} />
            Working copy<span>{files.length}</span>
          </div>
          <div className="sidebar-section-title files-label">
            CHANGED FILES <span>{files.length}</span>
          </div>
          <div className="file-search">
            <Search size={14} />
            <input
              placeholder="Filter files…"
              aria-label="Filter files"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {filter && (
              <button
                className="bare-button"
                aria-label="Clear file filter"
                onClick={() => setFilter("")}
              >
                <X size={12} />
              </button>
            )}
          </div>
          <nav className="file-nav">
            {files
              .filter((file) =>
                file.path.toLowerCase().includes(filter.toLowerCase()),
              )
              .map((file) => (
                <button
                  key={file.path}
                  onClick={() => jumpTo(file)}
                  className={`file-nav-item ${activeFile === file.path ? "active" : ""}`}
                  title={file.path}
                >
                  <FileCode2 size={15} />
                  <span>
                    <small>
                      {file.path.slice(0, file.path.lastIndexOf("/") + 1)}
                    </small>
                    {file.path.split("/").at(-1)}
                  </span>
                  <span
                    className={`file-status ${file.hunks.some((h) => selections[h.id]?.length) ? "is-selected" : ""}`}
                  >
                    {file.hunks.some((h) => selections[h.id]?.length) ? (
                      <Check size={12} />
                    ) : file.patch.includes("new file mode") ? (
                      "A"
                    ) : file.patch.includes("deleted file mode") ? (
                      "D"
                    ) : (
                      "M"
                    )}
                  </span>
                </button>
              ))}
          </nav>
          {filter &&
            !files.some((f) =>
              f.path.toLowerCase().includes(filter.toLowerCase()),
            ) && <p className="muted no-results">No matching files.</p>}
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <span className="little-spark">✧</span>
              <strong>A little less commit chaos.</strong>
              <p>
                Move the right lines into the right change. Keep your stack
                tidy.
              </p>
            </div>
            <button className="sidebar-help" onClick={() => setHelp(true)}>
              <CircleHelp size={15} />
              Quick guide
              <ChevronRight size={13} />
            </button>
            <div className="powered">
              DIFFS BY PIERRE <span>·</span> POWERED BY JJ
            </div>
          </div>
        </aside>
        <main className="main">
          <div className="review-heading">
            <div>
              <div className="eyebrow">REVIEW & REFINE</div>
              <h1>
                Working copy <span className="revision-pill">@</span>
              </h1>
              <p>Select the changes. Find their place.</p>
            </div>
            <div className="heading-actions">
              {state?.canUndo && (
                <button
                  className="button secondary"
                  onClick={() => mutate("undo")}
                  disabled={!!busy}
                >
                  <RotateCcw size={14} />
                  Undo squash
                </button>
              )}
              <button
                className="button secondary"
                onClick={() => refresh()}
                disabled={!!busy}
              >
                <RefreshCw
                  size={14}
                  className={busy === "refresh" ? "spin" : ""}
                />
                Refresh
              </button>
            </div>
          </div>
          {error && (
            <div className="alert error" role="alert">
              <ShieldCheck size={17} />
              <div>
                {error}
                <span>
                  Nothing is retried automatically. Refresh to inspect the
                  repository.
                </span>
              </div>
              <button
                className="bare-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          <div className="review-grid">
            <div className="diff-column">
              <div className="change-summary">
                <span className="change-icon">
                  <GitCommitHorizontal size={20} />
                </span>
                <div>
                  <strong>
                    {state?.source.description ||
                      (state
                        ? "(no description)"
                        : "Preparing your workspace…")}
                  </strong>
                  <div>
                    <code>
                      {state ? short(state.source.changeId) : "········"}
                    </code>
                    <span>Working-copy change</span>
                  </div>
                </div>
                <span className="uncommitted-badge">
                  {files.length
                    ? "In progress"
                    : state
                      ? "Empty"
                      : "Connecting"}
                </span>
              </div>
              <div className="diff-toolbar">
                <div className="file-totals">
                  <Files size={15} />
                  <strong>{plural(files.length, "file")}</strong>
                  <span className="added">+{additions}</span>
                  <span className="removed">−{deletions}</span>
                </div>
                <div className="diff-controls">
                  <button
                    className="text-button"
                    onClick={() =>
                      setSelections(
                        Object.fromEntries(
                          hunks.map((h) => [
                            h.id,
                            selected.length === hunks.length &&
                            selectedCount ===
                              hunks.reduce((n, h) => n + changed(h).length, 0)
                              ? []
                              : changed(h).map((r) => r.index),
                          ]),
                        ),
                      )
                    }
                    disabled={!!busy || !hunks.length}
                  >
                    {selected.length === hunks.length && selectedCount > 0
                      ? "Deselect all"
                      : "Select all"}
                  </button>
                  <div className="segmented" aria-label="Diff layout">
                    <button
                      aria-pressed={style === "unified"}
                      className={style === "unified" ? "active" : ""}
                      onClick={() => setStyle("unified")}
                      title="Unified diff"
                      aria-label="Unified diff"
                    >
                      <List size={14} />
                      <span>Unified</span>
                    </button>
                    <button
                      aria-pressed={style === "split"}
                      className={style === "split" ? "active" : ""}
                      onClick={() => setStyle("split")}
                      title="Split diff"
                      aria-label="Split diff"
                    >
                      <Columns2 size={14} />
                      <span>Split</span>
                    </button>
                  </div>
                </div>
              </div>
              {files.length > 0 && (
                <div className="selection-tip">
                  <MousePointer2 size={13} />
                  <span>
                    Check a hunk, or drag line numbers to select a range.
                  </span>
                  <kbd>Shift + click</kbd>
                  <span className="tip-end">to extend</span>
                </div>
              )}
              {!state ? (
                <div className="loading-state">
                  <LoaderCircle className="spin" size={24} />
                  <h3>Opening the demo repository</h3>
                  <p>
                    Real diffs. Real jj operations. A safe place to experiment.
                  </p>
                  {!busy && (
                    <button
                      className="button secondary"
                      onClick={() => refresh(true)}
                    >
                      Try again
                    </button>
                  )}
                </div>
              ) : !files.length ? (
                <div className="empty-state">
                  <div className="empty-icon">
                    <Check size={29} />
                  </div>
                  <h2>A tidy working copy.</h2>
                  <p>All changes have found their place in your stack.</p>
                  {state.canUndo ? (
                    <button
                      className="button secondary"
                      disabled={!!busy}
                      onClick={() => mutate("undo")}
                    >
                      <RotateCcw size={14} />
                      Undo last squash
                    </button>
                  ) : null}
                </div>
              ) : (
                files
                  .filter((file) =>
                    file.path.toLowerCase().includes(filter.toLowerCase()),
                  )
                  .map((file) => (
                    <DiffCard
                      key={file.path}
                      file={file}
                      selections={selections}
                      setSelection={setSelection}
                      style={style}
                      busy={!!busy}
                      collapsed={!!collapsed[file.path]}
                      toggleCollapse={() =>
                        setCollapsed((current) => ({
                          ...current,
                          [file.path]: !current[file.path],
                        }))
                      }
                    />
                  ))
              )}
              <div className="diff-footer">
                <ShieldCheck size={13} />
                Your working files stay the same. Only their place in history
                changes.
              </div>
            </div>
            <aside className="action-column">
              <div className="squash-panel">
                <div className="panel-title">
                  <div className="panel-icon">
                    <ArrowDownToLine size={18} />
                  </div>
                  <h2>Squash changes</h2>
                </div>
                <p className="panel-intro">
                  Move selected changes into an earlier revision in your stack.
                </p>
                <div
                  className={`selection-box ${selectedCount ? "has-selection" : ""}`}
                >
                  <div className="selection-box-top">
                    <span>YOUR SELECTION</span>
                    {selectedCount > 0 && (
                      <button
                        className="text-button"
                        onClick={() => setSelections({})}
                        disabled={!!busy}
                      >
                        Clear
                      </button>
                    )}
                  </div>
                  <strong>
                    {selectedCount
                      ? plural(selectedCount, "changed line")
                      : "No changes selected"}
                  </strong>
                  <span>
                    {selectedCount
                      ? `${plural(selected.length, "hunk")} across ${plural(selectedFiles.length, "file")}`
                      : "Choose a hunk or a few lines to start."}
                  </span>
                  {selectedFiles.length > 0 && (
                    <div className="selected-file-list">
                      {selectedFiles.map((file) => (
                        <div key={file.path}>
                          <FileCode2 size={12} />
                          <span>{file.path.split("/").at(-1)}</span>
                          <small>
                            {file.hunks.reduce(
                              (n, h) => n + (selections[h.id]?.length || 0),
                              0,
                            )}
                          </small>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flow-connector">
                  <span />
                  <ArrowDown size={15} />
                  <span />
                </div>
                <div className="destination-heading">
                  <label>SQUASH INTO</label>
                  <span>Mutable ancestors</span>
                </div>
                <div className="target-list">
                  {state?.targets.map((revision, i) => (
                    <button
                      key={revision.changeId}
                      className={`target ${target === revision.changeId ? "target-selected" : ""}`}
                      onClick={() => {
                        setTarget(revision.changeId);
                        setPreview(null);
                      }}
                      disabled={!!busy}
                    >
                      <span className="target-radio">
                        {target === revision.changeId && <span />}
                      </span>
                      <div>
                        <div className="target-id">
                          <code>{short(revision.changeId)}</code>
                          {i === 0 && <span>parent</span>}
                        </div>
                        <strong>
                          {revision.description || "(no description)"}
                        </strong>
                      </div>
                    </button>
                  ))}
                  {state && !state.targets.length && (
                    <p className="muted">
                      No mutable ancestors. Create a mutable parent before
                      squashing.
                    </p>
                  )}
                </div>
                <button
                  className="button primary preview-button"
                  disabled={!selectedCount || !target || !!busy}
                  onClick={prepare}
                >
                  {busy === "preview" ? (
                    <LoaderCircle size={15} className="spin" />
                  ) : (
                    <Layers2 size={16} />
                  )}
                  Preview squash
                  <ArrowRight size={15} />
                </button>
                <div className="safe-note">
                  <ShieldCheck size={13} />
                  Review first. Squash second.
                </div>
              </div>
              {state?.repo.demo && (
                <div className="demo-card">
                  <div>
                    <span className="demo-dot" />
                    <strong>Your sandbox, your rules.</strong>
                  </div>
                  <p>
                    This is a real jj repository, set up just for trying things
                    out.
                  </p>
                  <button
                    onClick={() => setResetConfirm(true)}
                    disabled={!!busy}
                  >
                    <RotateCcw size={13} />
                    Start a fresh demo
                    <ArrowRight size={13} />
                  </button>
                </div>
              )}
              <div className="engine-note">
                <Terminal size={13} />
                <span>
                  Runs <code>jj-hunk-tool squash</code>
                  <br />
                  No staging area. No patch guesswork.
                </span>
              </div>
            </aside>
          </div>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{notice}</span>
          <button
            className="bare-button"
            onClick={() => setNotice("")}
            aria-label="Dismiss notification"
          >
            <X size={15} />
          </button>
        </div>
      )}
      {preview && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setPreview(null)}
        >
          <section
            className="modal preview-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Preview squash"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <div className="eyebrow">ONE LAST LOOK</div>
                <h2>Give these changes a home.</h2>
                <p>
                  {plural(preview.selectedLines, "changed line")} →{" "}
                  <code>{short(target)}</code> · {destination?.description}
                </p>
              </div>
              <button
                className="icon-button"
                autoFocus
                disabled={!!busy}
                aria-label="Close preview"
                onClick={() => setPreview(null)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="preview-body">
              <div className="preview-callout">
                <ShieldCheck size={16} />
                <span>
                  Only this patch will move. Your working files and the
                  destination’s description are preserved.
                </span>
              </div>
              <PreviewDiff patch={preview.patch} />
              <details className="command-details">
                <summary>
                  <Terminal size={14} />
                  Command to run
                  <ChevronDown size={13} />
                </summary>
                <pre>{preview.command}</pre>
              </details>
            </div>
            <footer className="modal-footer">
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={() => setPreview(null)}
              >
                Keep reviewing
              </button>
              <button
                className="button primary"
                disabled={!!busy}
                onClick={squash}
              >
                {busy === "squash" ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <ArrowDownToLine size={15} />
                )}
                Squash {plural(preview.selectedLines, "line")}
              </button>
            </footer>
          </section>
        </div>
      )}
      {help && (
        <div className="modal-backdrop" onClick={() => setHelp(false)}>
          <section
            className="modal help-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Quick guide"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <div className="eyebrow">MEET FOLD</div>
                <h2>Small selections. Clean history.</h2>
              </div>
              <button
                className="icon-button"
                autoFocus
                aria-label="Close guide"
                onClick={() => setHelp(false)}
              >
                <X size={20} />
              </button>
            </header>
            <div className="help-body">
              <div>
                <span>1</span>
                <section>
                  <h3>Choose what belongs together</h3>
                  <p>
                    Check a hunk to select all its changes. For finer control,
                    click or drag the line numbers. Shift-click extends a
                    selection. Each new range replaces the selection within that
                    hunk; other hunks stay selected.
                  </p>
                </section>
              </div>
              <div>
                <span>2</span>
                <section>
                  <h3>Pick a home in your stack</h3>
                  <p>
                    Choose a mutable ancestor. Preview the exact patch and the
                    jj-hunk-tool command before changing history.
                  </p>
                </section>
              </div>
              <div>
                <span>3</span>
                <section>
                  <h3>Squash, then keep reviewing</h3>
                  <p>
                    Selected lines move into the destination. Unselected lines
                    stay in @. Undo squash reverses the last app operation if
                    the repository has not changed.
                  </p>
                </section>
              </div>
              <p className="help-footnote">
                In split view, a range selects the changed lines in both aligned
                columns. Use unified view for individual additions or deletions.
                Context is never moved.
              </p>
            </div>
            <footer className="modal-footer">
              <button className="button primary" onClick={() => setHelp(false)}>
                Let’s review
                <ArrowRight size={14} />
              </button>
            </footer>
          </section>
        </div>
      )}
      {resetConfirm && (
        <div
          className="modal-backdrop"
          onClick={() => !busy && setResetConfirm(false)}
        >
          <section
            className="modal reset-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Start a fresh demo"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="modal-header">
              <div>
                <h2>Start with a fresh stack?</h2>
                <p>
                  We’ll create a new demo repository. Your current demo is kept
                  on disk, so nothing is deleted.
                </p>
              </div>
            </header>
            <footer className="modal-footer">
              <button
                className="button secondary"
                autoFocus
                disabled={!!busy}
                onClick={() => setResetConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="button primary"
                disabled={!!busy}
                onClick={() => mutate("reset")}
              >
                {busy === "reset" && (
                  <LoaderCircle size={14} className="spin" />
                )}
                Create fresh demo
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
