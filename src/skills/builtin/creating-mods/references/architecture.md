# Mod architecture patterns

Use this reference for non-trivial mods: multiple capabilities, local state, timers, background model work, or UI.

## Contents

- Mental model
- Capability composition patterns
- Local state
- Timers and subscriptions
- Scoped conversation handles
- Error handling
- Final review checklist

## Mental model

A mod is trusted local code that registers capabilities during activation and cleans them up on reload/shutdown. Keep the public surface small:

- activation registers commands/tools/events/UI
- command/tool/event handlers receive scoped context
- state is local and explicit
- cleanup is returned from activation

Do not import Letta Code internals. If the mod API does not expose a capability yet, avoid reaching around it.

Capabilities vary by host surface. Keep each registration behind the matching `letta.capabilities` guard so one file can run in TUI, headless, and provider-only listener contexts.

## Capability composition patterns

### Tool + command

Use a tool for autonomous model use and a command for explicit human invocation. Keep shared local helper functions inside the same file.

```ts
function summarizeBranch(cwd) {
  // local implementation
}

export default function activate(letta) {
  const disposers = [];

  if (letta.capabilities.tools) {
    disposers.push(letta.tools.register({
      name: "branch_summary",
      description: "Summarize the current git branch when repository state matters.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      requiresApproval: false,
      async run(ctx) {
        return summarizeBranch(ctx.cwd);
      },
    }));
  }

  if (letta.capabilities.commands) {
    disposers.push(letta.commands.register({
      id: "branch-summary",
      description: "Show current branch summary",
      async run(ctx) {
        return { type: "output", output: await summarizeBranch(ctx.cwd) };
      },
    }));
  }

  return () => disposers.reverse().forEach((dispose) => dispose());
}
```

### Command + panel + background conversation

Use this for side questions, long local work, or busy-safe commands. For commands with `runWhenBusy: true`, return `{ type: "handled" }` quickly and update a panel/status asynchronously. If model output is needed while the main agent is busy, fork first:

```ts
const forked = await ctx.conversation.fork({ hidden: true });
const stream = await forked.sendMessageStream([
  { role: "user", content: prompt },
]);
```

Do not call `ctx.conversation.sendMessageStream()` on the active conversation from a busy command; direct sends can conflict with the active run.

### Event + panel

Use lifecycle events to maintain a small panel such as active conversation state. Guard both event and panel capabilities, and re-render with `panel.update()`.

```ts
if (letta.capabilities.events.lifecycle && letta.capabilities.ui.panels) {
  let conversation = "";
  const panel = letta.ui.openPanel({
    id: "conversation",
    order: 100,
    render: ({ width, row }) => row("conversation", conversation, width),
  });
  disposers.push(() => panel.close());
  disposers.push(letta.events.on("conversation_open", (event) => {
    conversation = event.reason;
    panel.update();
  }));
}
```

### `turn_start` transform

Use `turn_start` only when the mod needs to inspect or transform the outbound user-message turn. Keep transforms local and predictable. Prefer appending/prepending focused context or replacing explicit shortcuts over broad rewrites.

## Local state

For small persistent state, use a clearly named file under `~/.letta/mods/`, for example:

```text
~/.letta/mods/my-mod.state.json
```

Use atomic-ish writes when practical: write the full JSON file from an in-memory object after each change. Validate parsed state and fall back gracefully if the file is missing or malformed.

Keep state separate from source code. Do not store secrets in plain JSON; use existing secret/provider mechanisms when credentials are needed.

## Timers and subscriptions

Timers are okay for active-session behavior, but they only run while the mod engine is alive. Always clear them:

```ts
const timer = setInterval(update, 30_000);
return () => clearInterval(timer);
```

For long async loops, check `letta.signal.aborted` or `ctx.signal.aborted` and stop quietly.

## Scoped conversation handles

Commands and events receive `ctx.conversation`:

```ts
ctx.conversation.id                 // string | null
ctx.conversation.getHistory(opts)   // recent messages
ctx.conversation.fork(opts)         // returns a scoped handle
ctx.conversation.sendMessageStream(messages, opts)
ctx.conversation.updateLlmConfig(opts) // change model / reasoning effort / context window
```

A forked handle keeps the same agent/backend defaults and targets the forked conversation. Use forked handles for background model work. Use `getHistory({ limit, order, includeErrors })` when local logic needs conversation context.

`updateLlmConfig({ model?, reasoningEffort?, contextWindow?, scope? })` changes the model, reasoning effort, and/or context window, and works across local and Constellation backends. Only the fields you pass change; the rest are preserved, so `updateLlmConfig({ contextWindow })` adjusts just the context window without touching the model or reasoning effort. `scope` defaults to `"conversation"` (a conversation-scoped override that leaves the agent's default untouched); pass `scope: "agent"` to change the agent default. Changing reasoning effort without a model resolves the current model to rebuild provider-specific settings. The change takes effect on the next turn (the model is resolved per provider request).

Tools currently receive `ctx.conversation.getHistory()` but not fork/send helpers. If a tool needs model-side follow-up, return information for the model to act on instead of starting a hidden run from the tool.

## Error handling

- Catch expected local errors and return short user-facing text.
- Let unexpected errors throw when diagnostics are better than hiding the failure.
- For panel workflows, update the panel with a concise error and close it after a delay.
- For tools, return `{ status: "error", content: "..." }` or throw depending on whether the model can recover.

## Final review checklist

- Capability guards are present for commands/tools/events/UI.
- Activation does not do heavy work unless the feature needs startup state.
- All disposers/timers/subscriptions are cleaned up.
- `runWhenBusy: true` commands return `handled`, not `prompt`.
- Background model work uses a forked conversation.
- Local filesystem and shell work uses scoped paths and `execFile`/`spawn`.
- Mod output is concise and actionable.
