{
  lib,
  rustPlatform,
  fetchFromGitHub,
  makeWrapper,
  jujutsu,
  patch,
}:

rustPlatform.buildRustPackage {
  pname = "jj-hunk-tool";
  version = "0.1.0-unstable-2026-09-18";

  # Tested protocol revision; keep the non-Nix install command in README.md in sync.
  # Upstream's --version is only 0.1.0, not a unique revision identifier.
  src = fetchFromGitHub {
    owner = "mvzink";
    repo = "jj-hunk-tool";
    rev = "817a3d19cab8ed9bf04ebf64f2f3073fe195d641";
    hash = "sha256-HtuR2IL/WIq6+y8saHFAyquQ8cFGvvz0t3VqZXBQ7gI=";
  };
  cargoHash = "sha256-ncpm8g5In2Ih5cx3AnG2vPfGFy5oMnR012hBKqV4fYw=";

  nativeBuildInputs = [ makeWrapper ];
  nativeCheckInputs = [ jujutsu patch ];
  # Preview only invokes jj; actual mutations also invoke GNU patch through jj's
  # external diff tool protocol. Supply both even when installed standalone.
  postFixup = ''
    wrapProgram "$out/bin/jj-hunk-tool" \
      --prefix PATH : ${lib.makeBinPath [ jujutsu patch ]}
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/installed-check-home"
    export JJ_CONFIG=""
    export JJ_USER="Nix check"
    export JJ_EMAIL="nix-check@example.invalid"
    mkdir -p "$HOME" "$TMPDIR/installed-check-repo"
    pushd "$TMPDIR/installed-check-repo"
    ${lib.getExe jujutsu} git init
    printf 'before\n' > example.txt
    ${lib.getExe jujutsu} describe -m parent
    ${lib.getExe jujutsu} new -m source
    printf 'after\n' > example.txt
    hunks=$(PATH= "$out/bin/jj-hunk-tool" hunks)
    [[ "$hunks" =~ ^([a-f0-9]{7})[[:space:]] ]]
    hunk="''${BASH_REMATCH[1]}"
    PATH= "$out/bin/jj-hunk-tool" squash "$hunk" \
      --use-destination-message --keep-emptied
    test "$(${lib.getExe jujutsu} file show -r @- example.txt)" = after
    test -z "$(${lib.getExe jujutsu} diff --git)"
    test "$(${lib.getExe jujutsu} log --no-graph -r @- -T description)" = parent
    popd
    runHook postInstallCheck
  '';

  preCheck = ''
    export HOME="$TMPDIR/home"
    mkdir -p "$HOME"
    export JJ_USER="Nix build"
    export JJ_EMAIL="nix-build@example.invalid"
  '';

  meta = {
    description = "Non-interactive hunk-level operations for Jujutsu";
    homepage = "https://github.com/mvzink/jj-hunk-tool";
    license = lib.licenses.mit;
    mainProgram = "jj-hunk-tool";
    platforms = lib.platforms.unix;
  };
}
