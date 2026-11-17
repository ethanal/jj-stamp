import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WebSocket } from "ws";
import { jj } from "../server/process.ts";

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const checkout = fileURLToPath(new URL("../", import.meta.url));

async function until(check: () => boolean, diagnostics: () => string) {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    assert.ok(Date.now() < deadline, diagnostics());
    await delay(20);
  }
}

test(
  "npm tarball omits staged native runtime and uses the target dependency",
  {
    timeout: 90_000,
  },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "jj-stamp-packaging-"));
    let stop: (() => Promise<void>) | undefined;
    t.after(async () => {
      await stop?.();
      await rm(root, { recursive: true, force: true });
    });
    const options = {
      cwd: checkout,
      encoding: "utf8" as const,
      timeout: 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, NODE_PATH: "" },
    };

    // Guard against a vacuous pass: standalone builds really do stage this
    // package, but an npm installation must not ship/shadow it.
    await access(
      path.join(checkout, "dist/node_modules/node-pty/package.json"),
    );
    const npmArguments = [
      "pack",
      "--offline",
      "--ignore-scripts",
      "--json",
      "--cache",
      path.join(root, "npm-cache"),
      "--pack-destination",
      root,
    ];
    const npm = process.env.npm_execpath;
    const packed = npm
      ? await execute(process.execPath, [npm, ...npmArguments], options)
      : await execute("npm", npmArguments, options);
    const [{ filename }] = JSON.parse(packed.stdout) as { filename: string }[];
    const archive = path.join(root, filename);
    // Inspect the actual archive, not just package.json or npm's proposed list.
    const listing = await execute("tar", ["-tzf", archive], options);
    const files = listing.stdout.trim().split("\n");
    assert.ok(
      !files.some((file) => file.includes("/node_modules/")),
      JSON.stringify(files),
    );
    assert.ok(
      !files.some((file) => file.endsWith(".node")),
      JSON.stringify(files),
    );
    for (const file of [
      "package/package.json",
      "package/LICENSE",
      "package/README.md",
      "package/dist/cli.cjs",
      "package/dist/diff-editor.cjs",
      "package/dist/diff-reader.cjs",
      "package/dist/client/index.html",
      "package/dist/licenses/ghostty-web.txt",
      "package/dist/licenses/ws.txt",
    ]) {
      assert.ok(files.includes(file), `Missing packed file: ${file}`);
    }
    assert.ok(
      files.some((file) =>
        /^package\/dist\/client\/assets\/ghostty-vt-[^/]+\.wasm$/.test(file),
      ),
    );
    assert.ok(
      files.some((file) =>
        /^package\/dist\/client\/assets\/terminal-runtime-[^/]+\.js$/.test(
          file,
        ),
      ),
    );

    const installation = path.join(root, "installation");
    const packageRoot = path.join(installation, "node_modules/jj-stamp");
    await mkdir(packageRoot, { recursive: true });
    await execute(
      "tar",
      ["-xzf", archive, "-C", packageRoot, "--strip-components=1"],
      options,
    );
    const metadata = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    assert.equal(metadata.dependencies["node-pty"], "1.1.0");
    await assert.rejects(access(path.join(packageRoot, "dist/node_modules")));

    // Offline target-installation fixture: expose the host's installed node-pty
    // through the dependency location an npm install would create. The marker
    // proves the bundled CLI actually loads that location, not staged files.
    // This tests real native loading on this host, not cross-OS execution.
    const targetDependency = path.join(installation, "node_modules/node-pty");
    const targetEntry = path.join(targetDependency, "index.cjs");
    const loaded = path.join(root, "target-dependency-loaded");
    const nativeMetadata = require("node-pty/package.json") as {
      version: string;
    };
    assert.equal(nativeMetadata.version, "1.1.0");
    await mkdir(targetDependency);
    await writeFile(
      path.join(targetDependency, "package.json"),
      JSON.stringify({
        name: "node-pty",
        version: nativeMetadata.version,
        main: "index.cjs",
      }),
    );
    await writeFile(
      targetEntry,
      `
    require("node:fs").writeFileSync(${JSON.stringify(loaded)}, __filename);
    module.exports = require(${JSON.stringify(require.resolve("node-pty"))});
  `,
    );
    const executable = path.join(packageRoot, "dist/cli.cjs");
    const installedOptions = { ...options, cwd: installation };
    const help = await execute(
      process.execPath,
      [executable, "--help"],
      installedOptions,
    );
    assert.match(help.stdout, /Usage: jj-stamp/);
    assert.equal(await readFile(loaded, "utf8"), targetEntry);
    // Exercise the packed server's real terminal path, including its pinned
    // node-pty version/private-writer guard, not just the native module loader.
    const repo = path.join(root, "repo");
    await mkdir(repo);
    await jj(repo, ["git", "init"]);
    const configHome = path.join(root, "config");
    await mkdir(path.join(configHome, "jj-stamp"), { recursive: true });
    await writeFile(
      path.join(configHome, "jj-stamp/config.json"),
      JSON.stringify({ shell: process.execPath }),
    );
    // Node's REPL is an executable terminal fixture without a system-shell
    // dependency. Nothing is installed from the network or published.
    const server = spawn(
      process.execPath,
      [executable, "--repository", repo, "--no-open", "--port", "0"],
      {
        cwd: installation,
        env: { ...options.env, XDG_CONFIG_HOME: configHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let diagnostics = "";
    let ended = false;
    let socket: WebSocket | undefined;
    const closed = new Promise<number | null>((resolve) => {
      server.once("close", (code) => {
        ended = true;
        resolve(code);
      });
    });
    const watchdog = setTimeout(() => server.kill("SIGKILL"), 30_000);
    stop = async () => {
      socket?.terminate();
      if (!ended) server.kill("SIGTERM");
      const force = setTimeout(() => server.kill("SIGKILL"), 10_000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
        clearTimeout(watchdog);
      }
    };
    server.on("error", (error) => {
      diagnostics += error.message;
    });
    server.stdout.on("data", (data) => {
      diagnostics += data;
    });
    server.stderr.on("data", (data) => {
      diagnostics += data;
    });
    await until(
      () => {
        assert.ok(!ended, diagnostics);
        return /http:\/\/127\.0\.0\.1:\d+\//.test(diagnostics);
      },
      () => diagnostics,
    );
    const url = diagnostics.match(/http:\/\/127\.0\.0\.1:\d+\//)![0];
    socket = new WebSocket(
      `${url.replace("http:", "ws:")}api/terminal?cols=80&rows=24`,
      { origin: new URL(url).origin },
    );
    const frames: { type: string; data?: string; message?: string }[] = [];
    let output = "";
    let transportError: Error | undefined;
    socket.on("error", (error) => {
      transportError = error;
    });
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as (typeof frames)[number];
      frames.push(frame);
      if (frame.type === "data") output += frame.data;
    });
    const terminalDiagnostics = () =>
      JSON.stringify({ frames, output, diagnostics });
    const healthy = () => {
      assert.ifError(transportError);
      assert.ok(
        !frames.some((frame) => frame.type === "error"),
        terminalDiagnostics(),
      );
    };
    await until(() => {
      healthy();
      return frames.some((frame) => frame.type === "ready");
    }, terminalDiagnostics);
    socket.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    socket.send(
      JSON.stringify({
        type: "input",
        data: "process.stdout.write('package-' + 'terminal-smoke\\n')\r",
      }),
    );
    await until(() => {
      healthy();
      return output.includes("package-terminal-smoke");
    }, terminalDiagnostics);
    socket.send(JSON.stringify({ type: "input", data: "process.exit(0)\r" }));
    await until(
      () => frames.some((frame) => frame.type === "exit"),
      terminalDiagnostics,
    );
    assert.equal(await readFile(loaded, "utf8"), targetEntry);
    await stop();
    assert.equal(await closed, 0, diagnostics);
  },
);
