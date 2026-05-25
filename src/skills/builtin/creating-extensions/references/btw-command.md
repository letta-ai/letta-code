# `/btw` side-question extension example

This example runs while the main agent is busy because it forks the conversation, uses the SDK directly, renders progress in a panel when panels are available, and returns `{ type: "handled" }` immediately.

```ts
export default function activate(letta) {
  if (!letta.capabilities.commands) return;

  function appendAssistantText(chunk, parts) {
    if (chunk.message_type !== "assistant_message") return;
    const content = chunk.content;
    if (typeof content === "string") {
      parts.push(content);
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part && typeof part === "object" && "text" in part) {
          parts.push(String(part.text));
        }
      }
    }
  }

  function openPanelOrNull(content) {
    if (!letta.capabilities.ui.panels) return null;
    return letta.ui.openPanel({ id: "btw", content });
  }

  return letta.commands.register({
    id: "btw",
    description: "Ask a side question in a forked conversation",
    args: "<question>",
    runWhenBusy: true,
    showInTranscript: false,
    run(ctx) {
      const question = ctx.args.trim();
      if (!question) {
        const panel = openPanelOrNull(["/btw", "Usage: /btw <question>"]);
        if (panel) setTimeout(() => panel.close(), 5_000);
        return { type: "handled" };
      }

      const panel = openPanelOrNull([`/btw ${question}`, "..."]);

      void (async () => {
        try {
          const forked = await letta.client.conversations.fork(
            ctx.conversation.id || "default",
            { agent_id: ctx.agent.id },
          );
          const stream = await letta.client.conversations.messages.create(
            forked.id,
            {
              agent_id: ctx.agent.id,
              input: `${question}

Answer briefly in 1-3 short sentences.`,
              streaming: true,
            },
          );

          const parts = [];
          for await (const chunk of stream) {
            appendAssistantText(chunk, parts);
            panel?.update({ content: [`/btw ${question}`, parts.join("") || "..."] });
          }

          panel?.update({
            content: [`done /btw ${question}`, parts.join("").trim() || "No response."],
          });
          if (panel) setTimeout(() => panel.close(), 10_000);
        } catch (error) {
          panel?.update({
            content: [
              `error /btw ${question}`,
              error instanceof Error ? error.message : String(error),
            ],
          });
          if (panel) setTimeout(() => panel.close(), 15_000);
        }
      })();

      return { type: "handled" };
    },
  });
}
```

Add custom borders, right alignment, wrapping, or history only if the user asks for that polish.
