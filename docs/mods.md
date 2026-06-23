# Letta Code Mods

Mods are trusted local code that extend Letta Code with tools, slash commands, events, permissions, UI, and local provider registrations. They should use the mod APIs instead of importing Letta Code internals.

## Mod forms

### Loose harness mods

Loose harness mods live on the local machine:

```text
~/.letta/mods/foo.ts
```

Use them for machine-wide customization, such as local provider registrations, personal slash commands, status UI, or tools that should be available to every local session on that machine.

After editing a loose harness mod, run `/reload` in active sessions. Use `letta mods list` to inspect loaded loose harness mods.

### Loose agent mods

Loose agent mods live in an agent's memory filesystem:

```text
$MEMORY_DIR/mods/foo.ts
```

Use them for behavior that should travel with a specific agent. When MemFS is enabled, Letta Code loads these in addition to harness mods.

### Precedence

Harness mods load first. Agent mods load after harness mods.

When registrations collide, the agent mod shadows the harness mod. Avoid collisions unless the agent is intentionally overriding a machine-wide command, tool, provider, permission, or UI status.

### Packaged mods

Packaged mods are npm packages with a `package.json#letta` manifest. Use packages for reusable/distributable mods, or mods that need package dependencies.

Install a package locally while developing:

```bash
letta install ./path/to/package
```

Install a package from npm:

```bash
letta install npm:@scope/pkg
```

Managed packages are installed under `~/.letta/mods/packages/...`. Use the package management commands to inspect or change installed package state:

```bash
letta mods list
letta mods enable npm:@scope/pkg
letta mods disable npm:@scope/pkg
letta mods remove npm:@scope/pkg
```

## Package manifest

A mod package declares its entry files in `package.json#letta`:

```json
{
  "name": "@scope/my-letta-mod",
  "version": "0.1.0",
  "type": "module",
  "keywords": ["letta-package", "letta-mod"],
  "letta": {
    "manifestVersion": 1,
    "mods": ["./mods/index.js"],
    "capabilities": ["commands", "tools"]
  }
}
```

Manifest requirements:

- `letta.manifestVersion` must be `1`.
- `letta.mods` must be a non-empty array of safe relative paths.
- Mod entries must end in `.ts`, `.tsx`, `.js`, or `.mjs`.
- Mod entries must not be absolute paths, use `..`, or use backslashes.
- `letta.capabilities` is optional. Supported values are `tools`, `commands`, `providers`, `permissions`, `events.lifecycle`, `events.turns`, `events.tools`, `ui.panels`, `ui.statusValues`, and `ui.statusline`.
- `letta.engines.lettaCodeCli` and `letta.engines.lettaCodeDesktop` are optional semver-compatible ranges.

## Publishing checklist

Before publishing a mod package:

- Remove personal paths, usernames, and machine-specific assumptions.
- Verify the package does not include secrets, tokens, `.env` contents, private URLs, or local logs.
- Document required environment variables, config files, and failure modes.
- Avoid surprising startup side effects. Mods activate on app start and `/reload`.
- Do not import Letta Code app internals such as `@/backend` or `@/cli`.
- Keep dependencies intentional and document why they are needed.
- Test the package through the local install path:

```bash
letta install ./path/to/package
letta mods list
```

Then run `/reload` in an active session and verify the mod loads cleanly.

## Catalog requirements

Cataloged packages must include:

- `keywords: ["letta-package", "letta-mod"]` in `package.json`
- a valid `package.json#letta` manifest

Catalog entries should also include clear README documentation for users and, when helpful, a `MOD.md` or similar agent-facing note that explains the mod's behavior and configuration.
