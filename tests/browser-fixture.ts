import { chromium, type BrowserContextOptions } from "@playwright/test";
import express from "express";
import { createServer } from "node:http";
import { createServer as createVite } from "vite";

interface BrowserFixtureOptions {
  app?: express.Express;
  entry?: string;
  viewport?: BrowserContextOptions["viewport"];
  captureConsoleErrors?: boolean;
}

/** Isolated loopback server and browser, disposed even when setup or assertions fail. */
export async function createBrowserFixture({
  app = express(),
  entry,
  viewport = { width: 1440, height: 900 },
  captureConsoleErrors = false,
}: BrowserFixtureOptions = {}) {
  await using setup = new AsyncDisposableStack();
  const vite = await createVite({
    // Tests do not need HMR; in particular, never compete for its shared port.
    server: { middlewareMode: true, hmr: false },
    appType: entry ? "custom" : "spa",
  });
  setup.defer(() => vite.close());
  if (entry) {
    app.get("/", async (_request, response) =>
      response.send(
        await vite.transformIndexHtml(
          "/",
          `<html><head></head><body style="margin:0"><div id="root"></div><script type="module" src="${entry}"></script></body></html>`,
        ),
      ),
    );
  }
  app.use(vite.middlewares);
  const server = createServer(app);
  setup.defer(async () => {
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
  return {
    browser,
    page,
    errors,
    url: `http://127.0.0.1:${address.port}`,
    close: () => resources.disposeAsync(),
  };
}
