import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadlessBackend } from "./fake-headless-backend";
import { DeterministicPongExecutor } from "./headless-turn-executor";
import {
  type ProviderStreamAdapter,
  ProviderTurnExecutor,
  type ProviderTurnInput,
  providerLettaChunk,
} from "./provider-turn-executor";

async function collect(stream: AsyncIterable<unknown>) {
  const chunks: Record<string, unknown>[] = [];
  for await (const chunk of stream)
    chunks.push(chunk as Record<string, unknown>);
  return chunks;
}

test("headless conversation turns use their own model/system with null run and message owner", async () => {
  const storageDir = mkdtempSync(
    join(tmpdir(), "letta-conversation-headless-"),
  );
  let observed: ProviderTurnInput | undefined;
  const adapter: ProviderStreamAdapter = {
    async *stream(input) {
      observed = input;
      yield providerLettaChunk({
        message_type: "assistant_message",
        content: [{ type: "text", text: "provider answer" }],
      } as never);
      yield providerLettaChunk({
        message_type: "stop_reason",
        stop_reason: "end_turn",
      } as never);
    },
  };
  try {
    const backend = new HeadlessBackend(
      "agent-default",
      new ProviderTurnExecutor(adapter),
      {
        storageDir,
        seedDefaultAgent: false,
        strictAgentAccess: true,
        strictConversationAccess: true,
      },
    );
    const parent = await backend.createAgent({
      name: "Parent",
      model: "openai/gpt-5",
      system: "PARENT SYSTEM, MUST NOT LEAK",
    } as never);
    const agentCount = readdirSync(join(storageDir, "agents")).length;
    const conversation = await backend.createConversation({
      agent_id: null,
      parent_agent_id: parent.id,
      is_subagent: true,
      name: "Worker",
      model: "openai/gpt-5.5",
      system: "WORKER SYSTEM",
      model_settings: { max_tokens: 50 },
    } as never);
    const chunks = await collect(
      await backend.createConversationMessageStream(conversation.id, {
        agent_id: null,
        messages: [{ role: "user", content: "work" }],
      } as never),
    );
    expect(observed).toMatchObject({
      agentId: null,
      systemPrompt: "WORKER SYSTEM",
      agent: { model: "openai/gpt-5.5", system: "WORKER SYSTEM" },
    });
    expect(JSON.stringify(observed)).not.toContain("PARENT SYSTEM");
    expect(
      chunks.some((chunk) => chunk.message_type === "assistant_message"),
    ).toBe(true);
    const runId = chunks.find((chunk) => chunk.run_id)?.run_id as string;
    expect(
      ((await backend.retrieveRun(runId)) as { agent_id: string | null })
        .agent_id,
    ).toBeNull();
    const messages = (
      await backend.listConversationMessages(conversation.id, {
        order: "asc",
      } as never)
    ).getPaginatedItems() as unknown as Array<{ agent_id: string | null }>;
    expect(messages.every((message) => message.agent_id === null)).toBe(true);
    expect(readdirSync(join(storageDir, "agents"))).toHaveLength(agentCount);

    const reloaded = new HeadlessBackend(
      "agent-default",
      new DeterministicPongExecutor(),
      {
        storageDir,
        seedDefaultAgent: false,
        strictAgentAccess: true,
        strictConversationAccess: true,
      },
    );
    const next = await collect(
      await reloaded.createConversationMessageStream(conversation.id, {
        messages: [{ role: "user", content: "again" }],
      } as never),
    );
    expect(
      next.some((chunk) => chunk.message_type === "assistant_message"),
    ).toBe(true);
    expect(
      (await reloaded.retrieveConversation(conversation.id)).agent_id,
    ).toBeNull();
    expect(readdirSync(join(storageDir, "agents"))).toHaveLength(agentCount);
  } finally {
    rmSync(storageDir, { recursive: true, force: true });
  }
});
