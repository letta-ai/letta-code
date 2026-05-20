{
  description = "Letta Code CLI package and service modules";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      lib = nixpkgs.lib;
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      supportedSystems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = lib.genAttrs supportedSystems;
      pkgsFor = system: import nixpkgs { inherit system; };
      mkPackage = pkgs:
        pkgs.buildNpmPackage rec {
          pname = "letta-code";
          version = packageJson.version;
          src = ./.;

          npmDeps = pkgs.importNpmLock { npmRoot = src; };
          nativeBuildInputs = [
            pkgs.bun
            pkgs.importNpmLock.npmConfigHook
            pkgs.makeWrapper
            pkgs.pkg-config
            pkgs.python3
          ];

          npmFlags = [ "--legacy-peer-deps" ];
          npmInstallFlags = [ "--legacy-peer-deps" ];
          npmBuildScript = "build";

          CI = "true";
          npm_config_legacy_peer_deps = "true";

          preBuild = ''
            export HOME="$TMPDIR"
          '';

          postInstall = ''
            wrapProgram "$out/bin/letta" \
              --prefix PATH : ${lib.makeBinPath [ pkgs.git pkgs.ripgrep ]}
          '';

          meta = {
            description = packageJson.description;
            homepage = "https://github.com/letta-ai/letta-code";
            license = lib.licenses.asl20;
            mainProgram = "letta";
            maintainers = [ ];
          };
        };
    in
    {
      packages = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = mkPackage pkgs;
          letta-code = self.packages.${system}.default;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/letta";
        };
        letta = self.apps.${system}.default;
      });

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            packages = [ pkgs.bun pkgs.nodejs_22 pkgs.git pkgs.ripgrep ];
          };
        });

      nixosModules.default = import ./nix/modules/nixos.nix { inherit self; };
      nixosModules.letta-code = self.nixosModules.default;
      homeModules.default = import ./nix/modules/home-manager.nix { inherit self; };
      homeModules.letta-code = self.homeModules.default;
    };
}
