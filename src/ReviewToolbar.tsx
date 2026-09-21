import type { Revision } from "./types";
import {
  colorSchemes,
  parseColorScheme,
  type ColorScheme,
} from "./preferences";

type RevisionMetadata = Revision & { author?: string; changeIdPrefix?: string };
export function revisionPageTitle(
  source: Revision | undefined,
  repoPath: string | undefined,
): string {
  return source && repoPath
    ? `${source.changeId}: ${source.description} (${repoPath})`
    : "jj-stamp";
}
export function ChangeId({ revision }: { revision?: RevisionMetadata }) {
  if (!revision) return <>—</>;
  const { changeId, changeIdPrefix } = revision;
  const prefix =
    changeIdPrefix && changeId.startsWith(changeIdPrefix)
      ? changeIdPrefix
      : changeId.slice(0, 8);
  const displayed = changeId.slice(0, Math.max(8, prefix.length));
  return <>{displayed}</>;
}
export function RevisionHeading({ source }: { source?: RevisionMetadata }) {
  return (
    <div className="revision-info" aria-label="Reviewed revision">
      <code
        className="change-id"
        aria-label="Current change ID"
        title={source?.changeId}
      >
        <ChangeId revision={source} />
      </code>
      <span
        className="revision-author"
        title={source?.author}
        aria-label="Revision author"
      >
        {source ? source.author || "Unknown author" : "—"}
      </span>
      <span className="source-description" title={source?.description}>
        {source?.description ||
          (source ? "(no description)" : "Opening repository…")}
      </span>
      <code
        className="commit-id"
        aria-label="Current commit ID"
        title={source?.commitId}
      >
        {source?.commitId.slice(0, 12) ?? "—"}
      </code>
    </div>
  );
}
export function ColorSchemePicker({
  value,
  onChange,
  disabled,
}: {
  value: ColorScheme;
  onChange: (scheme: ColorScheme) => void;
  disabled: boolean;
}) {
  return (
    <label className="color-scheme-picker">
      <span className="sr-only">Color scheme</span>
      <select
        aria-label="Color scheme"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(parseColorScheme(event.target.value))}
      >
        {Object.entries(colorSchemes).map(([scheme, { label }]) => (
          <option key={scheme} value={scheme}>
            {label}
          </option>
        ))}
      </select>
    </label>
  );
}
