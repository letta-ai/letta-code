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
letta.capabilities.events.compact
letta.capabilities.events.llm
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

Lifecycle, turn, tool, compaction, and llm events are wired today.

Lifecycle handlers are notification-only and should not return values. `turn_start` handlers can transform or cancel outbound user-message turns. `tool_start` handlers can transform the tool arguments before execution. Compaction and llm handlers are notification-only.

`compact_start`/`compact_end` and `llm_start`/`llm_end` only fire on the **local backend**, where compaction and provider requests run client-side. On the constellation backend that work happens server-side and these events do not fire, so guard with `letta.capabilities.events.compact` / `letta.capabilities.events.llm` for portable mods.

## Supported events

```ts
"conversation_open"
"conversation_close"
"tool_start"
"tool_end"
"turn_start"
"compact_start"
"compact_end"
"llm_start"
"llm_end"
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
  args: Record<string, unknown>;
  status: "success" | "error";
  output: string;
}
```

`tool_end` fires immediately after a tool produces a result, before the agent sees it. `event.args` contains the effective tool invocation arguments after `tool_start` transforms, so handlers can react to the specific file, command, query, etc. Handlers can inspect the result, or return `{ result: { status, output } }` to replace it:

```ts
letta.events.on("tool_end", (event) => {
  if (event.toolName !== "Bash" || event.status !== "success") return;
  if (typeof event.args.command !== "string") return;
  return { result: { status: "success", output: redactSecrets(event.output) } };
});
```

The first handler that returns a `result` wins; later handlers are shadowed. Only string results are surfaced — multimodal/image results pass through unchanged. `tool_end` is the trusted-local-mod equivalent of the `PostToolUse` / `PostToolUseFailure` hooks for observing and rewriting tool results.

A handler can also react to a specific tool completing by adjusting conversation state. For example, switch model and reasoning effort when entering and exiting plan mode (`tool_end` fires only after the tool succeeds, so a denied approval won't switch):

```ts
letta.events.on("tool_end", async (event, ctx) => {
  if (event.status !== "success") return;
  if (event.toolName === "enter_plan_mode") {
    await ctx.conversation.updateLlmConfig({ model: "anthropic/claude-opus-4-8", reasoningEffort: "high" });
  } else if (event.toolName === "exit_plan_mode") {
    await ctx.conversation.updateLlmConfig({ model: "openai/gpt-5.5", reasoningEffort: "max" });
  }
});
```

`turn_start` fires before outbound turns that include a user message. In the TUI this includes normal submits and prompt-style command turns. In headless it includes one-shot prompts and bidirectional user turns. Listener/Desktop skips approval-only continuations so mods do not rewrite approval payloads; do not rely on `turn_start` to block approval-only continuations on every surface.

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

Handlers can also cancel a user-message turn before it reaches the backend/model:

```ts
letta.events.on("turn_start", (event) => {
  if (!isPlanModeActive(event.conversationId)) {
    return { cancel: { reason: "Run /plan first." } };
  }
});
```

If multiple handlers cancel, the first valid cancel reason wins. A valid reason is a non-empty string after trimming. Cancellation does not synthesize an assistant response or tool result; it only tells the host not to submit this turn.

Handlers run in registration order. Later handlers see the current input after earlier mutations/returns. If a handler throws, its partial `event.input` mutation is rolled back and the error is recorded as a mod diagnostic.

`turn_start` is intentionally a trusted local mod point: it can rewrite user messages, approval results, and ordering. Keep transforms focused and unsurprising.

`compact_start` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  trigger: "manual" | "context_window_overflow" | "context_window_limit";
}
```

`compact_start` fires before the local backend compacts a conversation, while the full message history is still in context. `trigger` distinguishes a manual `/compact` from the two automatic triggers (provider context-window overflow, and exceeding the configured context window). Use it to checkpoint state before eviction.

`compact_end` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  trigger: "manual" | "context_window_overflow" | "context_window_limit";
  messagesBefore: number;
  messagesAfter: number;
  contextTokensBefore: number;
  contextTokensAfter: number;
}
```

`compact_end` fires after compaction completes, carrying the before/after message and context-token counts. Both events are notification-only; return values are ignored. A throwing handler is isolated and never breaks compaction.

`llm_start` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  model: string;
  messageCount: number;
  contextWindow: number;
}
```

`llm_start` fires right before each provider request, with the model handle, the number of messages being sent, and the model's context window. It fires once per provider request, so a retry or an overflow-triggered re-request emits another `llm_start`.

`llm_end` event:

```ts
{
  agentId: string | null;
  conversationId: string | null;
  model: string;
  stopReason: string;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  } | null;
  durationMs: number;
  error?: {
    message: string;
    detail: string;
    errorType: "llm_error" | "local_backend_error";
    retryable: boolean;
  };
}
```

`llm_end` fires when a provider request ends, success or failure. Successful requests include token usage. Requests that fail before usage is available set `usage: null` and include `error`. Retry/failover effects are not supported yet; both events are notification-only and return values are ignored. A throwing handler is isolated and never breaks the provider request.

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
  let conversation = "";

  if (letta.capabilities.ui.panels) {
    const panel = letta.ui.openPanel({
      id: "conversation",
      order: 100,
      render: ({ width, row }) => row("conversation", conversation, width),
    });
    disposers.push(() => panel.close());

    disposers.push(
      letta.events.on("conversation_open", (event) => {
        conversation = event.reason;
        panel.update();
      }),
    );
  }

  disposers.push(
    letta.events.on("conversation_close", (event) => {
      console.log(`conversation ${event.reason}: ${event.durationMs ?? 0}ms`);
    }),
  );

  return () => {
    for (const dispose of disposers.reverse()) dispose();
  };
}
```

## Rules

- Do not block user flow unless the event's typed contract explicitly supports blocking.
- Do not use lifecycle events for safety decisions yet. Existing hooks still own blocking behavior.
- Catch expected local errors if the user-facing outcome matters. Uncaught errors are isolated and recorded as mod diagnostics.
- Return disposers from activation for event registrations, timers, subscriptions, and status values.
