/** Safe, actionable watcher diagnostics for SSE; raw errors stay in the terminal. */
export interface WatchFailure {
  code: string;
  message: string;
}

export class WatchError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WatchError";
  }
}

const systemErrors: Record<string, string> = {
  ENOSPC:
    "The OS cannot allocate more filesystem watches (ENOSPC). Check the system's watch/resource limits.",
  EMFILE:
    "The process has exhausted its open-file or filesystem-watch limit (EMFILE).",
  ENFILE: "The system has exhausted its open-file limit (ENFILE).",
  EACCES:
    "Permission denied reading or watching the workspace or repository metadata (EACCES).",
  EPERM:
    "The OS denied permission to watch the workspace or repository metadata (EPERM).",
  ENOENT:
    "A workspace directory or repository metadata entry needed by the watcher is missing (ENOENT).",
  ENOTDIR:
    "A workspace or repository metadata entry expected to be a directory is not one (ENOTDIR).",
  ELOOP:
    "A symbolic link prevented safe access to repository metadata (ELOOP).",
  ENOSYS:
    "Filesystem watching is not supported by this operating system (ENOSYS).",
  ENOTSUP: "Filesystem watching is not supported on this filesystem (ENOTSUP).",
  ERR_FEATURE_UNAVAILABLE_ON_PLATFORM:
    "Filesystem watching is unavailable on this platform.",
};

export function watchFailure(error: unknown): WatchFailure {
  if (error instanceof WatchError)
    return { code: error.code, message: error.message };
  const code =
    error && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  if (typeof code === "string" && Object.hasOwn(systemErrors, code))
    return { code, message: systemErrors[code] };
  return {
    code: "WATCH_UNAVAILABLE",
    message:
      "Filesystem watching failed. See the jj-stamp terminal for the underlying error. Focus/manual refresh is still available.",
  };
}
