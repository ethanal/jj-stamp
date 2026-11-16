import { chromium, type BrowserContextOptions } from "@playwright/test";
import express from "express";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer as createVite } from "vite";
import { createConfigApi } from "../server/config.ts";
import {
  configPatchSchema,
  configSchema,
  defaultConfig,
  type Config,
} from "../src/config.ts";

/** Mount before repository/static routes, so tests never use the user's config. */
export async function createConfigFixture(
  app: express.Express,
  seed?: Partial<Config>,
  sharedConfigPath?: string,
) {
  const directory = sharedConfigPath
    ? undefined
    : await mkdtemp(path.join(tmpdir(), "jj-stamp-config-browser-"));
  const configPath = sharedConfigPath ?? path.join(directory!, "config.json");
  try {
    if (directory || seed !== undefined)
      await writeFile(
        configPath,
        JSON.stringify(configPatchSchema.parse(seed ?? {})),
      );
    const router = createConfigApi({ configPath });
    app.use("/api/config", router);
    let closing: Promise<void> | undefined;
    return {
      configPath,
      readConfig: async () => {
        const text = await readFile(configPath, "utf8").catch(
          (error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
            throw error;
          },
        );
        return configSchema.parse({
          ...defaultConfig,
          ...JSON.parse(text),
        });
      },
      close: () =>
        (closing ??= (async () => {
          router.close();
          await router.drain();
          if (directory) await rm(directory, { recursive: true, force: true });
        })()),
    };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

interface BrowserFixtureOptions {
  app?: express.Express;
  config?: Partial<Config>;
  configPath?: string;
  entry?: string;
  viewport?: BrowserContextOptions["viewport"];
  captureConsoleErrors?: boolean;
}

/** Isolated loopback server and browser, disposed even when setup or assertions fail. */
export async function createBrowserFixture({
  app = express(),
  config,
  configPath,
  entry,
  viewport = { width: 1440, height: 900 },
  captureConsoleErrors = false,
}: BrowserFixtureOptions = {}) {
  await using setup = new AsyncDisposableStack();
  // Repository API routers may have their own config middleware. Put the
  // isolated real config router first rather than touching the ambient file.
  const host = express();
  const configFixture = await createConfigFixture(host, config, configPath);
  setup.defer(() => configFixture.close());
  host.use(app);
  const server = createServer(host);
  // Concurrent fixtures must not invalidate each other's optimized modules and
  // force a reload in the middle of a keyboard/focus assertion.
  const cacheRoot = await mkdtemp(
    path.join(tmpdir(), "jj-stamp-vite-browser-"),
  );
  setup.defer(() => rm(cacheRoot, { recursive: true, force: true }));
  const vite = await createVite({
    // Keep the optimized modules under node_modules so React's source transform
    // does not instrument the prebundled runtime as if it were application code.
    cacheDir: path.join(cacheRoot, "node_modules", ".vite"),
    // Scope inference loads its parser lazily in a worker. Discover it before
    // interactions, not halfway through a drag when optimizer reloads lose state.
    optimizeDeps: { include: ["web-tree-sitter"] },
    // Vite's client connects even with hmr:false. Share this fixture's ephemeral
    // HTTP server instead of competing for port 24678 (or another server's token).
    // No file watching/reloads are needed while a test runs.
    server: { middlewareMode: true, hmr: { server }, watch: null },
    appType: entry ? "custom" : "spa",
  });
  setup.defer(() => vite.close());
  if (entry) {
    host.get("/", async (_request, response) =>
      response.send(
        await vite.transformIndexHtml(
          "/",
          `<html><head></head><body style="margin:0"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
        ),
      ),
    );
  }
  host.use(vite.middlewares);
  setup.defer(async () => {
    await configFixture.close();
    if (server.listening)
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  setup.defer(() => browser.close());
  const page = await browser.newPage({ viewport });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  if (captureConsoleErrors)
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
  const resources = setup.move();
  const url = `http://127.0.0.1:${address.port}`;
  return {
    browser,
    page,
    errors,
    url,
    configPath: configFixture.configPath,
    readConfig: configFixture.readConfig,
    updateConfig: async (patch: Partial<Config>) => {
      const response = await fetch(`${url}/api/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Fold-Request": "1" },
        body: JSON.stringify(configPatchSchema.parse(patch)),
      });
      if (!response.ok)
        throw new Error(`Config update failed (${response.status})`);
      return configSchema.parse(await response.json());
    },
    close: () => resources.disposeAsync(),
  };
}
