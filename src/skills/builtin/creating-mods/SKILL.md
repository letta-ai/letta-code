---
name: creating-mods
description: Creates and edits trusted local Letta Code mods, including tools, slash commands, local-only model providers, lifecycle/turn events, scoped conversation helpers, panels, status values, and capability-gated behavior. Use when asked to make a mod, add an agent-callable tool, add a slash command, add a local provider/model adapter, transform turns, react to app events, or add lightweight mod UI outside the dedicated /statusline flow.
---

# Creating Mods

Use this skill to create or update trusted global Letta Code mods in:

```text
~/.letta/mods/
```

Mods are trusted local code for Letta Code. They add small composable capabilities through mod APIs, not by importing app internals. Prefer scoped handles (`ctx.conversation`, `ctx.cwd`, `ctx.agent`, `letta.getContext()`) and guard optional UI with `letta.capabilities`.

Capabilities vary by surface. TUI/headless may load tools, commands, events, UI, and providers; the desktop listener loads provider-only mods for local provider discovery. Always guard optional capabilities.

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

1. Inspect `~/.letta/mods/` for related files.
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
5. Write a single-file mod unless the user asks for something larger.
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

## Diagnostics

Use `letta.diagnostics.report({ message, severity })` sparingly as a debug utility for mod setup/runtime problems an agent should inspect, such as missing required environment variables or failed local configuration. Default severity is `"error"`; use `severity: "warning"` only for optional/degraded behavior. Keep messages short and actionable, and do not dump routine logs or large state.

Agents can inspect local mod diagnostics at:

```text
~/.letta/mods/diagnostics/latest.json
```

## Rules

- Global trusted code only for now. Do not create project mods.
- Custom provider mods are local-backend/local-agent only. They do not add providers for Constellation/cloud agents.
- Provider mods may run in a provider-only listener context; keep provider registration independent from commands/tools/UI and guard everything else.
- Do not assume extra npm packages are available.
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
- Local shell/file work is scoped to `ctx.cwd` / `ctx.workingDirectory` unless intentionally global.
- Errors shown to the user are short and actionable.

## References

| Reference | Load when |
| --- | --- |
| `references/tools.md` | The model should autonomously call a local capability |
| `../web-search-mods/SKILL.md` | The requested tool is web search, Perplexity, Exa, or Parallel |
| `references/commands.md` | The human should invoke `/foo` |
| `references/providers.md` | Adding a custom model/API provider for local agents |
| `references/events.md` | Reacting to lifecycle/tool/turn events or transforming turns/tools |
| `references/permissions.md` | Enforcing dynamic tool allow/ask/deny policy before approval/execution |
| `references/ui.md` | Panels, status values, or statusline capability guards are involved |
| `references/plan-mode.md` | Recreating plan mode with commands, tools, events, permissions, and local state |
| `references/architecture.md` | Multiple capabilities, local state, cleanup, background model work, or non-trivial composition |
