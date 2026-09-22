import { spawn } from "node:child_process";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  /** Original stdout bytes, used when constructing exact file snapshots. */
  stdoutBytes?: Buffer;
}
export class ProcessError extends Error {
  constructor(
    public command: string,
    public args: string[],
    public result: ProcessResult,
    public exitCode: number | null,
    public cwd?: string,
  ) {
    super(
      `${command} failed: ${result.stderr.trim() || result.stdout.trim() || `exit ${exitCode}`}`,
    );
  }
}

/** POSIX-shell quoting for copyable diagnostics only; execution never uses a shell. */
export function formatCommand(command: string, args: string[]): string {
  return [command, ...args]
    .map((arg) =>
      /^[a-zA-Z0-9_@%+=:,./-]+$/.test(arg)
        ? arg
        : `'${arg.replaceAll("'", "'\\''")}'`,
    )
    .join(" ");
}

export function processFailureOutput(
  error: ProcessError,
  cwd = error.cwd,
): string {
  return (
    (cwd ? `Working directory: ${cwd}\n` : "") +
    `Failed command:\n${formatCommand(error.command, error.args)}\n\n` +
    processOutput(error.result)
  );
}

export function processOutput(result: ProcessResult): string {
  return result.stdout + result.stderr;
}

/** No shell, no automatic retries, and no timer that can kill a history rewrite. */
export function run(
  command: string,
  args: string[],
  cwd: string,
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: "1",
      CLICOLOR: "0",
      JJ_PAGER: "cat",
      PAGER: "cat",
      JJ_EDITOR: "true",
      EDITOR: "true",
    };
    // Nix pins jj's absolute executable for both execution and diagnostics.
    const executable = command === "jj" ? env.JJ_STAMP_JJ || command : command;
    const child = spawn(executable, args, {
      cwd,
      // Terminal signals target the CLI's foreground process group. Isolate
      // history-writing tools so graceful shutdown can await their completion.
      // Keep pipes referenced (no unref): run() still waits for every child.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const stdoutBytes = Buffer.concat(stdoutChunks);
      const result = {
        stdout: stdoutBytes.toString("utf8"),
        stderr,
        stdoutBytes,
      };
      if (code === 0) resolve(result);
      else reject(new ProcessError(executable, args, result, code, cwd));
    });
  });
}
export const jj = (cwd: string, args: string[]) =>
  run("jj", ["--no-pager", "--color=never", ...args], cwd);
