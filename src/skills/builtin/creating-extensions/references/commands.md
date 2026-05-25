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

## Busy-safe SDK command

For commands with `runWhenBusy: true`, do not return `prompt` while the agent is running. Use the SDK directly, update a panel if available, and return `{ type: "handled" }` quickly.

Use `letta.client` or `await letta.getClient()` instead of raw `fetch`; SDK initialization is lazy and uses the current backend/auth context.

Common calls:

```ts
await letta.client.conversations.fork(ctx.conversation.id || "default", {
  agent_id: ctx.agent.id,
});

await letta.client.conversations.messages.create(conversationId, {
  agent_id: ctx.agent.id,
  input,
  streaming: true,
});
```

For a complete side-question example, see `btw-command.md`.
