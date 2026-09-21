import { execFileSync } from "node:child_process";
import { chmod, readFile, rm } from "node:fs/promises";
import { build } from "esbuild";

const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
execFileSync("tsc", ["--noEmit"], { stdio: "inherit" });
// Only generated assets live here; never package leftovers from an older layout.
await rm(new URL("../dist/", import.meta.url), {
  recursive: true,
  force: true,
});
execFileSync("vite", ["build"], { stdio: "inherit" });
await build({
  entryPoints: ["cli.ts"],
  outfile: "dist/cli.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  banner: { js: "#!/usr/bin/env node" },
  define: { __JJ_STAMP_VERSION__: JSON.stringify(version) },
});
await chmod("dist/cli.cjs", 0o755);
