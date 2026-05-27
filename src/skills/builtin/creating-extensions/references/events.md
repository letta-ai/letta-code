# Extension event recipes

Use events when trusted local code should react to app/session changes without the human explicitly invoking a command.

This is the first slice of the hooks-v2 direction. The long-term goal is for typed extension events to replace settings-based hooks. Existing hooks still own blocking decisions and model feedback injection until each event has a typed return contract.

## Capabilities

```ts
letta.capabilities.events.lifecycle
letta.capabilities.events.turns
```

Guard events when writing portable extensions:

```ts
export default function activate(letta) {
  if (!letta.capabilities.events.lifecycle) return;

  return letta.events.on("conversation_open", (event, ctx) => {
    console.log(`conversation ${event.reason}: ${event.agentName ?? event.agentId}`);
    console.log(`cwd: ${ctx.context.workspace.currentDir}`);
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

Future hook-replacement events should use this same API. For example, a future tool gate should look like:

```ts
letta.events.on("tool_call", (event, ctx) => {
  if (event.toolName !== "Bash") return;
  if (String(event.input.command).includes("rm -rf")) {
    return { block: true, reason: "Dangerous command" };
  }
});
```

Lifecycle and turn-start events are wired today, and existing settings-based hooks still own blocking behavior.

Lifecycle handlers are notification-only and should not return values. `turn_start` handlers can transform the outbound input for the next model turn.

## Supported events

```ts
"conversation_open"
"conversation_close"
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

Handlers run in registration order. Later handlers see the current input after earlier mutations/returns. If a handler throws, its partial `event.input` mutation is rolled back and the error is recorded as an extension diagnostic.

`turn_start` is intentionally a trusted local extension point: it can rewrite user messages, approval results, and ordering. Keep transforms focused and unsurprising.

Handlers also receive:

```ts
{
  backend?: letta.backend;
  context: letta.getContext();
  getContext: () => letta.getContext();
  signal: AbortSignal;
}
```

`ctx.backend` is bound when the event is dispatched. Use it for backend calls made while handling that event.

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
- Catch expected local errors if the user-facing outcome matters. Uncaught errors are isolated and recorded as extension diagnostics.
- Return disposers from activation for event registrations, timers, subscriptions, and status values.
