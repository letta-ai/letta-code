---
name: creating-mods
description: Creates and edits trusted local Letta Code mods, including tools, slash commands, local-only model providers, lifecycle/turn events, scoped conversation helpers, panels, status values, and capability-gated behavior. Use when asked to make a mod, add an agent-callable tool, add a slash command, add a local provider/model adapter, transform turns, react to app events, or add lightweight mod UI outside the dedicated /statusline flow.
---

# Creating Mods

Use this skill to create or update trusted Letta Code mods. Mods add small composable capabilities through mod APIs, not by importing app internals. Dynamic agent/conversation/workspace/model state is passed as `ctx` to tool, command, event, permission, status, and statusline callbacks; do not read mutable global context for model-callable behavior. Prefer scoped handles (`ctx.conversation`, `ctx.cwd`, `ctx.agent`) and guard optional UI with `letta.capabilities`.

Capabilities vary by surface. TUI/headless may load tools, commands, events, UI, and providers; the desktop listener loads provider-only mods for local provider discovery. Always guard optional capabilities.

## Choose the right mod form

| Form | Path / shape | Use when |
| --- | --- | --- |
| Loose harness mod | `~/.letta/mods/foo.ts` | The customization should apply to local sessions on this machine |
| Loose agent mod | `$MEMORY_DIR/mods/foo.ts` | The behavior should travel with one agent's MemFS/memory |
| Packaged mod | npm package with `package.json#letta` | The mod should be reusable/distributable or needs package dependencies |

Harness mods load first. Agent mods load after harness mods. When command/tool/provider/permission/status IDs collide, the agent mod shadows the harness mod. Avoid collisions unless intentionally overriding behavior.

Use a single-file loose mod by default. Use a package when the user asks for distribution, installability, or dependencies.

## Choose the right capability

| User wants | Build |
| --- | --- |
| Agent/model should autonomously call a local capability | Mod tool |
| User wants `/foo` to send a prompt or run local UI logic | Mod command |
| Slash command represents a reusable agent workflow | Skill + thin mod command |
| Command should work while the main agent is busy | Command with `runWhenBusy: true`, `handled`, panel/status, and usually `ctx.conversation.fork()` |
| Show transient output above input | Panel, usually from a command |
| Show small persistent state | Status value |
| React to app/session lifecycle or transform outbound turns | Event |
| Enforce dynamic allow/ask/deny policy for tool calls | Permission overlay |
| Add a custom model/API provider for local agents | Provider mod (local agents only) |
| Change the bottom statusline appearance | Use `customizing-statusline`, not this skill |

Default to a **tool** when the model should decide when to use the capability. Default to a **command** when the human explicitly invokes it. Compose capabilities when the UX needs it, e.g. command + panel + scoped conversation fork.

## Workflow

1. Pick the target form and inspect the relevant location before editing:
   - loose harness mod: `~/.letta/mods/`
   - loose agent mod: `$MEMORY_DIR/mods/`
   - packaged mod: the package source directory
2. Preserve unrelated mod code. Prefer a focused new file if merging would be messy.
3. Choose the mod shape and load only the needed recipe:
   - tools: `references/tools.md`
   - commands: `references/commands.md`
   - local custom providers: `references/providers.md`
   - events: `references/events.md`
   - permissions: `references/permissions.md`
   - panels/status/capabilities: `references/ui.md`
   - complex plan-mode composition: `references/plan-mode.md`
4. For multi-capability or stateful mods, also read `references/architecture.md`.
5. Write a single-file loose mod unless the user asks for a package or something larger.
6. Return disposers for registered providers/commands/tools/events, timers, subscriptions, and panels that should close on reload.
7. Do a basic review: valid names, descriptions present, schemas are object schemas, optional capabilities guarded, scoped APIs used, cleanup returned.
8. Tell the user the absolute file path changed and to run `/reload`. If a mod breaks startup or command handling, recover with `letta --no-mods` or `LETTA_DISABLE_MODS=1 letta`.

## Core mod shape

```ts
export default function activate(letta) {
  const disposers = [];

  if (letta.capabilities.tools) {
    disposers.push(letta.tools.register(/* ... */));
  }

  if (letta.capabilities.commands) {
    disposers.push(letta.commands.register(/* ... */));
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
```

Use `letta.capabilities` for optional behavior:

```ts
letta.capabilities.tools
letta.capabilities.commands
letta.capabilities.events.lifecycle
letta.capabilities.events.tools
letta.capabilities.events.turns
letta.capabilities.permissions
letta.capabilities.providers
letta.capabilities.ui.panels
letta.capabilities.ui.statusValues
letta.capabilities.ui.customStatuslineRenderer
```

## Scoped API model

- In commands and events, use `ctx.conversation` for conversation operations:
  - `ctx.conversation.getHistory()` for recent messages
  - `ctx.conversation.fork()` for independent/background model work
  - `forked.sendMessageStream([...])` to stream from a fork
- In tools, use `ctx.conversation.getHistory()` when the tool needs recent context.
- Use `letta.client` only for server-specific Letta API calls; do not use it as a substitute for scoped conversation helpers.
- Do not import `@/backend`, `@/cli`, or other Letta Code internals from mod files.

## Packaged mods

A packaged mod is an npm package with a `package.json#letta` manifest. Use packages for reusable/distributable mods or when the mod needs npm dependencies.

Minimal package example:

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

Manifest rules:

- `letta.manifestVersion` must be `1`.
- `letta.mods` must be a non-empty array of safe relative `.ts`, `.tsx`, `.js`, or `.mjs` paths.
- `letta.capabilities` is optional. Use supported capability IDs only: `tools`, `commands`, `providers`, `permissions`, `events.lifecycle`, `events.turns`, `events.tools`, `ui.panels`, `ui.statusValues`, `ui.statusline`.
- `letta.engines.lettaCodeCli` and `letta.engines.lettaCodeDesktop` are optional semver-compatible ranges.

Install/test locally before publishing:

```bash
letta install ./path/to/package
letta mods list
```

Install from npm with:

```bash
letta install npm:@scope/pkg
```

## Diagnostics

Use `letta.diagnostics.report({ message, severity })` sparingly as a debug utility for mod setup/runtime problems an agent should inspect, such as missing required environment variables or failed local configuration. Default severity is `"error"`; use `severity: "warning"` only for optional/degraded behavior. Keep messages short and actionable, and do not dump routine logs or large state.

Agents can inspect local mod diagnostics at:

```text
~/.letta/mods/diagnostics/latest.json
```

## Publishing checklist

Before publishing or submitting a mod package to a catalog:

- Remove personal paths, local usernames, and machine-specific assumptions.
- Verify no secrets, tokens, `.env` contents, private URLs, or local logs are included.
- Document required environment variables, config files, and failure modes.
- Avoid surprising startup side effects; mods activate on app start and `/reload`.
- Do not import Letta Code app internals.
- Keep dependencies intentional and document why they are needed.
- Test with local install: `letta install ./path/to/package`, `letta mods list`, then `/reload`.

Catalog requirements:

- `keywords: ["letta-package", "letta-mod"]`
- valid `package.json#letta`

## Rules

- Do not create project mods.
- Custom provider mods are local-backend/local-agent only. They do not add providers for Constellation/cloud agents.
- Provider mods may run in a provider-only listener context; keep provider registration independent from commands/tools/UI and guard everything else.
- Loose mods should not assume extra npm packages are available. Packaged mods may declare dependencies, but should avoid unnecessary dependencies.
- Do not do surprising side effects on startup; mods activate on app start and `/reload`.
- Keep user-facing output short and intentional.
- Prefer Node/Bun standard APIs (`node:child_process`, `node:fs`, etc.) for local work.
- For shell execution, prefer `execFile`/`spawn` over shell strings.
- Do not use emojis for loading states; use text or spinner-like characters if the user asks for loading UI.
- For `runWhenBusy: true`, do not return `prompt`; return `handled` and own the UI/background work.
- Treat `turn_start` as powerful trusted code: keep transforms narrow and unsurprising.

## Pre-flight checklist for complex mods

Before finishing, verify:

- The mod has one clear owner/file and does not mix unrelated features.
- Command/tool IDs are valid; command overrides of built-ins are intentional, and tool IDs do not collide with built-ins.
- Tool descriptions explain when the model should call them.
- JSON schemas are object schemas with useful descriptions.
- Optional UI/event/statusline APIs are capability-guarded.
- Provider mods are capability-guarded and clearly documented as local-agent only.
- Timers, intervals, event registrations, and panels are cleaned up in a disposer.
- Busy commands return `{ type: "handled" }` quickly and avoid main-conversation sends.
- Conversation work uses `ctx.conversation` or forked handles, not app internals.
- Local shell/file work is scoped to `ctx.cwd` unless intentionally global.
- Errors shown to the user are short and actionable.

## References

| Reference | Load when |
| --- | --- |
| `references/tools.md` | The model should autonomously call a local capability |
| `references/commands.md` | The human should invoke `/foo` |
| `references/providers.md` | Adding a custom model/API provider for local agents |
| `references/events.md` | Reacting to lifecycle/tool/turn events or transforming turns/tools |
| `references/permissions.md` | Enforcing dynamic tool allow/ask/deny policy before approval/execution |
| `references/ui.md` | Panels, status values, or statusline capability guards are involved |
| `references/plan-mode.md` | Recreating plan mode with commands, tools, events, permissions, and local state |
| `references/analysis-mode.md` | Phrase-triggered diagnostic mode with turn reminders (simpler than plan-mode) |
| `references/architecture.md` | Multiple capabilities, local state, cleanup, background model work, or non-trivial composition |
