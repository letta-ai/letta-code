{
  description = "Letta Code CLI package and service modules";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix.url = "github:nix-community/bun2nix";
    bun2nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = { self, nixpkgs, bun2nix }:
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
      pkgsFor = system: import nixpkgs {
        inherit system;
        overlays = [ bun2nix.overlays.default ];
      };
      mkPackage = pkgs:
        pkgs.stdenv.mkDerivation rec {
          pname = "letta-code";
          version = packageJson.version;
          src = ./.;

          bunDeps = pkgs.bun2nix.fetchBunDeps {
            bunNix = ./bun.nix;
          };

          nativeBuildInputs = [
            pkgs.bun
            pkgs.makeWrapper
            pkgs.nodejs_22
            pkgs.pkg-config
            pkgs.python3
            pkgs.bun2nix.hook
          ];

          bunInstallFlags = if pkgs.stdenv.hostPlatform.isDarwin then [
            "--linker=hoisted"
            "--backend=copyfile"
          ] else [
            "--linker=hoisted"
          ];

          CI = "true";

          dontUseBunCheck = true;

          preBuild = ''
            export HOME="$TMPDIR"
          '';

          buildPhase = ''
            runHook preBuild
            bun run build
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall

            pack_dir="$TMPDIR/package"
            mkdir -p "$pack_dir" "$out/lib/letta-code" "$out/bin"

            npm pack --ignore-scripts --pack-destination "$pack_dir"
            tar -xzf "$pack_dir"/letta-ai-letta-code-*.tgz \
              -C "$out/lib/letta-code" \
              --strip-components=1

            makeWrapper ${pkgs.nodejs_22}/bin/node "$out/bin/letta" \
              --add-flags "$out/lib/letta-code/letta.js" \
              --prefix PATH : ${lib.makeBinPath [ pkgs.git pkgs.ripgrep ]}

            runHook postInstall
          '';

          postInstall = ''
            chmod +x "$out/bin/letta"
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
      homeManagerModules.default = import ./nix/modules/home-manager.nix { inherit self; };
      homeManagerModules.letta-code = self.homeManagerModules.default;
      homeModules.default = import ./nix/modules/home-manager.nix { inherit self; };
      homeModules.letta-code = self.homeModules.default;
    };
}
