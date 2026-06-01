---
name: creating-extensions
description: Creates and edits trusted local Letta Code extensions, including extension tools, slash commands, lifecycle/turn events, scoped conversation helpers, panels, status values, and capability-gated behavior. Use when the user asks to make an extension, add a tool the agent can call, add a slash command, transform turns, react to app events, or add lightweight extension UI outside the dedicated /statusline flow.
---

# Creating Extensions

Use this skill to create or update trusted global Letta Code extensions in:

```text
~/.letta/extensions/
```

Extensions are trusted local apps for Letta Code. They add small composable capabilities through extension APIs, not by importing app internals. Prefer scoped handles (`ctx.conversation`, `ctx.cwd`, `ctx.agent`, `letta.getContext()`) and guard optional UI with `letta.capabilities`.

## Choose the right capability

| User wants | Build |
| --- | --- |
| Agent/model should autonomously call a local capability | Extension tool |
| User wants `/foo` to send a prompt or run local UI logic | Extension command |
| Slash command represents a reusable agent workflow | Skill + thin extension command |
| Command should work while the main agent is busy | Command with `runWhenBusy: true`, `handled`, panel/status, and usually `ctx.conversation.fork()` |
| Show transient output above input | Panel, usually from a command |
| Show small persistent state | Status value |
| React to app/session lifecycle or transform outbound turns | Event |
| Change the bottom statusline appearance | Use `customizing-statusline`, not this skill |

Default to a **tool** when the model should decide when to use the capability. Default to a **command** when the human explicitly invokes it. Compose capabilities when the UX needs it, e.g. command + panel + scoped conversation fork.

## Workflow

1. Inspect `~/.letta/extensions/` for related files.
2. Preserve unrelated extension code. Prefer a focused new file if merging would be messy.
3. Choose the extension shape:
   - simple tool/command/event: read the specific recipe below
   - multi-capability or stateful extension: also read `references/architecture.md`
4. Load only the needed recipe:
   - tools: `references/tools.md`
   - commands: `references/commands.md`
   - events: `references/events.md`
   - panels/status/capabilities: `references/ui.md`
   - busy side-question pattern: `references/btw-command.md`
5. Write a single-file extension unless the user asks for something larger.
6. Return disposers for registered commands/tools/events, timers, subscriptions, and panels that should close on reload.
7. Do a basic review: valid names, descriptions present, schemas are object schemas, optional capabilities guarded, scoped APIs used, cleanup returned.
8. Tell the user the absolute file path changed and to run `/reload`. If an extension breaks startup or command handling, recover with `letta --no-extensions` or `LETTA_DISABLE_EXTENSIONS=1 letta`.

## Core extension shape

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
- Do not import `@/backend`, `@/cli`, or other Letta Code internals from extension files.

## Rules

- Global trusted code only for now. Do not create project extensions.
- Do not assume extra npm packages are available.
- Do not do surprising side effects on startup; extensions activate on app start and `/reload`.
- Keep user-facing output short and intentional.
- Prefer Node/Bun standard APIs (`node:child_process`, `node:fs`, etc.) for local work.
- For shell execution, prefer `execFile`/`spawn` over shell strings.
- Do not use emojis for loading states; use text or spinner-like characters if the user asks for loading UI.
- For `runWhenBusy: true`, do not return `prompt`; return `handled` and own the UI/background work.
- Treat `turn_start` as powerful trusted code: keep transforms narrow and unsurprising.

## Pre-flight checklist for complex extensions

Before finishing, verify:

- The extension has one clear owner/file and does not mix unrelated features.
- Command/tool IDs are valid and do not collide with built-ins.
- Tool descriptions explain when the model should call them.
- JSON schemas are object schemas with useful descriptions.
- Optional UI/event/statusline APIs are capability-guarded.
- Timers, intervals, event registrations, and panels are cleaned up in a disposer.
- Busy commands return `{ type: "handled" }` quickly and avoid main-conversation sends.
- Conversation work uses `ctx.conversation` or forked handles, not app internals.
- Local shell/file work is scoped to `ctx.cwd` / `ctx.workingDirectory` unless intentionally global.
- Errors shown to the user are short and actionable.

## References

- `references/architecture.md` - composition, state, cleanup, scoped conversation, and review checklist for complex extensions
- `references/tools.md` - extension tools the model can call
- `references/commands.md` - slash commands, command results, and skill-backed commands
- `references/events.md` - lifecycle and turn event handlers
- `references/ui.md` - panels, status values, capability guards
- `references/btw-command.md` - advanced busy-safe side-question command using scoped conversation helpers
