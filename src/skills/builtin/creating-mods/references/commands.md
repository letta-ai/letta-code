# Mod command recipes

Use commands when the human explicitly invokes `/foo`.

For complex command-driven mods with panels, timers, local state, or background model work, also read `architecture.md`.

## Contents

- Decide command vs skill vs tool
- Command IDs
- Prompt command
- Output-only command
- Panel command
- Busy-safe conversation command

## Decide command vs skill vs tool

| Need | Use |
| --- | --- |
| `/foo` expands to a prompt | Mod command |
| `/foo` starts a complex reusable workflow | Skill + thin mod command |
| Model should call the capability by itself | Mod tool |
| Command needs transient UI while doing local work | Mod command + panel |
| Command needs model output while the main agent is busy | `runWhenBusy: true` command + forked `ctx.conversation` |

If the command represents a durable agent workflow (for example `/goal`), put the workflow instructions in a skill and keep the command as a small launcher/prompt.

## Command IDs

- Do not include the leading slash. Use `id: "review"`, not `id: "/review"`.
- Use a lowercase slug with letters, numbers, and hyphens only.
- Built-in commands like `/reload`, `/model`, `/statusline`, etc. can be overridden by trusted local mods. Do this intentionally and keep recovery in mind: start with `--no-mods` or `LETTA_DISABLE_MODS=1` if an override breaks command handling.
- Duplicate mod command IDs fail unless `override: true` is intentional.

## Prompt command

Use `prompt` for normal slash shortcuts that should become the next agent turn. Prompt commands are not busy-safe.

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

## Output-only command

Use `output` for local results that do not need the model.

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;

  return letta.commands.register({
    id: "whereami",
    description: "Show the active mod command context",
    run(ctx) {
      return {
        type: "output",
        output: `Agent: ${ctx.agent.name ?? ctx.agent.id}\nCWD: ${ctx.cwd}`,
      };
    },
  });
}
```

## Panel command

Use `{ type: "handled" }` when the command owns the UI. Guard panels because they are optional on non-TUI surfaces.

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;

  return letta.commands.register({
    id: "hello-panel",
    description: "Show a short transient panel",
    showInTranscript: false,
    run(ctx) {
      if (!letta.capabilities.ui.panels) {
        return { type: "output", output: `hello ${ctx.args || "there"}` };
      }

      const greeting = `hello ${ctx.args || "there"}`;
      const panel = letta.ui.openPanel({
        id: "hello-panel",
        render: () => greeting,
      });
      setTimeout(() => panel.close(), 5_000);
      return { type: "handled" };
    },
  });
}
```

## Busy-safe conversation command

For commands with `runWhenBusy: true`, do not return `prompt` while the agent is running. Use the scoped conversation handle directly, update a panel/status if available, and return `{ type: "handled" }` quickly.

Use `ctx.conversation` for conversation operations that should work across local and Constellation backends. The handle is bound to the active conversation and backend for that command invocation, so composed flows like fork-then-send stay on the same backend. Use `letta.client` only for server-specific API calls.

Common pattern:

```ts
const forked = await ctx.conversation.fork({ hidden: true });

const stream = await forked.sendMessageStream([
  { role: "user", content: input },
]);
```

Do not send directly to the active conversation from a busy command; fork first unless the user explicitly asked to affect the main conversation later.

For a worked multi-capability mod that combines commands, tools, events, permissions, and local state, see `plan-mode.md`.
