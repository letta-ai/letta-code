import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LanguageModel, ModelMessage, TextStreamPart, ToolSet } from "ai";
import type {
  AgentCreateBody,
  ConversationCreateBody,
  ConversationMessageCreateBody,
} from "../../backend";
import { LocalBackend, resolveLocalModelConfig } from "../../backend/local";

async function withLocalModelEnv<T>(
  env: {
    provider?: string;
    model?: string;
    openAIModel?: string;
    anthropicModel?: string;
  },
  fn: () => T | Promise<T>,
): Promise<T> {
  const originalProvider = process.env.LETTA_LOCAL_AI_PROVIDER;
  const originalModel = process.env.LETTA_LOCAL_AI_MODEL;
  const originalOpenAIModel = process.env.LETTA_LOCAL_OPENAI_MODEL;
  const originalAnthropicModel = process.env.LETTA_LOCAL_ANTHROPIC_MODEL;
  try {
    if (env.provider === undefined) delete process.env.LETTA_LOCAL_AI_PROVIDER;
    else process.env.LETTA_LOCAL_AI_PROVIDER = env.provider;
    if (env.model === undefined) delete process.env.LETTA_LOCAL_AI_MODEL;
    else process.env.LETTA_LOCAL_AI_MODEL = env.model;
    if (env.openAIModel === undefined)
      delete process.env.LETTA_LOCAL_OPENAI_MODEL;
    else process.env.LETTA_LOCAL_OPENAI_MODEL = env.openAIModel;
    if (env.anthropicModel === undefined) {
      delete process.env.LETTA_LOCAL_ANTHROPIC_MODEL;
    } else {
      process.env.LETTA_LOCAL_ANTHROPIC_MODEL = env.anthropicModel;
    }
    return await fn();
  } finally {
    if (originalProvider === undefined)
      delete process.env.LETTA_LOCAL_AI_PROVIDER;
    else process.env.LETTA_LOCAL_AI_PROVIDER = originalProvider;
    if (originalModel === undefined) delete process.env.LETTA_LOCAL_AI_MODEL;
    else process.env.LETTA_LOCAL_AI_MODEL = originalModel;
    if (originalOpenAIModel === undefined)
      delete process.env.LETTA_LOCAL_OPENAI_MODEL;
    else process.env.LETTA_LOCAL_OPENAI_MODEL = originalOpenAIModel;
    if (originalAnthropicModel === undefined) {
      delete process.env.LETTA_LOCAL_ANTHROPIC_MODEL;
    } else {
      process.env.LETTA_LOCAL_ANTHROPIC_MODEL = originalAnthropicModel;
    }
  }
}

async function drainStream(stream: AsyncIterable<unknown>): Promise<void> {
  for await (const _chunk of stream) {
    // drain
  }
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

describe("LocalBackend", () => {
  test("resolves local provider and model config from local env", async () => {
    await withLocalModelEnv(
      { provider: "anthropic", model: "claude-local" },
      () => {
        expect(resolveLocalModelConfig()).toEqual({
          provider: "anthropic",
          model: "claude-local",
          handle: "anthropic/claude-local",
          modelSettings: { provider_type: "anthropic" },
        });
      },
    );
  });

  test("uses strict local flatfile semantics behind the real local entrypoint", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "fake",
      });
      expect(backend.capabilities.remoteMemfs).toBe(false);

      await expect(backend.retrieveAgent("agent-missing")).rejects.toThrow(
        "Agent agent-missing not found",
      );

      const agent = await backend.createAgent({
        name: "Local Agent",
        model: "dev/fake-headless",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
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

      const conversationDirs = await readdir(join(storageDir, "conversations"));
      expect(conversationDirs.length).toBeGreaterThan(0);
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

      expect(capturedSystem).toBe("local system");
      expect(capturedMessages).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "hello ai" }],
        },
      ]);
      expect(JSON.stringify(chunks)).toContain("local ai");
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("uses local model config for agents created without explicit model", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-backend-model-"));
    try {
      await withLocalModelEnv(
        { provider: "anthropic", model: "claude-local" },
        async () => {
          const backend = new LocalBackend({
            storageDir,
            executionMode: "fake",
          });

          const models = (await backend.listModels()) as Array<{
            handle: string;
          }>;
          expect(models.map((model) => model.handle)).toContain(
            "anthropic/claude-local",
          );

          const agent = await backend.createAgent({
            name: "Local Model Agent",
          } as AgentCreateBody);
          expect(agent.model).toBe("anthropic/claude-local");
          expect(agent.model_settings).toMatchObject({
            provider_type: "anthropic",
          });
        },
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
