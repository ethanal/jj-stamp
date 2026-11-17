import { execFileSync } from "node:child_process";
import { access, chmod, cp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
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
  // Its dynamic native-module lookup and macOS helper need their package layout.
  external: ["node-pty"],
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __JJ_STAMP_VERSION__: JSON.stringify(version),
    __JJ_STAMP_BUNDLED__: "true",
  },
});
await chmod("dist/cli.cjs", 0o755);
await build({
  entryPoints: ["server/diff-editor-cli.ts"],
  outfile: "dist/diff-editor.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  define: { __JJ_STAMP_BUNDLED__: "true" },
});
await build({
  entryPoints: ["server/diff-reader-cli.ts"],
  outfile: "dist/diff-reader.cjs",
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  define: { __JJ_STAMP_BUNDLED__: "true" },
});

const require = createRequire(import.meta.url);
await mkdir("dist/licenses", { recursive: true });
for (const [name, root] of [
  ["ghostty-web", path.dirname(path.dirname(require.resolve("ghostty-web")))],
  ["ws", path.dirname(require.resolve("ws/package.json"))],
]) {
  await cp(
    path.join(root, "LICENSE"),
    path.join("dist/licenses", `${name}.txt`),
  );
}
const ptyRoot = path.dirname(require.resolve("node-pty/package.json"));
const ptyOutput = "dist/node_modules/node-pty";
await mkdir(ptyOutput, { recursive: true });
for (const file of ["package.json", "LICENSE"]) {
  await cp(path.join(ptyRoot, file), path.join(ptyOutput, file));
}
await cp(path.join(ptyRoot, "lib"), path.join(ptyOutput, "lib"), {
  recursive: true,
  filter: (source) => !source.endsWith(".map") && !source.endsWith(".test.js"),
});
// Match node-pty's lookup order; do not ship other architectures, source files,
// debug symbols or node-addon-api (which is needed only while compiling).
const nativeDirectories = [
  "build/Release",
  "build/Debug",
  `prebuilds/${process.platform}-${process.arch}`,
];
let nativeDirectory;
for (const directory of nativeDirectories) {
  try {
    await access(path.join(ptyRoot, directory, "pty.node"));
    nativeDirectory = directory;
    break;
  } catch {
    // Try the next native build location.
  }
}
if (!nativeDirectory) {
  throw new Error(
    "node-pty has no native build for this platform; run npm install",
  );
}
await cp(
  path.join(ptyRoot, nativeDirectory),
  path.join(ptyOutput, nativeDirectory),
  {
    recursive: true,
    filter: (source) =>
      !path.extname(source) ||
      [".node", ".dll", ".exe"].includes(path.extname(source)),
  },
);
if (process.platform === "darwin") {
  await access(path.join(ptyOutput, nativeDirectory, "spawn-helper"));
}
