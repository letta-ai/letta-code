# Extension command recipes

Use commands when the human explicitly invokes `/foo`.

## Decide command vs skill vs tool

| Need | Use |
| --- | --- |
| `/foo` expands to a prompt | Extension command |
| `/foo` starts a complex reusable workflow | Skill + thin extension command |
| Model should call the capability by itself | Extension tool |
| Command needs transient UI while doing local work | Extension command + panel |

If the command represents a durable agent workflow (for example `/goal`), put the workflow instructions in a skill and keep the command as a small launcher/prompt.

## Command IDs

- Do not include the leading slash. Use `id: "review"`, not `id: "/review"`.
- Use a lowercase slug with letters, numbers, and hyphens only.
- Built-in commands like `/reload`, `/model`, `/statusline`, etc. are reserved.
- Duplicate extension command IDs fail unless `override: true` is intentional.

## Prompt command

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

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;

  return letta.commands.register({
    id: "whereami",
    description: "Show the active extension command context",
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

      const panel = letta.ui.openPanel({
        id: "hello-panel",
        content: [`hello ${ctx.args || "there"}`],
      });
      setTimeout(() => panel.close(), 5_000);
      return { type: "handled" };
    },
  });
}
```

## Busy-safe backend command

For commands with `runWhenBusy: true`, do not return `prompt` while the agent is running. Use backend primitives directly, update a panel if available, and return `{ type: "handled" }` quickly.

Use `letta.backend` for conversation operations that should work across local and Constellation backends. Use `letta.client` only for server-specific API calls.

Common calls:

```ts
const forked = await letta.backend.forkConversation(ctx.conversation.id, {
  agentId: ctx.agent.id,
  hidden: true,
});

const stream = await letta.backend.sendMessageStream(forked.id, [
  { role: "user", content: input },
]);
```

For a complete side-question example, see `btw-command.md`.
