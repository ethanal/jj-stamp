import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { ReviewService } from "./server/service.ts";
import { DEFAULT_PORT, startLocalServer } from "./server/http.ts";
import { run } from "./server/process.ts";

declare const __JJ_STAMP_VERSION__: string;

const usage = `Usage: jj-stamp [options] [change-id]

Review a Jujutsu change in a local browser. Defaults to @ at startup.
The selected change is followed through rewrites; moving @ does not retarget it.
Selected lines are squashed into that change's immediate mutable parent.

Options:
  -R, --repository PATH  Workspace to review (default: current directory)
      --port PORT        Loopback port (default: ${DEFAULT_PORT}, free port if occupied)
                         Use 0 to always choose an available port
      --no-open          Print the URL without launching a browser
      --trace            Write backend timing JSON to stderr (no arguments/output)
  -h, --help             Show this help
  -V, --version          Show version

Examples:
  jj-stamp rlvk
  jj-stamp @-
  jj-stamp --no-open --port 8080

Keep the terminal open. Ctrl-C drains accepted operations and stops the server.
`;

function openBrowser(url: string) {
  const command = process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const child = spawn(command, [url], { stdio: "ignore", detached: true });
  child.once("error", () => {
    console.error(
      `Could not open a browser. Open ${url} manually (or use --no-open).`,
    );
  });
  child.once("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(
        `Browser opener exited with status ${code}. Open ${url} manually.`,
      );
    }
  });
  child.unref();
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "V" },
      repository: { type: "string", short: "R" },
      port: { type: "string" },
      "no-open": { type: "boolean", default: false },
      trace: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (values.version) {
    console.log(`jj-stamp ${__JJ_STAMP_VERSION__}`);
    return;
  }
  if (positionals.length > 1 || positionals[0] === "") {
    throw new Error(
      "Supply one change ID or revision expression. See jj-stamp --help.",
    );
  }
  if (
    values.port !== undefined &&
    (!/^\d+$/.test(values.port) || Number(values.port) > 65535)
  ) {
    throw new Error("--port must be an integer between 0 and 65535.");
  }
  const repoPath = path.resolve(values.repository ?? process.cwd());
  const assetsDir = path.join(__dirname, "client");
  await access(path.join(assetsDir, "index.html"));
  await access(repoPath);
  for (const command of ["jj"]) {
    try {
      await run(command, ["--version"], repoPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(
          `${command} is required on PATH. The Nix package includes it.`,
        );
      }
      throw error;
    }
  }
  const service = new ReviewService({
    repoPath,
    revision: positionals[0] ?? "@",
    onTiming: values.trace
      ? (record) => {
          console.error(`[jj-stamp timing] ${JSON.stringify(record)}`);
        }
      : undefined,
  });
  // Resolve and validate before advertising a URL or opening an empty browser.
  const state = await service.getState();
  const local = await startLocalServer({
    service,
    assetsDir,
    port: values.port === undefined ? undefined : Number(values.port),
  });
  console.log(
    `Reviewing ${state.source.changeId.slice(0, 12)}: ${state.source.description}`,
  );
  console.log(`Repository: ${state.repo.path}`);
  console.log(`jj-stamp listening on ${local.url}`);
  console.log(
    "Ctrl-C to stop. Do not run concurrent history operations in this repository.",
  );
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log("Stopping jj-stamp; waiting for accepted operations…");
    void local
      .close()
      .then(() => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      })
      .catch((error: unknown) => {
        console.error(
          `Shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        process.exitCode = 1;
      });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (!values["no-open"]) openBrowser(local.url);
}

void main().catch((error: unknown) => {
  const message =
    (error as NodeJS.ErrnoException).code === "EADDRINUSE"
      ? "That port is already in use. Omit --port to choose an available port."
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(`jj-stamp: ${message}`);
  process.exitCode = 1;
});
