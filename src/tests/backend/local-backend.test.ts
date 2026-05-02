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
import { LocalBackend } from "../../backend/local";

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
});
