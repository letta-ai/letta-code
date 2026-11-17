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

// A 4,000-token window compacts above 3,200 estimated tokens.
const CONTEXT_WINDOW = 4_000;
// About 1,000 tokens of earlier conversation to summarise.
const EARLIER_REQUEST = `Please inspect the logs. ${"context ".repeat(500)}`;
// About 2,500 tokens: crosses the threshold, but fits the budget on its own.
const LARGE_OUTPUT = "L".repeat(10_000);

type ProviderReply =
  | { calls: ToolCall[]; usage?: Partial<Usage> }
  | { text: string }
  | { error: string };

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
  if ("error" in reply) {
    message = { ...assistant([], "error"), errorMessage: reply.error };
    events = [{ type: "error", reason: "error", error: message }];
  } else if ("calls" in reply) {
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
    message = assistant([{ type: "text", text: reply.text }], "stop");
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

async function setup(options: {
  mode: "all" | "self_compact_all" | "sliding_window";
  replies: ProviderReply[];
  summaries?: string[];
}) {
  const storageDir = await mkdtemp(join(tmpdir(), "local-tool-exchange-"));
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
      const summaries = options.summaries ?? [];
      const text =
        summaries[compactionRequests.length - 1] ??
        `Summary ${compactionRequests.length}.`;
      return assistant([{ type: "text", text }], "stop");
    },
  });
  const agent = await backend.createAgent({
    name: "Tool Exchange",
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
    backend,
    agentId: agent.id,
    conversationId: conversation.id,
    providerRequests,
    compactionRequests,
    store,
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

type Harness = Awaited<ReturnType<typeof setup>>;

async function withHarness(
  options: Parameters<typeof setup>[0],
  run: (harness: Harness) => Promise<void>,
): Promise<void> {
  const harness = await setup(options);
  try {
    await run(harness);
  } finally {
    await rm(harness.storageDir, { recursive: true, force: true });
  }
}

describe("local compaction keeps the latest tool exchange", () => {
  test("preflight compaction keeps a completed exchange after the summary", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [{ calls: [call("call-1")] }, { text: "Done." }],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        await harness.returnResults({ "call-1": LARGE_OUTPUT });

        // The request after the tool ran: system prompt, summary, call, result.
        const next = harness.providerRequests[1];
        expect(next?.systemPrompt).toContain("You are a test agent.");
        expect(shape(next)).toEqual([
          "user",
          "assistant:call-1",
          "toolResult:call-1",
        ]);
        expect(requestText(next)).toContain("Summary 1.");
        expect(requestText(next)).toContain(LARGE_OUTPUT);

        // Only the messages before the exchange were summarised.
        expect(harness.compactionRequests).toHaveLength(1);
        const transcript = requestText(harness.compactionRequests[0]);
        expect(transcript).toContain("Please inspect the logs.");
        expect(transcript).not.toContain("LLLL");

        // Stored and in-context order: summary, call, result, then the reply.
        const expected = [
          "summary",
          "assistant:call-1",
          "toolResult:call-1",
          "assistant",
        ];
        expect(harness.storedShape()).toEqual(expected);
        const conversation = harness.store.retrieveConversation(
          harness.conversationId,
          harness.agentId,
        ) as unknown as { in_context_message_ids: string[] };
        expect(conversation.in_context_message_ids).toEqual(
          harness.store
            .listLocalMessages(harness.conversationId, harness.agentId)
            .map((message) => message.id),
        );

        // The same order comes back from disk.
        const reloaded = new LocalBackend({
          storageDir: harness.storageDir,
          memfsEnabled: false,
        });
        const reloadedStore = (reloaded as unknown as { store: LocalStore })
          .store;
        expect(
          reloadedStore
            .listLocalMessages(harness.conversationId, harness.agentId)
            .map((message) => message.id),
        ).toEqual(conversation.in_context_message_ids);
      },
    );
  });

  test("keeps every call and result of a parallel exchange", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [
          { calls: [call("call-a"), call("call-b")] },
          { text: "Done." },
        ],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        await harness.returnResults({
          "call-b": "B".repeat(5_000),
          "call-a": "A".repeat(5_000),
        });

        expect(harness.compactionRequests).toHaveLength(1);
        expect(shape(harness.providerRequests[1])).toEqual([
          "user",
          "assistant:call-a,call-b",
          "toolResult:call-b",
          "toolResult:call-a",
        ]);
        expect(harness.storedShape().slice(0, 4)).toEqual([
          "summary",
          "assistant:call-a,call-b",
          "toolResult:call-b",
          "toolResult:call-a",
        ]);
      },
    );
  });

  test("summarises everything when the exchange alone is over the budget", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [{ calls: [call("call-1")] }, { text: "Done." }],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        await harness.returnResults({ "call-1": "L".repeat(14_000) });

        expect(harness.compactionRequests).toHaveLength(1);
        expect(requestText(harness.compactionRequests[0])).toContain(
          "[truncated",
        );
        expect(shape(harness.providerRequests[1])).toEqual(["user"]);
        expect(harness.storedShape()).toEqual(["summary", "assistant"]);
      },
    );
  });

  test("summarises everything when the summary and the exchange are over the budget", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [{ calls: [call("call-1")] }, { text: "Done." }],
        // About 750 tokens: with the 2,500-token exchange, over the budget.
        summaries: ["S".repeat(3_000), "Short summary."],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        await harness.returnResults({ "call-1": LARGE_OUTPUT });

        expect(harness.compactionRequests).toHaveLength(2);
        expect(requestText(harness.compactionRequests[0])).not.toContain(
          "LLLL",
        );
        expect(requestText(harness.compactionRequests[1])).toContain("LLLL");
        expect(shape(harness.providerRequests[1])).toEqual(["user"]);
        expect(requestText(harness.providerRequests[1])).toContain(
          "Short summary.",
        );
      },
    );
  });

  test("post-turn compaction keeps only the pending call", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [
          // Reported usage above the 3,200-token threshold.
          { calls: [call("call-1")], usage: { input: 3_500 } },
          { text: "Done." },
        ],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);

        expect(harness.compactionRequests).toHaveLength(1);
        expect(requestText(harness.compactionRequests[0])).toContain(
          "Please inspect the logs.",
        );
        expect(harness.storedShape()).toEqual(["summary", "assistant:call-1"]);

        await harness.returnResults({ "call-1": "short output" });
        expect(harness.compactionRequests).toHaveLength(1);
        expect(shape(harness.providerRequests[1])).toEqual([
          "user",
          "assistant:call-1",
          "toolResult:call-1",
        ]);
      },
    );
  });

  test("a provider overflow after keeping the exchange summarises the exchange too", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [
          { calls: [call("call-1")] },
          { error: "prompt is too long: 5000 tokens > 4000 maximum" },
          { text: "Done." },
        ],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        await harness.returnResults({ "call-1": LARGE_OUTPUT });

        expect(harness.providerRequests.map(shape)).toEqual([
          ["user"],
          ["user", "assistant:call-1", "toolResult:call-1"],
          ["user"],
        ]);
        expect(harness.compactionRequests).toHaveLength(2);
        const overflowTranscript = requestText(harness.compactionRequests[1]);
        expect(overflowTranscript).toContain("Summary 1.");
        expect(overflowTranscript).toContain("LLLL");
        expect(requestText(harness.providerRequests[2])).toContain(
          "Summary 2.",
        );
        expect(harness.storedShape()).toEqual(["summary", "assistant"]);
      },
    );
  });

  test("the sliding-window fallback to a full summary keeps the exchange too", async () => {
    await withHarness(
      {
        mode: "sliding_window",
        replies: [{ calls: [call("call-1")] }, { text: "Done." }],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        // Three messages are too few for a sliding window: full summary.
        await harness.returnResults({ "call-1": LARGE_OUTPUT });

        expect(harness.compactionRequests).toHaveLength(1);
        expect(harness.compactionRequests[0]?.systemPrompt).toBe(
          "Summarize the conversation now.",
        );
        expect(shape(harness.providerRequests[1])).toEqual([
          "user",
          "assistant:call-1",
          "toolResult:call-1",
        ]);
      },
    );
  });

  test("manual compaction summarises a trailing exchange", async () => {
    await withHarness(
      {
        mode: "all",
        replies: [
          { calls: [call("call-1")] },
          { error: "400 invalid_request_error: bad request" },
        ],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        // The model call after the result fails, so the result is last.
        await harness.returnResults({ "call-1": "short output" });
        expect(harness.storedShape()).toEqual([
          "user",
          "assistant:call-1",
          "toolResult:call-1",
        ]);

        const result = await harness.backend.compactConversationMessages(
          harness.conversationId,
          { agent_id: harness.agentId } as never,
        );
        expect(result).toMatchObject({
          num_messages_before: 3,
          num_messages_after: 1,
        });
        expect(harness.storedShape()).toEqual(["summary"]);
      },
    );
  });

  test("self-compaction summarises the request that produced the kept call", async () => {
    await withHarness(
      {
        mode: "self_compact_all",
        replies: [
          { calls: [call("call-1")] },
          { calls: [call("call-2")] },
          { text: "Done." },
        ],
      },
      async (harness) => {
        await harness.send(EARLIER_REQUEST);
        await harness.returnResults({ "call-1": "short output" });
        expect(harness.compactionRequests).toHaveLength(0);
        await harness.returnResults({ "call-2": LARGE_OUTPUT });

        expect(harness.compactionRequests).toHaveLength(1);
        const [compaction] = harness.compactionRequests;
        expect(compaction?.systemPrompt).toContain("You are a test agent.");
        expect(compaction?.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
        // The request that produced call-2, the acknowledgement, the prompt.
        expect(shape(compaction)).toEqual([
          ...shape(harness.providerRequests[1]),
          "assistant",
          "user",
        ]);
        expect(compaction?.messages.at(-1)).toMatchObject({
          content: "Summarize the conversation now.",
        });
        expect(requestText(compaction)).not.toContain("LLLL");

        expect(shape(harness.providerRequests[2])).toEqual([
          "user",
          "assistant:call-2",
          "toolResult:call-2",
        ]);
      },
    );
  });
});
