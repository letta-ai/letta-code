import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, Tool } from "@earendil-works/pi-ai";
import { Type } from "@earendil-works/pi-ai";
import { createOrUpdateLocalProvider } from "@/backend/local/local-provider-auth-store";
import {
  LOCAL_ALL_COMPACTION_PROMPT,
  LOCAL_SELF_ALL_COMPACTION_PROMPT,
  type LocalAllCompactionInput,
  summarizeLocalMessagesAll,
} from "./compaction";
import { emptyLocalUsage, type LocalMessage } from "./local-message";

const TOOLS: Tool[] = [
  {
    name: "Bash",
    description: "Run a command",
    parameters: Type.Object({ command: Type.String() }),
  },
];

function assistant(
  content: AssistantMessage["content"],
): AssistantMessage & { id: string } {
  return {
    id: `assistant-${Math.random()}`,
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4.1",
    usage: emptyLocalUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

const TOOL_TURN: LocalMessage[] = [
  {
    id: "user-1",
    role: "user",
    content: "fix the failing test",
    timestamp: Date.now(),
  },
  assistant([
    {
      type: "toolCall",
      id: "call-1",
      name: "Bash",
      arguments: { command: "bun test" },
    },
  ]),
  {
    id: "result-1",
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "Bash",
    content: [{ type: "text", text: "1 fail" }],
    isError: false,
    timestamp: Date.now(),
  },
];

describe("self-compaction", () => {
  let storageDir: string;

  beforeAll(async () => {
    storageDir = await mkdtemp(join(tmpdir(), "local-self-compaction-"));
    await createOrUpdateLocalProvider({
      storageDir,
      providerType: "openai",
      providerName: "lc-openai",
      apiKey: "sk-unused-test-key",
    });
  });

  afterAll(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  async function summarize(
    messages: LocalMessage[],
    replies: Array<AssistantMessage | Error>,
    overrides: Partial<LocalAllCompactionInput> = {},
  ): Promise<{ summary: string; contexts: Context[] }> {
    const contexts: Context[] = [];
    const summary = await summarizeLocalMessagesAll({
      conversationId: "conv-self",
      agent: {
        id: "agent-local-self",
        name: "Self",
        description: null,
        system: "raw system",
        tags: [],
        model: "openai/gpt-4.1",
        model_settings: { provider_type: "openai" },
      },
      messages,
      localProviderAuthStorageDir: storageDir,
      self: { systemPrompt: "compiled agent system", tools: TOOLS },
      complete: async (_model, context) => {
        contexts.push(context);
        const reply = replies.shift();
        if (!reply) throw new Error("unexpected summary request");
        if (reply instanceof Error) throw reply;
        return reply;
      },
      ...overrides,
    });
    return { summary, contexts };
  }

  test("summarizes inside the agent's own context and tools", async () => {
    const { summary, contexts } = await summarize(TOOL_TURN, [
      assistant([{ type: "text", text: "self summary" }]),
    ]);

    expect(summary).toBe("self summary");
    expect(contexts).toHaveLength(1);
    const [context] = contexts;
    expect(context?.systemPrompt).toBe("compiled agent system");
    expect(context?.tools?.map((tool) => tool.name)).toEqual(["Bash"]);
    expect(context?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "user",
    ]);
    expect(context?.messages.at(-2)).toMatchObject({
      content: [{ type: "text", text: "I understand. Let me summarize." }],
    });
    expect(context?.messages.at(-1)).toMatchObject({
      content: LOCAL_SELF_ALL_COMPACTION_PROMPT,
    });
  });

  test("uses a custom prompt as the final message after a trailing assistant reply", async () => {
    const messages: LocalMessage[] = [
      TOOL_TURN[0] as LocalMessage,
      assistant([{ type: "text", text: "done" }]),
    ];
    const { contexts } = await summarize(
      messages,
      [assistant([{ type: "text", text: "self summary" }])],
      { prompt: "Summarize for the next session." },
    );

    expect(contexts[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(contexts[0]?.messages.at(-1)).toMatchObject({
      content: "Summarize for the next session.",
    });
  });

  test("falls back to a transcript summary when the self request overflows", async () => {
    const { summary, contexts } = await summarize(TOOL_TURN, [
      new Error("This model's maximum context length is 1000 tokens."),
      assistant([{ type: "text", text: "transcript summary" }]),
    ]);

    expect(summary).toBe("transcript summary");
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.systemPrompt).toBe(LOCAL_ALL_COMPACTION_PROMPT);
    expect(contexts[1]?.tools).toBeUndefined();
    expect(contexts[1]?.messages).toHaveLength(1);
    expect(contexts[1]?.messages[0]).toMatchObject({
      role: "user",
      content: expect.stringContaining("fix the failing test"),
    });
  });

  test("falls back to a transcript summary when the model calls a tool instead", async () => {
    const { summary, contexts } = await summarize(TOOL_TURN, [
      assistant([
        {
          type: "toolCall",
          id: "call-2",
          name: "Bash",
          arguments: { command: "ls" },
        },
      ]),
      assistant([{ type: "text", text: "transcript summary" }]),
    ]);

    expect(summary).toBe("transcript summary");
    expect(contexts).toHaveLength(2);
    expect(contexts[1]?.systemPrompt).toBe(LOCAL_ALL_COMPACTION_PROMPT);
  });

  test("without a self context, summarizes the transcript as before", async () => {
    const { contexts } = await summarize(
      TOOL_TURN,
      [assistant([{ type: "text", text: "transcript summary" }])],
      { self: undefined },
    );

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.systemPrompt).toBe(LOCAL_ALL_COMPACTION_PROMPT);
  });
});
