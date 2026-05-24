---
name: customizing-commands
description: Creates, edits, and enables Letta Code extension-provided slash commands. Use when the user asks to add a custom /command, slash command, command shortcut, SDK-backed command, or panel-rendered command behavior.
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
- Prefer specific names for shared commands (`github-review`, `btw-code`) to avoid collisions with other extensions.

Command resolution order is: built-in/special commands, custom command files, extension commands, then remaining registry/skill commands. Extension commands cannot replace built-ins, and custom command files with the same name win over extensions.

### Command metadata

```ts
letta.commands.register({
  id: "btw",
  description: "Ask a side question",
  runWhenBusy: true,
  showInTranscript: false,
  run(ctx) {
    return { type: "handled" };
  },
});
```

- `runWhenBusy`: allows the command to run while the main agent is streaming/executing. Busy-safe commands must use their own SDK calls and should not return `prompt` while the agent is running.
- `showInTranscript`: defaults to `true`. Set `false` for commands that render their own UI panel and should not add a command row to the transcript.

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

## Letta SDK client

Extensions also receive the configured Letta SDK client:

```ts
letta.client
```

Use it for advanced workflows that need the full Letta API, such as forking conversations, reading agent state, or sending messages. This is the same authenticated client context the app uses.

API reference:

- Letta API docs: https://docs.letta.com/api-reference/overview
- TypeScript SDK package: https://www.npmjs.com/package/@letta-ai/letta-client

Guidance:

- Prefer `letta.client` over raw `fetch`; it already has the current backend URL, auth, and app headers.
- Verify SDK method and parameter names before guessing. The generated SDK follows API field names, so request params are often snake_case (`agent_id`), not camelCase (`agentId`).
- For the default conversation, pass `"default"` plus `{ agent_id: ctx.agent.id }` when the endpoint requires agent-direct mode.
- Common conversation calls:
  - `await letta.client.conversations.fork(conversationId, { agent_id: ctx.agent.id })`
  - `await letta.client.conversations.messages.create(conversationId, { agent_id: ctx.agent.id, input, streaming: true })`
- Streaming message calls return an async iterable of chunks. Extract assistant text from `assistant_message` chunks; chunk content may be a string or an array of text parts.

## UI panels

Commands can write raw lines into the space above the input bar:

```ts
const panel = letta.ui.openPanel({
  id: "btw",
  content: [`/btw ${question}`, "…"],
});

panel.update({ content: [`/btw ${question}`, "Caren"] });
setTimeout(() => panel.close(), 10_000);
```

Panels are intentionally minimal: `id`, `content`, and optional `order`. `content` may be a string (split on newlines) or an array of strings. Core only reserves the slot above the input bar and truncates lines to terminal width; the extension owns visual formatting such as borders, spacing, wrapping, and right alignment.

Guidance:

- Keep panel output short. If you need long-form output, prefer command `output` or a normal `prompt` flow.
- Panels persist until `panel.close()`, `letta.ui.clearPanel(id)`, the same `id` is overwritten, or `/reload` disposes extensions.
- For transient results, close the panel after a short timeout.
- If formatting depends on terminal size, use `ctx.getContext().terminalWidth` inside a command or `letta.getContext().terminalWidth` outside a command. Terminal sizes are columns, not pixels.
- Avoid unexplained magic widths. If you cap width for aesthetics, name the constant, e.g. `PANEL_MAX_COLUMNS`.

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

### Ask a side question in a forked conversation

For a fuller `/btw` recipe using `runWhenBusy`, `showInTranscript: false`, `letta.client.conversations.fork(...)`, streaming, and `letta.ui.openPanel(...)`, see [`reference/btw-command.md`](reference/btw-command.md).

## Constraints

- Global trusted code only for now. Do not create project extensions.
- Do not use app internals, React setters, or command runner objects.
- Prefer `letta.client` over raw `fetch` when using the Letta API.
- Keep command handlers fast. For long-running SDK work, start an async task, update a panel, and return `{ type: "handled" }` immediately.
- If a command uses `runWhenBusy`, do not return `prompt` while the agent is running. Use `letta.client` and panels instead.
- Do not register built-in command IDs.
- Do not do surprising side effects on startup; extension files execute when Letta Code starts or `/reload` runs.
