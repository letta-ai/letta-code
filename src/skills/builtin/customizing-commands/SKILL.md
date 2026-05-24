---
name: customizing-commands
description: Creates, edits, and enables Letta Code extension-provided slash commands. Use when the user asks to add a custom /command, slash command, command shortcut, or prompt-oriented command behavior.
---

# Customizing Commands

Use this skill to create or update global Letta Code slash commands provided by local extensions.

Extension files live here:

```text
~/.letta/extensions/
```

Use a focused file name like:

```text
~/.letta/extensions/commands.ts
~/.letta/extensions/review.ts
```

## Workflow

1. Inspect `~/.letta/extensions/` for existing command extensions.
2. Preserve unrelated extension code. If adding a new command to an existing command file is clean, edit it; otherwise create a focused new file.
3. Register commands with `letta.commands.register()`.
4. Return the unregister function, or return a disposer that calls it.
5. Tell the user exactly which file changed and ask them to run `/reload`.
6. After reload, the command should appear in slash-command autocomplete and execute from the input.

## API

```ts
export default function activate(letta) {
  const unregister = letta.commands.register({
    id: "review",
    description: "Review current git changes",
    args: "[focus]",
    order: 250,
    async run(ctx) {
      return {
        type: "prompt",
        content: "Review the current git diff. Focus only on correctness issues.",
        systemReminder: true,
      };
    },
  });

  return unregister;
}
```

### Command IDs

- Do not include the leading slash. Use `id: "review"`, not `id: "/review"`.
- Use a lowercase slug with letters, numbers, and hyphens only.
- Built-in commands like `/reload`, `/model`, `/statusline`, etc. are reserved.
- Duplicate extension command IDs fail unless the command explicitly uses `override: true`.

### Command context

`run(ctx)` receives:

```ts
type ExtensionCommandContext = {
  rawInput: string;
  command: string;
  args: string;
  argv: string[];
  cwd: string;
  agent: { id: string; name: string | null };
  conversation: { id: string };
  model: { id: string | null; displayName: string | null };
  permissionMode: string | null;
  getContext(): ExtensionContext;
};
```

Use `ctx.args` for the raw argument string and `ctx.argv` for simple quote-aware splitting.

### Results

Command handlers return declarative results. The app owns transcript rendering, approval checks, and sending prompts.

```ts
type ExtensionCommandResult =
  | { type: "prompt"; content: string; systemReminder?: boolean }
  | { type: "output"; output: string; success?: boolean }
  | { type: "handled" };
```

- `prompt`: sends content to the agent. By default content is wrapped as a system reminder; set `systemReminder: false` to send it as a normal user prompt.
- `output`: finishes the command row with text and does not contact the agent.
- `handled`: finishes the command row without sending a prompt.

## Examples

### Review current changes

```ts
export default function activate(letta) {
  return letta.commands.register({
    id: "review",
    description: "Review current git changes",
    async run() {
      return {
        type: "prompt",
        content: "Review the current git diff. Focus only on correctness issues.",
        systemReminder: true,
      };
    },
  });
}
```

### Review a PR argument

```ts
export default function activate(letta) {
  return letta.commands.register({
    id: "review-pr",
    description: "Review a GitHub PR",
    args: "<url-or-number>",
    async run(ctx) {
      return {
        type: "prompt",
        content: `Review this PR: ${ctx.args}`,
      };
    },
  });
}
```

### Show local output only

```ts
export default function activate(letta) {
  return letta.commands.register({
    id: "whoami",
    description: "Show current command context",
    run(ctx) {
      return {
        type: "output",
        output: `Agent: ${ctx.agent.name ?? ctx.agent.id}\nCWD: ${ctx.cwd}`,
      };
    },
  });
}
```

## Constraints

- Global trusted code only for now. Do not create project extensions.
- Do not expose app internals, React setters, backend clients, or command runner objects.
- Keep command handlers fast. Async handlers are allowed, but they should return prompt/output/handled results rather than mutating app state.
- Do not register built-in command IDs.
- Do not do surprising side effects on startup; extension files execute when Letta Code starts or `/reload` runs.
