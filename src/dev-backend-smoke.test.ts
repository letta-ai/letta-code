import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationMessageCreateBody } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { createOrUpdateLocalProvider } from "@/backend/local";
import { LocalBackend } from "@/backend/local/local-backend";

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("dev backend smoke", () => {
  test("fake headless backend can create an agent, conversation, and streamed turn", async () => {
    const backend = new FakeHeadlessBackend("agent-smoke");
    const agent = await backend.retrieveAgent("agent-smoke");
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    });
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "hello" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      chunks.map((chunk) => (chunk as { message_type?: string }).message_type),
    ).toEqual(["assistant_message", "stop_reason"]);
  });

  test("local deterministic backend exposes local model catalog and streams", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-smoke-pi-"));
    await createOrUpdateLocalProvider({
      providerType: "openai",
      providerName: "lc-openai",
      apiKey: "dummy",
      storageDir,
    });
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
      memfsEnabled: false,
    });
    const models = (await backend.listModels()) as unknown;
    const modelItems = Array.isArray(models)
      ? models
      : ((
          models as { getPaginatedItems?: () => unknown[] }
        ).getPaginatedItems?.() ?? []);
    expect(modelItems.length).toBeGreaterThan(0);
    const agent = await backend.createAgent({ name: "smoke" } as never);
    const conversation = await backend.createConversation({
      agent_id: agent.id,
    } as never);
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: agent.id,
        messages: [{ role: "user", content: "hello" }],
      } as ConversationMessageCreateBody),
    );
    expect(
      chunks.some(
        (chunk) =>
          (chunk as { message_type?: string }).message_type === "stop_reason",
      ),
    ).toBe(true);
  });
});
