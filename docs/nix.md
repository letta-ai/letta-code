# Nix and NixOS installation

Letta Code ships a flake for Nix users who want a native install path instead of a global npm install.

## Try once

From a machine with flakes enabled:

```bash
nix run github:letta-ai/letta-code
```

To run from a local checkout:

```bash
nix run .
```

## Install into a profile

```bash
nix profile install github:letta-ai/letta-code
letta
```

## Home Manager

Add Letta Code as a flake input and enable the module:

```nix
{
  inputs.letta-code.url = "github:letta-ai/letta-code";

  outputs = { nixpkgs, home-manager, letta-code, ... }: {
    homeConfigurations.example = home-manager.lib.homeManagerConfiguration {
      pkgs = import nixpkgs { system = "x86_64-linux"; };
      modules = [
        letta-code.homeModules.default
        {
          programs.letta-code.enable = true;
        }
      ];
    };
  };
}
```

## NixOS service

For an always-on listener or channel host, enable the NixOS module and provide secrets through a root-readable environment file:

```nix
{
  inputs.letta-code.url = "github:letta-ai/letta-code";

  outputs = { nixpkgs, letta-code, ... }: {
    nixosConfigurations.agent-host = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        letta-code.nixosModules.default
        {
          services.letta-code = {
            enable = true;
            environmentFile = "/run/secrets/letta-code.env";
            extraArgs = [ "listen" ];
          };
        }
      ];
    };
  };
}
```

The environment file can contain values such as:

```dotenv
LETTA_API_KEY=...
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
SLACK_BOT_TOKEN=...
SLACK_SIGNING_SECRET=...
```

Use your normal NixOS secret manager, such as sops-nix or agenix, to materialize that file.

## What this provides

The flake exposes:

- `packages.<system>.default` / `packages.<system>.letta-code`
- `apps.<system>.default` / `apps.<system>.letta`
- `homeModules.default`
- `nixosModules.default`

The package builds the Letta Code CLI from this repository with the checked-in `package-lock.json`, wraps the resulting `letta` binary with common runtime tools, and leaves agent configuration and credentials in the normal Letta Code locations.

## Follow-up packaging work

This in-repository flake is the fastest path for Nix users to try and deploy Letta Code. A future nixpkgs or Home Manager upstream package should reuse the same shape, but may need additional hardening around native Node dependencies such as `node-pty`, `sharp`, and optional ripgrep binaries.
