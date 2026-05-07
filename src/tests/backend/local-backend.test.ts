import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  TextStreamPart,
  ToolSet,
  UIMessageChunk,
} from "ai";
import { APICallError } from "ai";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
  ConversationMessageListBody,
  RunMessageStreamBody,
} from "../../backend";
import {
  createAISDKModelFactoryFromAgent,
  resolveZaiConnection,
} from "../../backend/dev/AISDKModelFactory";
import {
  createOrUpdateLocalProvider,
  getLocalProviderAuthPath,
  LOCAL_ALL_COMPACTION_PROMPT,
  LocalBackend,
  listLocalModels,
  resolveLocalModelConfig,
  setLocalChatGPTOAuth,
} from "../../backend/local";
import type { LocalMessage } from "../../backend/local/LocalMessage";
import { projectLocalMessagesToStoredMessages } from "../../backend/local/LocalMessageProjection";
import { LocalStore } from "../../backend/local/LocalStore";
import { getLocalBackendMemoryFilesystemRoot } from "../../backend/local/paths";

async function withLocalModelEnv<T>(
  env: {
    openAIKey?: string;
    anthropicKey?: string;
    openRouterKey?: string;
    zaiKey?: string;
    zhipuKey?: string;
  },
  fn: () => T | Promise<T>,
): Promise<T> {
  const originalOpenAIKey = process.env.OPENAI_API_KEY;
  const originalAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
  const originalZaiKey = process.env.ZAI_API_KEY;
  const originalZhipuKey = process.env.ZHIPU_API_KEY;
  const originalMinimaxKey = process.env.MINIMAX_API_KEY;
  const originalMoonshotKey = process.env.MOONSHOT_API_KEY;
  try {
    if (env.openAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = env.openAIKey;
    if (env.anthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = env.anthropicKey;
    if (env.openRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = env.openRouterKey;
    if (env.zaiKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = env.zaiKey;
    if (env.zhipuKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = env.zhipuKey;
    delete process.env.MINIMAX_API_KEY;
    delete process.env.MOONSHOT_API_KEY;
    return await fn();
  } finally {
    if (originalOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAIKey;
    if (originalAnthropicKey === undefined)
      delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = originalAnthropicKey;
    if (originalOpenRouterKey === undefined)
      delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
    if (originalZaiKey === undefined) delete process.env.ZAI_API_KEY;
    else process.env.ZAI_API_KEY = originalZaiKey;
    if (originalZhipuKey === undefined) delete process.env.ZHIPU_API_KEY;
    else process.env.ZHIPU_API_KEY = originalZhipuKey;
    if (originalMinimaxKey === undefined) delete process.env.MINIMAX_API_KEY;
    else process.env.MINIMAX_API_KEY = originalMinimaxKey;
    if (originalMoonshotKey === undefined) delete process.env.MOONSHOT_API_KEY;
    else process.env.MOONSHOT_API_KEY = originalMoonshotKey;
  }
}

async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
}

async function collectStream(
  stream: AsyncIterable<LettaStreamingResponse>,
): Promise<LettaStreamingResponse[]> {
  const chunks: LettaStreamingResponse[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return chunks;
}

async function readPersistedLocalMessages(storageDir: string) {
  const conversationDirs = await readdir(join(storageDir, "conversations"));
  const messages = [] as Array<{ role?: string; parts?: unknown[] }>;
  for (const dir of conversationDirs) {
    const raw = await readFile(
      join(storageDir, "conversations", dir, "messages.jsonl"),
      "utf8",
    );
    messages.push(
      ...raw
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map(
          (line) => JSON.parse(line) as { role?: string; parts?: unknown[] },
        ),
    );
  }
  return messages;
}

async function readPersistedSystemPrompts(storageDir: string) {
  const conversationDirs = await readdir(join(storageDir, "conversations"));
  const prompts = [] as Array<{ content?: string; rawSystemHash?: string }>;
  for (const dir of conversationDirs) {
    try {
      prompts.push(
        JSON.parse(
          await readFile(
            join(storageDir, "conversations", dir, "system-prompt.json"),
            "utf8",
          ),
        ) as { content?: string; rawSystemHash?: string },
      );
    } catch {
      // Conversation may not have compiled yet.
    }
  }
  return prompts;
}

async function writeMemoryFile(
  memoryDir: string,
  relativePath: string,
  description: string,
  body: string,
) {
  const fullPath = join(memoryDir, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(
    fullPath,
    `---\ndescription: ${description}\n---\n${body}\n`,
    "utf8",
  );
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function initAndCommitMemory(memoryDir: string, message = "initial memory") {
  git(memoryDir, ["init"]);
  git(memoryDir, ["config", "user.email", "agent-local-test@letta.com"]);
  git(memoryDir, ["config", "user.name", "Local Test"]);
  git(memoryDir, ["add", "."]);
  git(memoryDir, ["commit", "-m", message]);
  return git(memoryDir, ["rev-parse", "HEAD"]);
}

function createBody(
  text: string,
  agentId: string,
): ConversationMessageCreateBody {
  return {
    messages: [{ role: "user", content: text }],
    streaming: true,
    stream_tokens: true,
    include_pings: true,
    background: true,
    client_tools: [],
    client_skills: [],
    agent_id: agentId,
  } as unknown as ConversationMessageCreateBody;
}

function uiMessageStream(
  chunks: UIMessageChunk[],
): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function modelUsage(
  inputTokens: number,
  outputTokens: number,
): LanguageModelUsage {
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: inputTokens,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: outputTokens,
      reasoningTokens: undefined,
    },
    totalTokens: inputTokens + outputTokens,
  };
}

type MockUIMessageStreamOptions = {
  originalMessages?: LocalMessage[];
  onFinish?: (options: {
    messages: LocalMessage[];
    responseMessage: LocalMessage;
    isContinuation: boolean;
    isAborted: boolean;
    finishReason?: unknown;
  }) => void | PromiseLike<void>;
};

function uiMessageStreamWithFinish(
  chunks: UIMessageChunk[],
  responseMessage:
    | LocalMessage
    | ((options: MockUIMessageStreamOptions | undefined) => LocalMessage),
  finishReason: unknown = "stop",
) {
  return (options?: MockUIMessageStreamOptions) => {
    const response =
      typeof responseMessage === "function"
        ? responseMessage(options)
        : responseMessage;
    const originalMessages = options?.originalMessages ?? [];
    const isContinuation = originalMessages.at(-1)?.id === response.id;
    void options?.onFinish?.({
      messages: isContinuation
        ? [...originalMessages.slice(0, -1), response]
        : [...originalMessages, response],
      responseMessage: response,
      isContinuation,
      isAborted: false,
      finishReason,
    });
    return uiMessageStream(chunks);
  };
}

describe("LocalBackend", () => {
  test("infers the default local provider from standard API keys", async () => {
    await withLocalModelEnv({ anthropicKey: "test-anthropic-key" }, () => {
      expect(resolveLocalModelConfig()).toMatchObject({
        provider: "anthropic",
        handle: "anthropic/claude-sonnet-4-6",
        modelSettings: { provider_type: "anthropic" },
      });
    });

    await withLocalModelEnv({ openAIKey: "test-openai-key" }, () => {
      expect(resolveLocalModelConfig()).toMatchObject({
        provider: "openai-responses",
        handle: "openai/gpt-5.5",
        modelSettings: { provider_type: "openai" },
      });
    });
  });

  test("lists local model catalog from models.json for configured providers", async () => {
    await withLocalModelEnv({ anthropicKey: "test-anthropic-key" }, () => {
      const handles = listLocalModels().map((model) => model.handle);
      expect(handles).toContain("anthropic/claude-opus-4-7");
      expect(handles).toContain("anthropic/claude-sonnet-4-6");
      expect(handles).not.toContain("openai/gpt-5.5");
    });

    await withLocalModelEnv({ openAIKey: "test-openai-key" }, () => {
      const handles = listLocalModels().map((model) => model.handle);
      expect(handles).toContain("openai/gpt-5.5");
      expect(handles).toContain("openai/gpt-5.3-codex");
      expect(handles).not.toContain("anthropic/claude-opus-4-7");
    });
  });

  test("lists models for locally connected providers", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-provider-auth-"));
    try {
      await withLocalModelEnv({}, async () => {
        await createOrUpdateLocalProvider({
          storageDir,
          providerType: "openrouter",
          providerName: "lc-openrouter",
          apiKey: "test-openrouter-key",
        });
        await createOrUpdateLocalProvider({
          storageDir,
          providerType: "zai",
          providerName: "lc-zai",
          apiKey: "test-zai-key",
        });
        await createOrUpdateLocalProvider({
          storageDir,
          providerType: "minimax",
          providerName: "lc-minimax",
          apiKey: "test-minimax-key",
        });
        await createOrUpdateLocalProvider({
          storageDir,
          providerType: "moonshot",
          providerName: "lc-moonshot",
          apiKey: "test-moonshot-key",
        });
        setLocalChatGPTOAuth(
          {
            type: "oauth",
            access: "test-access-token",
            refresh: "test-refresh-token",
            expires: Date.now() + 60_000,
            accountId: "test-account",
          },
          storageDir,
        );

        const authFile = await stat(getLocalProviderAuthPath(storageDir));
        expect(authFile.mode & 0o777).toBe(0o600);

        const handles = listLocalModels(storageDir).map(
          (model) => model.handle,
        );
        expect(handles).toContain("openrouter/deepseek/deepseek-v4-pro");
        expect(handles).toContain("zai/glm-5.1");
        expect(handles).toContain("minimax/MiniMax-M2.7");
        expect(handles).toContain("moonshot/kimi-k2.5");
        expect(handles).toContain("chatgpt-plus-pro/gpt-5.5");
        expect(handles).not.toContain("anthropic/claude-opus-4-7");

        const backend = new LocalBackend({
          storageDir,
          executionMode: "deterministic",
        });
        const backendModels = (await backend.listModels()) as Array<{
          handle: string;
          model_endpoint_type: string;
        }>;
        expect(backendModels.map((model) => model.handle)).toContain(
          "openrouter/deepseek/deepseek-v4-pro",
        );
        expect(backendModels).toContainEqual(
          expect.objectContaining({
            handle: "zai/glm-5.1",
            model_endpoint_type: "zai",
          }),
        );
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("resolves local AI SDK providers from model prefixes before generic settings", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-provider-factory-"));
    try {
      await createOrUpdateLocalProvider({
        storageDir,
        providerType: "openrouter",
        providerName: "lc-openrouter",
        apiKey: "test-openrouter-key",
      });

      let capturedModel: string | undefined;
      const factory = createAISDKModelFactoryFromAgent(
        "openrouter/deepseek/deepseek-v4-pro",
        { provider_type: "openai" },
        {
          localProviderAuthStorageDir: storageDir,
          createOpenAICompatibleModel: (model) => {
            capturedModel = model;
            return {} as LanguageModel;
          },
        },
      );

      factory();
      expect(capturedModel).toBe("deepseek/deepseek-v4-pro");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("uses Z.AI coding endpoint when only a coding-plan key is connected", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-zai-coding-"));
    try {
      await withLocalModelEnv({}, async () => {
        await createOrUpdateLocalProvider({
          storageDir,
          providerType: "zai_coding",
          providerName: "lc-zai-coding",
          apiKey: "test-zai-coding-key",
        });

        expect(
          resolveZaiConnection({
            storageDir,
            preferredProviderType: "zai_coding",
          }),
        ).toMatchObject({
          apiKey: "test-zai-coding-key",
          providerName: "zai-coding",
          baseURL: "https://api.z.ai/api/coding/paas/v4",
        });
      });
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("uses strict local flatfile semantics behind the real local entrypoint", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      expect(backend.capabilities).toEqual({
        remoteMemfs: false,
        serverSideToolManagement: false,
        serverSecrets: false,
        agentFileImportExport: false,
        promptRecompile: true,
        byokProviderRefresh: false,
        localModelCatalog: true,
        localMemfs: true,
      });

      await expect(backend.retrieveAgent("agent-missing")).rejects.toThrow(
        "Agent agent-missing not found",
      );

      const agent = await backend.createAgent({
        name: "Local Agent",
      } as AgentCreateBody);
      expect(agent.model).not.toContain("fake");
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      expect(conversation.id).toStartWith("local-conv-");
      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("hello local", agent.id),
        ),
      );

      const agentFiles = await readdir(join(storageDir, "agents"));
      expect(agentFiles).toHaveLength(1);
      const persistedAgent = JSON.parse(
        await readFile(join(storageDir, "agents", agentFiles[0] ?? ""), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(persistedAgent).sort()).toEqual([
        "description",
        "id",
        "model",
        "model_settings",
        "name",
        "system",
        "tags",
      ]);
      expect(persistedAgent.model).not.toContain("fake");

      const conversationDirs = await readdir(join(storageDir, "conversations"));
      expect(conversationDirs.length).toBeGreaterThan(0);
      const persistedMessageText = (
        await Promise.all(
          conversationDirs.map((dir) =>
            readFile(
              join(storageDir, "conversations", dir, "messages.jsonl"),
              "utf8",
            ),
          ),
        )
      ).join("\n");
      expect(persistedMessageText).toContain('"id":"ui-msg-');
      expect(persistedMessageText).not.toContain("fake-headless");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("defaults to the AI SDK executor for local turns", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-ai-sdk-"));
    try {
      let capturedSystem: string | undefined;
      let capturedMessages: ModelMessage[] | undefined;
      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        streamText: (options) => {
          capturedSystem = options.system;
          capturedMessages = options.messages;
          return {
            fullStream: (async function* () {
              yield {
                type: "text-delta",
                id: "text-1",
                text: "local ai",
              } as TextStreamPart<ToolSet>;
              yield {
                type: "finish",
                finishReason: "stop",
              } as TextStreamPart<ToolSet>;
            })(),
          };
        },
      });

      const agent = await backend.createAgent({
        name: "Local AI Agent",
        system: "local system",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const chunks: unknown[] = [];
      for await (const chunk of await backend.createConversationMessageStream(
        conversation.id,
        createBody("hello ai", agent.id),
      )) {
        chunks.push(chunk);
      }

      expect(capturedSystem).toContain("local system");
      expect(capturedSystem).toContain("<memory_metadata>");
      expect(capturedSystem).toContain(`- AGENT_ID: ${agent.id}`);
      expect(capturedSystem).toContain(`- CONVERSATION_ID: ${conversation.id}`);
      expect(capturedMessages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "hello ai" }],
        },
      ]);
      expect(JSON.stringify(chunks)).toContain("local ai");

      const runId = (chunks[0] as { run_id?: string } | undefined)?.run_id;
      expect(runId).toBe("local-run-1");
      const replayed = await collectStream(
        await backend.streamRunMessages(
          runId ?? "",
          {} as RunMessageStreamBody,
        ),
      );
      expect(replayed.map((chunk) => chunk.message_type)).toEqual(
        (chunks as LettaStreamingResponse[]).map((chunk) => chunk.message_type),
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("compacts local conversation history with the backend all-compaction prompt", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-compact-"));
    try {
      let capturedSystem: string | undefined;
      let capturedPrompt: string | undefined;
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
        generateText: (async (options: {
          system?: string;
          prompt?: string;
        }) => {
          capturedSystem = options.system;
          capturedPrompt = options.prompt;
          return { text: "manual local summary" } as never;
        }) as never,
      });

      const agent = await backend.createAgent({
        name: "Compact Agent",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("first request", agent.id),
        ),
      );
      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("second request", agent.id),
        ),
      );

      const result = (await backend.compactConversationMessages(
        conversation.id,
        {
          compaction_settings: { mode: "all" },
        } as never,
      )) as {
        num_messages_before: number;
        num_messages_after: number;
        summary: string;
      };

      expect(result).toEqual({
        num_messages_before: 4,
        num_messages_after: 1,
        summary: "manual local summary",
      });
      expect(capturedSystem).toBe(LOCAL_ALL_COMPACTION_PROMPT);
      expect(capturedPrompt).toContain("first request");
      expect(capturedPrompt).toContain("second request");

      const page = await backend.listConversationMessages(conversation.id, {
        order: "asc",
      } as ConversationMessageListBody);
      const messages = page.getPaginatedItems();
      expect(messages.map((message) => message.message_type)).toEqual([
        "summary_message",
      ]);
      expect(JSON.stringify(messages[0])).toContain("manual local summary");

      const persistedMessages = await readPersistedLocalMessages(storageDir);
      expect(persistedMessages).toHaveLength(1);
      expect(JSON.stringify(persistedMessages[0])).toContain("system_alert");
      expect(JSON.stringify(persistedMessages[0])).toContain(
        "manual local summary",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("auto-compacts and retries local AI SDK turns on context overflow", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-auto-compact-"),
    );
    try {
      let streamCalls = 0;
      let summaryPrompt: string | undefined;
      const modelMessagesByCall: ModelMessage[][] = [];
      const overflow = new APICallError({
        message: "context_length_exceeded: maximum context length exceeded",
        url: "https://example.invalid/v1/chat/completions",
        requestBodyValues: {},
        statusCode: 400,
        responseBody: "maximum context length exceeded",
        isRetryable: false,
      });
      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        generateText: (async (options: { prompt?: string }) => {
          summaryPrompt = options.prompt;
          return { text: "overflow local summary" } as never;
        }) as never,
        streamText: (options) => {
          streamCalls += 1;
          modelMessagesByCall.push(options.messages);

          if (streamCalls === 2) {
            return {
              fullStream: (async function* () {
                yield {
                  type: "error",
                  error: overflow,
                } as TextStreamPart<ToolSet>;
              })(),
            };
          }

          const text =
            streamCalls === 1 ? "first response" : "after compaction";
          return {
            fullStream: (async function* () {
              yield {
                type: "text-delta",
                id: `text-${streamCalls}`,
                text,
              } as TextStreamPart<ToolSet>;
              yield {
                type: "finish",
                finishReason: "stop",
              } as TextStreamPart<ToolSet>;
            })(),
            toUIMessageStream: uiMessageStreamWithFinish([], {
              id: `assistant-${streamCalls}`,
              role: "assistant",
              parts: [{ type: "text", text }],
            } as LocalMessage),
          };
        },
      });

      const agent = await backend.createAgent({
        name: "Auto Compact Agent",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("first request", agent.id),
        ),
      );

      const chunks = await collectStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("overflowing request", agent.id),
        ),
      );

      expect(streamCalls).toBe(3);
      expect(summaryPrompt).toContain("first request");
      expect(summaryPrompt).toContain("overflowing request");
      const chunkTypes = chunks.map((chunk) => chunk.message_type as string);
      expect(chunkTypes).toContain("event_message");
      expect(chunkTypes).toContain("summary_message");
      expect(JSON.stringify(chunks)).toContain("after compaction");
      expect(JSON.stringify(modelMessagesByCall[2])).toContain(
        "overflow local summary",
      );
      expect(JSON.stringify(modelMessagesByCall[2])).not.toContain(
        "first request",
      );

      const page = await backend.listConversationMessages(conversation.id, {
        order: "asc",
      } as ConversationMessageListBody);
      expect(
        page.getPaginatedItems().map((message) => message.message_type),
      ).toEqual(["summary_message", "assistant_message"]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("compacts after local AI SDK usage exceeds the configured context window", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-usage-compact-"),
    );
    try {
      let summaryPrompt: string | undefined;
      const usage = modelUsage(150, 12);
      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        generateText: (async (options: { prompt?: string }) => {
          summaryPrompt = options.prompt;
          return { text: "usage-triggered local summary" } as never;
        }) as never,
        streamText: () => {
          return {
            fullStream: (async function* () {
              yield {
                type: "text-delta",
                id: "usage-text",
                text: "limit response",
              } as TextStreamPart<ToolSet>;
              yield {
                type: "finish-step",
                response: {},
                usage,
                finishReason: "stop",
                rawFinishReason: "stop",
                providerMetadata: undefined,
              } as TextStreamPart<ToolSet>;
              yield {
                type: "finish",
                finishReason: "stop",
                rawFinishReason: "stop",
                totalUsage: usage,
              } as TextStreamPart<ToolSet>;
            })(),
            toUIMessageStream: uiMessageStreamWithFinish([], {
              id: "assistant-usage-limit",
              role: "assistant",
              parts: [{ type: "text", text: "limit response" }],
            } as LocalMessage),
          };
        },
      });

      const agent = await backend.createAgent({
        name: "Usage Compact Agent",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      await backend.updateConversation(conversation.id, {
        context_window_limit: 100,
      } as never);

      const chunks = await collectStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("limit trigger request", agent.id),
        ),
      );

      const usageChunk = chunks.find(
        (chunk) => chunk.message_type === "usage_statistics",
      ) as { context_tokens?: number; prompt_tokens?: number } | undefined;
      expect(usageChunk?.context_tokens).toBe(150);
      expect(usageChunk?.prompt_tokens).toBe(150);
      expect(summaryPrompt).toContain("limit trigger request");
      expect(summaryPrompt).toContain("limit response");
      expect(JSON.stringify(chunks)).toContain("context_window_limit");
      expect(JSON.stringify(chunks)).toContain("usage-triggered local summary");

      const page = await backend.listConversationMessages(conversation.id, {
        order: "asc",
      } as ConversationMessageListBody);
      const messages = page.getPaginatedItems();
      expect(messages.map((message) => message.message_type)).toEqual([
        "summary_message",
      ]);
      expect(JSON.stringify(messages[0])).toContain(
        "usage-triggered local summary",
      );
      expect(JSON.stringify(messages[0])).toContain('"context_window":100');
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("persists compiled system prompt snapshots and reuses them for turns", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-prompt-"));
    const memoryDir = await mkdtemp(join(tmpdir(), "local-backend-memory-"));
    try {
      await writeMemoryFile(
        memoryDir,
        "system/project.md",
        "Project memory",
        "Use local compiled memory.",
      );
      initAndCommitMemory(memoryDir);
      let capturedSystem: string | undefined;
      const backend = new LocalBackend({
        storageDir,
        memoryDir,
        createModel: () => ({}) as LanguageModel,
        streamText: (options) => {
          capturedSystem = options.system;
          return {
            fullStream: (async function* () {
              yield {
                type: "finish",
                finishReason: "stop",
              } as TextStreamPart<ToolSet>;
            })(),
          };
        },
      });

      const agent = await backend.createAgent({
        name: "Prompt Agent",
        system: "base {CORE_MEMORY}",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const promptsAfterCreate = await readPersistedSystemPrompts(storageDir);
      expect(
        promptsAfterCreate.some((prompt) =>
          prompt.content?.includes("Use local compiled memory."),
        ),
      ).toBe(true);

      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("hello compiled prompt", agent.id),
        ),
      );
      expect(capturedSystem).toContain("base Reminder: <projection>");
      expect(capturedSystem).toContain("Use local compiled memory.");
      expect(capturedSystem).toContain("<memory_metadata>");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
      await rm(memoryDir, { recursive: true, force: true });
    }
  });

  test("initializes local MemFS from memory blocks with an initial commit", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-memfs-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agent = await backend.createAgent({
        name: "MemFS Agent",
        system: "base {CORE_MEMORY}",
        memory_blocks: [
          {
            label: "persona",
            value: "Committed persona.",
            description: "Persona description",
          },
          {
            label: "human",
            value: "Committed human.",
            description: "Human description",
          },
          {
            label: "project/gotchas",
            value: "Committed project gotcha.",
            description: "Project gotchas",
          },
          {
            label: "style",
            value: "Committed style preference.",
            description: "Style preferences",
          },
        ],
      } as AgentCreateBody);
      const memoryDir = getLocalBackendMemoryFilesystemRoot(
        agent.id,
        storageDir,
      );

      expect(git(memoryDir, ["rev-parse", "--verify", "HEAD"])).toHaveLength(
        40,
      );
      expect(
        await readFile(join(memoryDir, "system", "persona.md"), "utf8"),
      ).toContain("Committed persona.");
      expect(
        await readFile(join(memoryDir, "system", "human.md"), "utf8"),
      ).toContain("Committed human.");
      expect(
        await readFile(
          join(memoryDir, "system", "project", "gotchas.md"),
          "utf8",
        ),
      ).toContain("Committed project gotcha.");
      expect(
        await readFile(join(memoryDir, "system", "style.md"), "utf8"),
      ).toContain("Committed style preference.");
      expect(git(memoryDir, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("initializes local MemFS with an empty commit when no blocks are provided", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-empty-memfs-"),
    );
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agent = await backend.createAgent({
        name: "Empty MemFS Agent",
        system: "base {CORE_MEMORY}",
      } as AgentCreateBody);
      const memoryDir = getLocalBackendMemoryFilesystemRoot(
        agent.id,
        storageDir,
      );

      expect(git(memoryDir, ["rev-parse", "--verify", "HEAD"])).toHaveLength(
        40,
      );
      expect(git(memoryDir, ["log", "-1", "--pretty=%s"])).toBe(
        "chore: initialize empty local memory",
      );
      expect(git(memoryDir, ["status", "--porcelain"])).toBe("");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("appends client skills per request without persisting them", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-skills-"));
    try {
      let capturedSystem: string | undefined;
      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        streamText: (options) => {
          capturedSystem = options.system;
          return {
            fullStream: (async function* () {
              yield {
                type: "finish",
                finishReason: "stop",
              } as TextStreamPart<ToolSet>;
            })(),
          };
        },
      });
      const agent = await backend.createAgent({
        name: "Skills Agent",
        system: "base {CORE_MEMORY}",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await drainStream(
        await backend.createConversationMessageStream(conversation.id, {
          ...createBody("hello skills", agent.id),
          client_skills: [
            {
              name: "pdf",
              description: "Read PDFs",
              location: "/repo/skills/pdf/SKILL.md",
            },
          ],
        } as unknown as ConversationMessageCreateBody),
      );

      expect(capturedSystem).toContain("<available_skills>");
      expect(capturedSystem).toContain("SKILL.md (Read PDFs)");
      const persistedPrompts = await readPersistedSystemPrompts(storageDir);
      expect(JSON.stringify(persistedPrompts)).not.toContain(
        "<available_skills>",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("recompiles local system prompt when committed MemFS revision changes", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-memfs-revision-"),
    );
    try {
      let capturedSystem = "";
      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        streamText: (options) => {
          capturedSystem = options.system ?? "";
          return {
            fullStream: (async function* () {
              yield {
                type: "finish",
                finishReason: "stop",
              } as TextStreamPart<ToolSet>;
            })(),
          };
        },
      });
      const agent = await backend.createAgent({
        name: "Revision Agent",
        system: "base {CORE_MEMORY}",
        model: "openai/gpt-test",
        memory_blocks: [
          {
            label: "persona",
            value: "First committed memory.",
            description: "Persona",
          },
        ],
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("first", agent.id),
        ),
      );
      expect(capturedSystem).toContain("First committed memory.");

      const memoryDir = getLocalBackendMemoryFilesystemRoot(
        agent.id,
        storageDir,
      );
      await writeMemoryFile(
        memoryDir,
        "system/persona.md",
        "Persona",
        "Second committed memory.",
      );
      git(memoryDir, ["add", "system/persona.md"]);
      git(memoryDir, ["commit", "-m", "update memory"]);

      await drainStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("second", agent.id),
        ),
      );
      expect(capturedSystem).toContain("Second committed memory.");
      expect(capturedSystem).not.toContain("First committed memory.");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("recompiles local system prompt after raw system changes", async () => {
    const storageDir = await mkdtemp(
      join(tmpdir(), "local-backend-recompile-"),
    );
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agent = await backend.createAgent({
        name: "Recompile Agent",
        system: "first {CORE_MEMORY}",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const first = await backend.recompileConversation(conversation.id, {
        agent_id: agent.id,
        dry_run: true,
      });
      expect(first).toContain("first");

      await backend.updateAgent(agent.id, { system: "second {CORE_MEMORY}" });
      const promptsAfterUpdate = await readPersistedSystemPrompts(storageDir);
      expect(JSON.stringify(promptsAfterUpdate)).not.toContain("first");

      const second = await backend.recompileConversation(conversation.id, {
        agent_id: agent.id,
        dry_run: false,
      });
      expect(second).toContain("second");
      const promptsAfterRecompile =
        await readPersistedSystemPrompts(storageDir);
      expect(JSON.stringify(promptsAfterRecompile)).toContain("second");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("persists local conversations across backend restarts", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-resume-"));
    try {
      const firstBackend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const agent = await firstBackend.createAgent({
        name: "Resume Agent",
      } as AgentCreateBody);
      const conversation = await firstBackend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      await drainStream(
        await firstBackend.createConversationMessageStream(
          conversation.id,
          createBody("remember restart", agent.id),
        ),
      );

      const secondBackend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const page = await secondBackend.listConversationMessages(
        conversation.id,
        { agent_id: agent.id, order: "asc" } as ConversationMessageListBody,
      );
      const messages = page.getPaginatedItems();
      expect(messages.map((message) => message.message_type)).toEqual([
        "user_message",
        "assistant_message",
      ]);
      expect(JSON.stringify(messages)).toContain("remember restart");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("projects local UI messages in persisted order instead of metadata timestamp order", () => {
    const projected = projectLocalMessagesToStoredMessages(
      [
        {
          id: "ui-user-1",
          role: "user",
          metadata: { created_at: "2026-01-01T00:00:35.000Z" },
          parts: [{ type: "text", text: "sup" }],
        },
        {
          id: "ui-assistant-1",
          role: "assistant",
          metadata: { created_at: "2026-01-01T00:00:01.000Z" },
          parts: [{ type: "text", text: "hello" }],
        },
        {
          id: "ui-user-2",
          role: "user",
          metadata: { created_at: "2026-01-01T00:00:46.000Z" },
          parts: [{ type: "text", text: "what's on my desktop?" }],
        },
        {
          id: "ui-assistant-2",
          role: "assistant",
          metadata: { created_at: "2026-01-01T00:00:10.000Z" },
          parts: [
            {
              type: "tool-ShellCommand",
              toolCallId: "call-1",
              state: "output-available",
              input: { command: "ls ~/Desktop" },
              output: "Desktop contents",
            },
            { type: "text", text: "Desktop summary" },
          ],
        },
      ],
      "agent-local-test",
      "default",
    );

    expect(projected.map((message) => message.message_type)).toEqual([
      "user_message",
      "assistant_message",
      "user_message",
      "approval_request_message",
      "tool_return_message",
      "assistant_message",
    ]);
    expect(projected.map((message) => message.date)).toEqual([
      "2026-01-01T00:00:01.000Z",
      "2026-01-01T00:00:02.000Z",
      "2026-01-01T00:00:03.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:04.000Z",
      "2026-01-01T00:00:04.000Z",
    ]);
  });

  test("projects local reasoning parts as reasoning messages", () => {
    const projected = projectLocalMessagesToStoredMessages(
      [
        {
          id: "ui-assistant-reasoning",
          role: "assistant",
          parts: [
            { type: "reasoning", text: "think through the request" },
            { type: "text", text: "final answer" },
          ],
        },
      ],
      "agent-local-test",
      "default",
    );

    expect(projected.map((message) => message.message_type)).toEqual([
      "reasoning_message",
      "assistant_message",
    ]);
    expect(projected[0]).toMatchObject({
      message_type: "reasoning_message",
      reasoning: "think through the request",
    });
    expect(projected[1]).toMatchObject({
      message_type: "assistant_message",
      content: [{ type: "text", text: "final answer" }],
    });
    expect(
      (
        (projected[1] as { content?: Array<{ type?: unknown }> }).content ?? []
      ).map((part) => part.type),
    ).toEqual(["text"]);
  });

  test("projects unresolved local tool parts as pending approvals only until a tool result exists", () => {
    const pending = projectLocalMessagesToStoredMessages(
      [
        {
          id: "ui-assistant-pending",
          role: "assistant",
          parts: [
            {
              type: "tool-ShellCommand",
              toolCallId: "call-pending",
              state: "approval-requested",
              input: { command: "pwd" },
              approval: { id: "approval-pending" },
            },
          ],
        },
      ],
      "agent-local-test",
      "default",
    );
    expect(pending.map((message) => message.message_type)).toEqual([
      "approval_request_message",
    ]);

    const completed = projectLocalMessagesToStoredMessages(
      [
        {
          id: "ui-assistant-complete",
          role: "assistant",
          parts: [
            {
              type: "tool-ShellCommand",
              toolCallId: "call-complete",
              state: "output-available",
              input: { command: "pwd" },
              output: "/tmp/project",
            },
          ],
        },
      ],
      "agent-local-test",
      "default",
    );
    expect(completed.map((message) => message.message_type)).toEqual([
      "approval_request_message",
      "tool_return_message",
    ]);
  });

  test("ignores stale local approval results after a tool output is persisted", () => {
    const store = new LocalStore("agent-local-test");
    store.appendTurnInput("default", {
      agent_id: "agent-local-test",
      messages: [{ role: "user", content: "call tool" }],
    } as unknown as ConversationMessageCreateBody);
    store.appendStreamChunk("default", "agent-local-test", {
      message_type: "approval_request_message",
      tool_call: {
        tool_call_id: "call-stale",
        name: "ShellCommand",
        arguments: JSON.stringify({ command: "pwd" }),
      },
    } as LettaStreamingResponse);
    store.appendTurnInput("default", {
      agent_id: "agent-local-test",
      messages: [
        {
          type: "approval",
          approvals: [
            {
              type: "tool",
              tool_call_id: "call-stale",
              tool_return: "/tmp/project",
              status: "success",
            },
          ],
        },
      ],
    } as unknown as ConversationMessageCreateBody);
    store.appendTurnInput("default", {
      agent_id: "agent-local-test",
      messages: [
        {
          type: "approval",
          approvals: [
            {
              type: "approval",
              tool_call_id: "call-stale",
              approve: false,
              reason: "stale approval from interrupted session",
            },
          ],
        },
      ],
    } as unknown as ConversationMessageCreateBody);

    const messages = store.listConversationMessages("default", {
      agent_id: "agent-local-test",
      order: "asc",
    } as ConversationMessageListBody);
    expect(JSON.stringify(messages)).toContain("/tmp/project");
    expect(JSON.stringify(messages)).not.toContain(
      "stale approval from interrupted session",
    );
  });

  test("preserves AI SDK reasoning metadata across local tool continuation and backend restart", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-tool-e2e-"));
    try {
      const openAIReasoningMetadata = {
        openai: {
          itemId: "rs_required_for_function_call",
          reasoningEncryptedContent: null,
        },
      };
      const openAIToolMetadata = {
        openai: { itemId: "fc_requires_reasoning" },
      };
      const toolInput = { command: "ls -la ~/Desktop" };
      let callCount = 0;
      let followUpModelMessages: ModelMessage[] | undefined;

      const streamText = (options: { messages: ModelMessage[] }) => {
        callCount += 1;
        if (callCount === 3) {
          followUpModelMessages = options.messages;
        }

        if (callCount === 1) {
          return {
            fullStream: (async function* () {
              yield {
                type: "reasoning-start",
                id: "rs_required_for_function_call:0",
                providerMetadata: openAIReasoningMetadata,
              } as TextStreamPart<ToolSet>;
              yield {
                type: "reasoning-end",
                id: "rs_required_for_function_call:0",
                providerMetadata: openAIReasoningMetadata,
              } as TextStreamPart<ToolSet>;
              yield {
                type: "tool-call",
                toolCallId: "call-desktop",
                toolName: "ShellCommand",
                input: toolInput,
                providerMetadata: openAIToolMetadata,
              } as TextStreamPart<ToolSet>;
              yield {
                type: "finish",
                finishReason: "tool-calls",
              } as TextStreamPart<ToolSet>;
            })(),
            toUIMessageStream: uiMessageStreamWithFinish(
              [
                { type: "start", messageId: "assistant-desktop" },
                { type: "start-step" },
                {
                  type: "reasoning-start",
                  id: "rs_required_for_function_call:0",
                  providerMetadata: openAIReasoningMetadata,
                },
                {
                  type: "reasoning-end",
                  id: "rs_required_for_function_call:0",
                  providerMetadata: openAIReasoningMetadata,
                },
                {
                  type: "tool-input-available",
                  toolCallId: "call-desktop",
                  toolName: "ShellCommand",
                  input: toolInput,
                  providerMetadata: openAIToolMetadata,
                },
                { type: "finish-step" },
                { type: "finish", finishReason: "tool-calls" },
              ],
              {
                id: "assistant-desktop",
                role: "assistant",
                parts: [
                  { type: "step-start" },
                  {
                    type: "reasoning",
                    text: "",
                    state: "done",
                    providerMetadata: openAIReasoningMetadata,
                  },
                  {
                    type: "tool-ShellCommand",
                    toolCallId: "call-desktop",
                    state: "input-available",
                    input: toolInput,
                    callProviderMetadata: openAIToolMetadata,
                  },
                ],
              },
              "tool-calls",
            ),
          };
        }

        if (callCount === 2) {
          return {
            fullStream: (async function* () {
              yield {
                type: "text-start",
                id: "msg-after-tool",
              } as TextStreamPart<ToolSet>;
              yield {
                type: "text-delta",
                id: "msg-after-tool",
                text: "desktop summary",
              } as TextStreamPart<ToolSet>;
              yield {
                type: "text-end",
                id: "msg-after-tool",
                providerMetadata: {
                  openai: {
                    itemId: "msg_after_tool",
                    phase: "final_answer",
                  },
                },
              } as TextStreamPart<ToolSet>;
              yield {
                type: "finish",
                finishReason: "stop",
              } as TextStreamPart<ToolSet>;
            })(),
            toUIMessageStream: uiMessageStreamWithFinish(
              [
                { type: "start", messageId: "assistant-desktop" },
                { type: "start-step" },
                { type: "text-start", id: "msg-after-tool" },
                {
                  type: "text-delta",
                  id: "msg-after-tool",
                  delta: "desktop summary",
                },
                {
                  type: "text-end",
                  id: "msg-after-tool",
                  providerMetadata: {
                    openai: {
                      itemId: "msg_after_tool",
                      phase: "final_answer",
                    },
                  },
                },
                { type: "finish-step" },
                { type: "finish", finishReason: "stop" },
              ],
              (streamOptions) => {
                const previous = streamOptions?.originalMessages?.at(-1);
                expect(previous?.role).toBe("assistant");
                return {
                  ...(previous as LocalMessage),
                  parts: [
                    ...((previous as LocalMessage | undefined)?.parts ?? []),
                    { type: "step-start" },
                    {
                      type: "text",
                      text: "desktop summary",
                      state: "done",
                      providerMetadata: {
                        openai: {
                          itemId: "msg_after_tool",
                          phase: "final_answer",
                        },
                      },
                    },
                  ],
                };
              },
            ),
          };
        }

        return {
          fullStream: (async function* () {
            yield {
              type: "text-delta",
              id: "msg-follow-up",
              text: "follow up ok",
            } as TextStreamPart<ToolSet>;
            yield {
              type: "finish",
              finishReason: "stop",
            } as TextStreamPart<ToolSet>;
          })(),
        };
      };

      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        streamText: streamText as never,
      });
      const agent = await backend.createAgent({
        name: "Tool Resume Agent",
        model: "openai/gpt-5.5",
        model_settings: { provider_type: "openai" },
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const toolChunks = await collectStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("whats on my desktop", agent.id),
        ),
      );
      const approvalRequest = toolChunks.find(
        (chunk) => chunk.message_type === "approval_request_message",
      ) as { tool_call?: { tool_call_id?: string } } | undefined;
      expect(approvalRequest?.tool_call?.tool_call_id).toBe("call-desktop");

      await drainStream(
        await backend.createConversationMessageStream(conversation.id, {
          messages: [
            {
              type: "approval",
              approvals: [
                {
                  type: "tool",
                  tool_call_id: "call-desktop",
                  tool_return: "Desktop listing",
                  status: "success",
                },
              ],
            },
          ],
          streaming: true,
          stream_tokens: true,
          include_pings: true,
          background: true,
          client_tools: [],
          client_skills: [],
          agent_id: agent.id,
        } as unknown as ConversationMessageCreateBody),
      );

      const persistedAfterTool = await readPersistedLocalMessages(storageDir);
      const assistantWithTool = persistedAfterTool.find(
        (message) => message.role === "assistant",
      );
      expect(JSON.stringify(assistantWithTool)).toContain(
        "rs_required_for_function_call",
      );
      expect(JSON.stringify(assistantWithTool)).toContain(
        "fc_requires_reasoning",
      );
      expect(JSON.stringify(assistantWithTool)).toContain("Desktop listing");
      expect(JSON.stringify(assistantWithTool)).toContain("desktop summary");

      const resumedBackend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        streamText: streamText as never,
      });
      await drainStream(
        await resumedBackend.createConversationMessageStream(
          conversation.id,
          createBody("anything interesting", agent.id),
        ),
      );

      const serializedFollowUpMessages = JSON.stringify(followUpModelMessages);
      expect(serializedFollowUpMessages).toContain(
        "rs_required_for_function_call",
      );
      expect(serializedFollowUpMessages).toContain("fc_requires_reasoning");
      expect(serializedFollowUpMessages).toContain("Desktop listing");
      expect(callCount).toBe(3);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("continues local AI SDK tool-call turns after approval results", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-tool-"));
    try {
      const capturedMessages: ModelMessage[][] = [];
      const backend = new LocalBackend({
        storageDir,
        createModel: () => ({}) as LanguageModel,
        streamText: (options) => {
          capturedMessages.push(options.messages);
          const hasToolOutput = JSON.stringify(options.messages).includes(
            "provider-local-tool-output",
          );
          return {
            fullStream: hasToolOutput
              ? (async function* () {
                  yield {
                    type: "text-delta",
                    id: "text-1",
                    text: "tool continuation ok",
                  } as TextStreamPart<ToolSet>;
                  yield {
                    type: "finish",
                    finishReason: "stop",
                  } as TextStreamPart<ToolSet>;
                })()
              : (async function* () {
                  yield {
                    type: "tool-call",
                    toolCallId: "provider-local-tool",
                    toolName: "ShellCommand",
                    input: {
                      command: "echo provider-local-tool-output",
                      login: false,
                    },
                  } as TextStreamPart<ToolSet>;
                  yield {
                    type: "finish",
                    finishReason: "tool-calls",
                  } as TextStreamPart<ToolSet>;
                })(),
          };
        },
      });
      const agent = await backend.createAgent({
        name: "Tool Agent",
        model: "openai/gpt-test",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const firstChunks = await collectStream(
        await backend.createConversationMessageStream(
          conversation.id,
          createBody("call local tool", agent.id),
        ),
      );
      const approvalChunk = firstChunks.find(
        (chunk) => chunk.message_type === "approval_request_message",
      ) as
        | (LettaStreamingResponse & {
            tool_call?: { tool_call_id?: string; name?: string };
          })
        | undefined;
      expect(approvalChunk?.tool_call?.tool_call_id).toBe(
        "provider-local-tool",
      );

      const secondChunks = await collectStream(
        await backend.createConversationMessageStream(conversation.id, {
          ...createBody("", agent.id),
          messages: [
            {
              type: "approval",
              approvals: [
                {
                  type: "tool",
                  tool_call_id: approvalChunk?.tool_call?.tool_call_id,
                  tool_return: "provider-local-tool-output",
                  status: "success",
                },
              ],
            },
          ],
        } as unknown as ConversationMessageCreateBody),
      );

      expect(JSON.stringify(secondChunks)).toContain("tool continuation ok");
      expect(capturedMessages).toHaveLength(2);
      expect(JSON.stringify(capturedMessages[1])).toContain(
        "provider-local-tool-output",
      );

      const persistedMessages = await readPersistedLocalMessages(storageDir);
      expect(persistedMessages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
      ]);
      const persistedAssistant = persistedMessages.find(
        (message) => message.role === "assistant",
      );
      expect(JSON.stringify(persistedAssistant?.parts)).toContain(
        "tool-ShellCommand",
      );
      expect(JSON.stringify(persistedAssistant?.parts)).toContain(
        "provider-local-tool-output",
      );
      expect(JSON.stringify(persistedAssistant?.parts)).toContain(
        "tool continuation ok",
      );

      const resumedBackend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      const resumedConversation = await resumedBackend.retrieveConversation(
        conversation.id,
      );
      const lastInContextId = (
        resumedConversation.in_context_message_ids ?? []
      ).at(-1);
      expect(lastInContextId).toBeString();
      const lastMessageVariants = await resumedBackend.retrieveMessage(
        lastInContextId ?? "",
      );
      expect(
        lastMessageVariants.map((message) => message.message_type),
      ).toEqual([
        "approval_request_message",
        "tool_return_message",
        "assistant_message",
      ]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("uses local model config for agents created without explicit model", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-model-"));
    try {
      await withLocalModelEnv(
        { anthropicKey: "test-anthropic-key" },
        async () => {
          const backend = new LocalBackend({
            storageDir,
            executionMode: "deterministic",
          });

          const models = (await backend.listModels()) as Array<{
            handle: string;
          }>;
          expect(models.map((model) => model.handle)).toContain(
            "anthropic/claude-sonnet-4-6",
          );

          const agent = await backend.createAgent({
            name: "Local Model Agent",
          } as AgentCreateBody);
          expect(agent.model).toBe("anthropic/claude-sonnet-4-6");
          expect(agent.model_settings).toMatchObject({
            provider_type: "anthropic",
          });

          const pseudoModelAgent = await backend.createAgent({
            name: "Pseudo Model Agent",
            model: "letta/auto",
          } as AgentCreateBody);
          expect(pseudoModelAgent.model).toBe("anthropic/claude-sonnet-4-6");
        },
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
