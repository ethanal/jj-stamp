{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  python3,
  jujutsu,
  xdg-utils,
}:

buildNpmPackage {
  pname = "jj-stamp";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;

  # Do not copy working repositories, node_modules, or previously built assets
  # into the store. Both server and browser assets are built from source.
  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        name = baseNameOf path;
      in
      !(builtins.elem name [
        "node_modules"
        "dist"
        ".data"
        ".git"
        ".jj"
        "result"
      ])
      && lib.cleanSourceFilter path type;
  };
  npmDepsHash = "sha256-2FOcQtzWgaEfml5iM19lVszCtEjD9SuNZ/5fLOmXyhg=";

  nativeBuildInputs = [
    makeWrapper
    python3
  ];
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
  # Compile node-pty against the packaged Node and target SDK instead of using
  # upstream Darwin prebuilds (Linux is already source-only).
  env.npm_config_build_from_source = "true";

  # Recent npm versions require an explicit install-script policy. Keep this
  # build-local rather than changing the user's/project's npm configuration.
  postPatch = ''
    echo 'allow-scripts=node-pty,esbuild' >> .npmrc
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/jj-stamp" "$out/bin"
    cp dist/cli.cjs dist/diff-editor.cjs "$out/lib/jj-stamp/"
    cp -R dist/client "$out/lib/jj-stamp/client"
    cp -R dist/node_modules "$out/lib/jj-stamp/node_modules"
    cp -R dist/licenses "$out/lib/jj-stamp/licenses"
    # Prefer the packaged, tested tools over any user-installed versions on PATH.
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/jj-stamp" \
      --add-flags "$out/lib/jj-stamp/cli.cjs" \
      --set JJ_STAMP_JJ ${lib.getExe jujutsu} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            jujutsu
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [ xdg-utils ]
        )
      }
    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    "$out/bin/jj-stamp" --help
    test -s "$out/lib/jj-stamp/client/index.html"
    # Exercise the installed addon and Darwin spawn-helper, not checkout modules.
    ${lib.getExe nodejs_24} - "$out/lib/jj-stamp/node_modules/node-pty" \
      "${stdenv.shell}" <<'JS'
    const assert = require("node:assert/strict");
    const pty = require(process.argv[2]);
    const terminal = pty.spawn(process.argv[3], ["-c", "printf terminal-smoke"], {
      cols: 80, rows: 24, env: process.env,
    });
    let output = "";
    const timeout = setTimeout(() => {
      terminal.kill();
      throw new Error("Installed terminal smoke timed out: " + output);
    }, 10000);
    terminal.onData(data => { output += data; });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      assert.equal(exitCode, 0);
      assert.ok(output.includes("terminal-smoke"), output);
    });
    terminal.resize(100, 30);
    JS
    runHook postInstallCheck
  '';

  meta = {
    description = "Local browser UI for reviewing and editing Jujutsu changes";
    license = lib.licenses.asl20;
    mainProgram = "jj-stamp";
    platforms = lib.platforms.unix;
  };
}
