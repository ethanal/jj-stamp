{
  description = "jj-stamp: a local change-review UI for Jujutsu";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
  # 26.05 is the last nixpkgs release supporting Intel macOS.
  inputs.nixpkgs-intel-darwin.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-intel-darwin,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor =
        system:
        import (if system == "x86_64-darwin" then nixpkgs-intel-darwin else nixpkgs) { inherit system; };
      packagesFor =
        system:
        let
          pkgs = pkgsFor system;
          jj-stamp = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit jj-stamp;
          default = jj-stamp;
        };
    in
    {
      packages = forAllSystems packagesFor;

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.jj-stamp}/bin/jj-stamp";
          meta.description = "Review a Jujutsu change in your browser";
        };
      });

      checks = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          inherit (self.packages.${system}) jj-stamp;
          installed-cli =
            pkgs.runCommand "jj-stamp-installed-cli-check"
              {
                nativeBuildInputs = [ pkgs.python3 ];
                __darwinAllowLocalNetworking = true;
              }
              ''
                python ${./nix/smoke.py} ${self.packages.${system}.jj-stamp} ${pkgs.lib.getExe pkgs.jujutsu}
                touch "$out"
              '';
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.jujutsu
            ]
            ++ pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.xdg-utils ];
          };
        }
      );
    };
}
