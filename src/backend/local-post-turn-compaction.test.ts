import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  ToolCall,
  Usage,
} from "@earendil-works/pi-ai";
import type { PiStreamFunction } from "@/backend/dev/pi-stream-adapter";
import { LocalBackend } from "@/backend/local/local-backend";
import {
  emptyLocalUsage,
  type LocalMessage,
} from "@/backend/local/local-message";
import type { LocalStore } from "@/backend/local/local-store";

// A 4,000-token window compacts above 3,200 tokens.
const CONTEXT_WINDOW = 4_000;
// About 1,000 tokens of conversation, under the threshold on its own.
const REQUEST = `Please inspect the logs. ${"context ".repeat(500)}`;
// Reported usage above the threshold.
const OVER_THRESHOLD: Partial<Usage> = { input: 3_500 };

type ProviderReply =
  | { calls: ToolCall[]; usage?: Partial<Usage> }
  | { text: string; usage?: Partial<Usage> };

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"],
  usage: Partial<Usage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: { ...emptyLocalUsage(), ...usage },
    stopReason,
    timestamp: Date.now(),
  };
}

function call(id: string): ToolCall {
  return { type: "toolCall", id, name: "Bash", arguments: { command: id } };
}

function streamOf(reply: ProviderReply): ReturnType<PiStreamFunction> {
  let events: AssistantMessageEvent[];
  let message: AssistantMessage;
  if ("calls" in reply) {
    message = assistant(reply.calls, "toolUse", reply.usage);
    events = [
      ...reply.calls.map(
        (toolCall, contentIndex): AssistantMessageEvent => ({
          type: "toolcall_end",
          contentIndex,
          toolCall,
          partial: message,
        }),
      ),
      { type: "done", reason: "toolUse", message },
    ];
  } else {
    message = assistant(
      [{ type: "text", text: reply.text }],
      "stop",
      reply.usage,
    );
    events = [{ type: "done", reason: "stop", message }];
  }
  async function* iterator() {
    for (const event of events) yield event;
  }
  return Object.assign(iterator(), { result: async () => message });
}

async function drain(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

/** Role and tool calls of a message; a stored compaction summary is "summary". */
function label(message: Message | LocalMessage): string {
  if ("metadata" in message && message.metadata?.compaction) return "summary";
  if (message.role === "toolResult") return `toolResult:${message.toolCallId}`;
  if (message.role !== "assistant") return "user";
  const ids = message.content.flatMap((part) =>
    part.type === "toolCall" ? [part.id] : [],
  );
  return ids.length > 0 ? `assistant:${ids.join(",")}` : "assistant";
}

function shape(context: Context | undefined): string[] {
  return (context?.messages ?? []).map(label);
}

function requestText(context: Context | undefined): string {
  return JSON.stringify(context?.messages ?? []);
}

async function withBackend(
  options: { mode: "all" | "self_compact_all"; replies: ProviderReply[] },
  run: (harness: Awaited<ReturnType<typeof setup>>) => Promise<void>,
): Promise<void> {
  const harness = await setup(options);
  try {
    await run(harness);
  } finally {
    await rm(harness.storageDir, { recursive: true, force: true });
  }
}

async function setup(options: {
  mode: "all" | "self_compact_all";
  replies: ProviderReply[];
}) {
  const storageDir = await mkdtemp(join(tmpdir(), "local-post-turn-"));
  const providerRequests: Context[] = [];
  const compactionRequests: Context[] = [];
  const backend = new LocalBackend({
    storageDir,
    memfsEnabled: false,
    stream: (_model, context) => {
      providerRequests.push(context);
      const reply = options.replies.shift();
      if (!reply) throw new Error("Unexpected provider request");
      return streamOf(reply);
    },
    complete: async (_model, context) => {
      compactionRequests.push(context);
      return assistant(
        [{ type: "text", text: `Summary ${compactionRequests.length}.` }],
        "stop",
      );
    },
  });
  const agent = await backend.createAgent({
    name: "Post Turn",
    system: "You are a test agent.",
    model: "openai/gpt-5.5",
    model_settings: {
      provider_type: "openai",
      context_window_limit: CONTEXT_WINDOW,
    },
    compaction_settings: {
      mode: options.mode,
      prompt: "Summarize the conversation now.",
    },
  } as never);
  const conversation = await backend.createConversation({
    agent_id: agent.id,
  } as never);
  const clientTools = [
    {
      name: "Bash",
      description: "Run a command",
      parameters: { type: "object", properties: {} },
    },
  ];
  const store = (backend as unknown as { store: LocalStore }).store;
  return {
    storageDir,
    providerRequests,
    compactionRequests,
    async send(content: string) {
      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [{ role: "user", content }],
          client_tools: clientTools,
        } as never),
      );
    },
    async returnResults(results: Record<string, string>) {
      await drain(
        await backend.createConversationMessageStream(conversation.id, {
          agent_id: agent.id,
          messages: [
            {
              type: "approval",
              approvals: Object.entries(results).map(
                ([toolCallId, toolReturn]) => ({
                  type: "tool",
                  tool_call_id: toolCallId,
                  status: "success",
                  tool_return: toolReturn,
                }),
              ),
            },
          ],
          client_tools: clientTools,
        } as never),
      );
    },
    storedShape() {
      return store.listLocalMessages(conversation.id, agent.id).map(label);
    },
  };
}

describe("local post-turn compaction", () => {
  test("waits for the tool results before compacting", async () => {
    await withBackend(
      {
        mode: "all",
        replies: [
          { calls: [call("call-1")], usage: OVER_THRESHOLD },
          { text: "Done." },
        ],
      },
      async (harness) => {
        await harness.send(REQUEST);

        // The reply is over the threshold, but its call has no result yet.
        expect(harness.compactionRequests).toHaveLength(0);
        expect(harness.storedShape()).toEqual(["user", "assistant:call-1"]);

        // The request that carries the result compacts before it is sent.
        await harness.returnResults({ "call-1": "short output" });
        expect(harness.compactionRequests).toHaveLength(1);
        const transcript = requestText(harness.compactionRequests[0]);
        expect(transcript).toContain("Please inspect the logs.");
        expect(transcript).toContain("short output");
        expect(shape(harness.providerRequests[1])).toEqual(["user"]);
        expect(requestText(harness.providerRequests[1])).toContain(
          "Summary 1.",
        );
        expect(harness.storedShape()).toEqual(["summary", "assistant"]);
      },
    );
  });

  test("self-compaction continues the agent's context", async () => {
    await withBackend(
      {
        mode: "self_compact_all",
        replies: [
          { calls: [call("call-1")], usage: OVER_THRESHOLD },
          { text: "Done." },
        ],
      },
      async (harness) => {
        await harness.send(REQUEST);
        await harness.returnResults({ "call-1": "short output" });

        expect(harness.compactionRequests).toHaveLength(1);
        const [compaction] = harness.compactionRequests;
        const [first] = harness.providerRequests;
        expect(compaction?.systemPrompt).toBe(first?.systemPrompt);
        expect(compaction?.tools).toEqual(first?.tools);
        // The request that produced the call, then the call, its result and
        // the compaction prompt.
        const firstMessages = first?.messages ?? [];
        expect(compaction?.messages.slice(0, firstMessages.length)).toEqual(
          firstMessages,
        );
        expect(shape(compaction)).toEqual([
          ...shape(first),
          "assistant:call-1",
          "toolResult:call-1",
          "user",
        ]);
        expect(compaction?.messages[firstMessages.length]).toMatchObject({
          role: "assistant",
          content: [call("call-1")],
        });
        expect(compaction?.messages.at(-1)).toMatchObject({
          content: "Summarize the conversation now.",
        });

        // The next request holds only the summary.
        expect(shape(harness.providerRequests[1])).toEqual(["user"]);
        expect(requestText(harness.providerRequests[1])).toContain(
          "Summary 1.",
        );
      },
    );
  });

  test("a final text reply over the threshold still compacts after the turn", async () => {
    await withBackend(
      {
        mode: "all",
        replies: [{ text: "All done.", usage: OVER_THRESHOLD }],
      },
      async (harness) => {
        await harness.send(REQUEST);

        expect(harness.compactionRequests).toHaveLength(1);
        expect(requestText(harness.compactionRequests[0])).toContain(
          "All done.",
        );
        expect(harness.storedShape()).toEqual(["summary"]);
      },
    );
  });
});
