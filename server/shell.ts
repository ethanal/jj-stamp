import os from "node:os";

/** One literal executable, never shell text, expansion or split arguments.
 * Shared by the PTY and read-only default-shell metadata; do not hide an
 * invalid configured executable or SHELL behind a different fallback. */
export function shellExecutable(configured: string): string {
  let shell = configured || process.env.SHELL;
  if (!shell) {
    try {
      shell = os.userInfo().shell || undefined;
    } catch {
      // A system without a passwd entry can still provide /bin/sh.
    }
  }
  shell ||= "/bin/sh";
  if (shell.length > 4096 || /[\0\r\n]/.test(shell))
    throw new Error("Invalid shell executable.");
  return shell;
}
