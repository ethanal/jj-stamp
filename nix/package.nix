{
  lib,
  stdenv,
  buildNpmPackage,
  nodejs_24,
  makeWrapper,
  jujutsu,
  jj-hunk-tool,
  patch,
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
  npmDepsHash = "sha256-a4V1ANOPUJ4nujxsJCGMt+Cel04OqkbG8Ry+GKO+ty0=";

  nativeBuildInputs = [ makeWrapper ];
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/lib/jj-stamp" "$out/bin"
    cp dist/cli.cjs "$out/lib/jj-stamp/cli.cjs"
    cp -R dist/client "$out/lib/jj-stamp/client"
    # Prefer the packaged, tested tools over any user-installed versions on PATH.
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/jj-stamp" \
      --add-flags "$out/lib/jj-stamp/cli.cjs" \
      --set JJ_STAMP_HUNK_TOOL ${lib.getExe jj-hunk-tool} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            jujutsu
            jj-hunk-tool
            patch
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
    runHook postInstallCheck
  '';

  meta = {
    description = "Local browser UI for reviewing and editing Jujutsu changes";
    license = lib.licenses.asl20;
    mainProgram = "jj-stamp";
    platforms = lib.platforms.unix;
  };
}
