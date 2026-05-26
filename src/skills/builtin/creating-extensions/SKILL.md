---
name: creating-extensions
description: Creates and edits Letta Code local extensions, including extension tools, slash commands, panels, status values, and capability-gated behavior. Use when the user asks to make an extension, add a tool the agent can call, add a slash command, or add lightweight extension UI outside the dedicated /statusline flow.
---

# Creating Extensions

Use this skill to create or update trusted global Letta Code extensions in:

```text
~/.letta/extensions/
```

Extensions are local runtime capabilities, not TUI-only plugins. Prefer portable APIs and guard optional UI with `letta.capabilities`.

## Choose the right capability

| User wants | Build |
| --- | --- |
| Agent/model should autonomously call a local capability | Extension tool |
| User wants `/foo` to send a prompt or run local UI logic | Extension command |
| Slash command represents a reusable agent workflow | Skill + thin extension command |
| Show transient output above input | Panel, usually from a command |
| Show small persistent state | Status value |
| Change the bottom statusline appearance | Use `customizing-statusline`, not this skill |

Default to a **tool** when the model should decide when to use the capability. Default to a **command** when the human explicitly invokes it.

## Workflow

1. Inspect `~/.letta/extensions/` for related files.
2. Preserve unrelated extension code. Prefer a focused new file if merging would be messy.
3. Choose one capability recipe:
   - tools: `references/tools.md`
   - commands: `references/commands.md`
   - panels/status/capabilities: `references/ui.md`
4. Write a single-file extension unless the user asks for something larger.
5. Return disposers for registered commands/tools, timers, subscriptions, and panels that should close on reload.
6. Do a basic syntax/shape review: valid names, descriptions present, JSON schemas are object schemas, capability guards around optional UI.
7. Tell the user the absolute file path changed and to run `/reload`.

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
letta.capabilities.ui.panels
letta.capabilities.ui.statusValues
letta.capabilities.ui.customStatuslineRenderer
```

## Rules

- Global trusted code only for now. Do not create project extensions.
- Do not import Letta Code app internals from extension files.
- Do not assume extra npm packages are available.
- Do not do surprising side effects on startup; extensions activate on app start and `/reload`.
- Keep user-facing output short and intentional.
- Prefer Node/Bun standard APIs (`node:child_process`, `node:fs`, etc.) for local work.
- For shell execution, prefer `execFile`/`spawn` over shell strings.
- Do not use emojis for loading states; use text or spinner-like characters if the user asks for loading UI.

## References

- `references/tools.md` - extension tools the model can call
- `references/commands.md` - slash commands, command results, and skill-backed commands
- `references/ui.md` - panels, status values, capability guards
- `references/btw-command.md` - advanced busy-safe side-question command using backend primitives
