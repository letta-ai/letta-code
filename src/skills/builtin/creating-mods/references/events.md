# Mod event recipes

Use events when trusted local code should react to app/session changes or transform outbound turns without the human explicitly invoking a command. For event-driven mods with state, timers, panels, or background model work, also read `architecture.md`.

## Contents

- Capabilities
- Supported events
- Tool argument transforms
- Turn input transforms
- Event handler context
- Conversation status example
- Rules

This is the first slice of the hooks-v2 direction. The long-term goal is for typed mod events to replace settings-based hooks. Existing hooks still own blocking decisions and model feedback injection until each event has a typed return contract.

## Capabilities

```ts
letta.capabilities.events.lifecycle
letta.capabilities.events.tools
letta.capabilities.events.turns
```

Guard events when writing portable mods:

```ts
export default function activate(letta) {
  if (!letta.capabilities.events.lifecycle) return;

  return letta.events.on("conversation_open", (event, ctx) => {
    console.log(`conversation ${event.reason}: ${event.agentName ?? event.agentId}`);
    console.log(`cwd: ${ctx.cwd}`);
  });
}
```

The API intentionally follows the Pi-style event shape:

```ts
letta.events.on("event_name", (event, ctx) => {
  // event is specific to event_name
  // ctx contains host context and an AbortSignal
});
```

Tool events use this same API. Use `letta.permissions.register` for allow/ask/deny policy; use `tool_start` for last-mile argument transforms and lifecycle reactions.

```ts
letta.events.on("tool_start", (event, ctx) => {
  if (event.toolName !== "Bash") return;
  if (String(event.args.command).startsWith("npm test")) {
    return { args: { ...event.args, command: "bun test" } };
  }
});
```

Lifecycle, turn-start, and tool-start events are wired today.

Lifecycle handlers are notification-only and should not return values. `turn_start` handlers can transform the outbound input for the next model turn. `tool_start` handlers can transform the tool arguments before execution.

## Supported events

```ts
"conversation_open"
"conversation_close"
"tool_start"
"tool_end"
"turn_start"
```

`conversation_open` event:

```ts
{
  agentId: string | null;
  agentName: string | null;
  conversationId: string | null;
  previousConversationId?: string | null;
  reason: "startup" | "new" | "resume" | "fork";
}
```

`conversation_close` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  durationMs: number | null;
  messageCount: number | null;
  reason: "quit" | "new" | "resume" | "fork";
  toolCallCount: number | null;
}
```

`turn_start` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  input: Array<MessageCreate | ApprovalCreate>;
}
```

`tool_start` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  args: Record<string, unknown>;
}
```

`tool_start` fires immediately before a client-side tool executes. This includes built-in tools, mod tools, and external tools executed through the local tool manager. It runs after permission/approval classification and before `PreToolUse` hooks, so trusted local mods can change the actual executed arguments after the approval UI has already classified the original request. Mod permission overlays are rechecked after `tool_start` on the final args.

Handlers can inspect `event.args`, mutate it directly, or return replacement args:

```ts
letta.events.on("tool_start", (event) => {
  if (event.toolName !== "Bash") return;
  event.args = {
    ...event.args,
    command: String(event.args.command).replaceAll("npm test", "bun test"),
  };
});

letta.events.on("tool_start", (event) => {
  if (event.toolName !== "Read") return;
  return { args: { ...event.args, limit: 200 } };
});
```

Handlers run in registration order. Later handlers see the current args after earlier mutations/returns. If a handler throws, its partial `event.args` mutation is rolled back and the error is recorded as a mod diagnostic.

`tool_start` is intentionally a trusted local mod point: it can rewrite commands, file paths, and other tool inputs before execution. Keep transforms focused and unsurprising.

`tool_end` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  toolCallId: string | null;
  toolName: string;
  status: "success" | "error";
  output: string;
}
```

`tool_end` fires immediately after a tool produces a result, before the agent sees it. Handlers can inspect the result, or return `{ result: { status, output } }` to replace it:

```ts
letta.events.on("tool_end", (event) => {
  if (event.toolName !== "Bash" || event.status !== "success") return;
  return { result: { status: "success", output: redactSecrets(event.output) } };
});
```

The first handler that returns a `result` wins; later handlers are shadowed. Only string results are surfaced — multimodal/image results pass through unchanged. `tool_end` is the trusted-local-mod equivalent of the `PostToolUse` / `PostToolUseFailure` hooks for observing and rewriting tool results.

`turn_start` fires before outbound turns that include a user message. In the TUI this includes normal submits and prompt-style command turns. In headless it includes one-shot prompts and bidirectional user turns.

Handlers can mutate `event.input` directly or return replacement input:

```ts
function replaceTextContent(content, from, to) {
  if (typeof content === "string") return content.replaceAll(from, to);
  if (!Array.isArray(content)) return content;
  return content.map((part) =>
    part?.type === "text" && typeof part.text === "string"
      ? { ...part, text: part.text.replaceAll(from, to) }
      : part,
  );
}

letta.events.on("turn_start", (event) => {
  event.input = event.input.map((item) =>
    item.type !== "approval" && item.role === "user"
      ? { ...item, content: replaceTextContent(item.content, "??", new Date().toLocaleString()) }
      : item,
  );
});

letta.events.on("turn_start", (event) => {
  return { input: event.input };
});
```

Handlers run in registration order. Later handlers see the current input after earlier mutations/returns. If a handler throws, its partial `event.input` mutation is rolled back and the error is recorded as a mod diagnostic.

`turn_start` is intentionally a trusted local mod point: it can rewrite user messages, approval results, and ordering. Keep transforms focused and unsurprising.

Handlers also receive:

```ts
{
  conversation: {
    id: string | null;
    fork(options?): Promise<conversation>;
    getHistory(options?): Promise<Message[]>;
    sendMessageStream(messages, options?): Promise<AsyncIterable<chunk>>;
  };
  agent: ModContext["agent"];
  cwd: string;
  model: ModContext["model"];
  permissionMode: string | null;
  signal: AbortSignal;
}
```

`ctx` and `ctx.conversation` are bound when the event is dispatched. Use direct fields such as `ctx.agent`, `ctx.cwd`, `ctx.model`, and `ctx.permissionMode` for scoped state. If an event needs background model work, prefer `ctx.conversation.fork()` and send to the fork. Do not send to the active conversation from `turn_start`; that event is already in the path of sending a turn.

Respect `ctx.signal` for long-running async work. It is aborted on `/reload` and app shutdown.

## Conversation status example

```ts
export default function activate(letta) {
  if (!letta.capabilities.events.lifecycle) return;

  const disposers = [];

  disposers.push(
    letta.events.on("conversation_open", (event) => {
      letta.ui.setStatus("conversation", event.reason);
    }),
  );

  disposers.push(
    letta.events.on("conversation_close", (event) => {
      console.log(`conversation ${event.reason}: ${event.durationMs ?? 0}ms`);
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
    letta.ui.clearStatus("conversation");
  };
}
```

## Rules

- Do not block user flow unless the event's typed contract explicitly supports blocking.
- Do not use lifecycle events for safety decisions yet. Existing hooks still own blocking behavior.
- Catch expected local errors if the user-facing outcome matters. Uncaught errors are isolated and recorded as mod diagnostics.
- Return disposers from activation for event registrations, timers, subscriptions, and status values.
