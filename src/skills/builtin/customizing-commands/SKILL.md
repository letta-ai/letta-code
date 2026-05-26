---
name: customizing-commands
description: Creates, edits, and enables Letta Code extension-provided slash commands. Use when the user asks to add a custom /command, slash command, command shortcut, SDK-backed command, or command-driven panel behavior.
---

# Customizing Commands

Use this as the command-specific entrypoint for local extension slash commands. For broader extension work, recipes live in `../creating-extensions/references/commands.md`, `../creating-extensions/references/ui.md`, and `../creating-extensions/references/btw-command.md`.

Extension files live in:

```text
~/.letta/extensions/
```

Use a focused file name, e.g. `~/.letta/extensions/review.ts` or `~/.letta/extensions/commands.ts`.

## First decide whether a command is right

| User wants | Build |
| --- | --- |
| `/foo` sends a prompt or shows local output | Extension command |
| `/foo` starts a reusable agent workflow | Skill + thin extension command |
| Agent/model should autonomously call the capability | Extension tool, not a command |
| Command shows transient progress/results | Extension command + panel |

If the command is a durable workflow like `/goal`, put the workflow instructions in a skill and keep the extension command as a small launcher/prompt.

## Workflow

1. Inspect `~/.letta/extensions/` for related command files.
2. Preserve unrelated extension code; create a focused new file if merging is messy.
3. Register with `letta.commands.register()` and guard with `letta.capabilities.commands`.
4. Return the unregister function, or a disposer that calls it plus any timer/panel cleanup.
5. Tell the user the exact file path changed and to run `/reload`.

## Default prompt command

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;

  return letta.commands.register({
    id: "review",
    description: "Review current git changes",
    args: "[focus]",
    run(ctx) {
      const focus = ctx.args.trim();
      return {
        type: "prompt",
        content: focus
          ? `Review current git changes. Focus on ${focus}.`
          : "Review current git changes. Focus on correctness issues.",
        systemReminder: true,
      };
    },
  });
}
```

## Command result types

```ts
type ExtensionCommandResult =
  | { type: "prompt"; content: string; systemReminder?: boolean }
  | { type: "output"; output: string; success?: boolean }
  | { type: "handled" };
```

- `prompt`: sends content to the agent. Use for normal slash shortcuts.
- `output`: prints local text and does not contact the agent.
- `handled`: command handled its own side effects/UI; common for panel commands.

## Rules

- Command IDs omit the slash: `id: "review"`, not `"/review"`.
- Use lowercase slugs with letters, numbers, and hyphens.
- Do not register built-in command IDs.
- `runWhenBusy: true` commands must not return `prompt` while the main agent is busy; use SDK calls/panels and return `handled`.
- `showInTranscript: false` commands should usually return `handled`, not `prompt`.
- Do not import Letta Code app internals.
- Do not do surprising side effects on startup; extensions activate on app start and `/reload`.

## More recipes

- Simple output command, panel command, SDK command: `../creating-extensions/references/commands.md`
- Panel/status UI patterns: `../creating-extensions/references/ui.md`
- Complete `/btw` side-question recipe: `../creating-extensions/references/btw-command.md`
