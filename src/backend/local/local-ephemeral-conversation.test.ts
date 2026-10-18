import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Stream } from "@letta-ai/letta-client/core/streaming";
import type { LettaStreamingResponse } from "@letta-ai/letta-client/resources/agents/messages";
import { LocalBackend } from "./local-backend";
import { LocalStore } from "./local-store";

function agentIds(store: LocalStore): string[] {
  const items = (store.listAgents() as { items?: Array<{ id: string }> }).items;
  return items?.map((agent) => agent.id) ?? [];
}

function persistedConversation(
  root: string,
  conversationId: string,
): Record<string, unknown> {
  for (const entry of readdirSync(join(root, "conversations"))) {
    const record = JSON.parse(
      readFileSync(
        join(root, "conversations", entry, "conversation.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    if (record.id === conversationId) return record;
  }
  throw new Error(`Missing persisted conversation ${conversationId}`);
}

describe("local agent-free conversations", () => {
  test("persists null ownership and resumes without creating an agent", () => {
    const root = mkdtempSync(join(tmpdir(), "local-ephemeral-conversation-"));
    try {
      const parentId = "agent-local-parent";
      const initial = new LocalStore(parentId, { storageDir: root });
      const agentsBefore = agentIds(initial);
      const created = initial.createEphemeralConversation({
        model: "openai/gpt-5.6-luna",
        system: "worker system snapshot",
        model_settings: { reasoning_effort: "low" },
        context_window_limit: 64_000,
        parent_agent_id: parentId,
        is_subagent: true,
        name: "Workflow worker 1",
      });

      expect(created.id).toMatch(
        /^local-conv-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(created).toMatchObject({
        agent_id: null,
        model: "openai/gpt-5.6-luna",
        system: "worker system snapshot",
        parent_agent_id: parentId,
        is_subagent: true,
      });
      expect(agentIds(initial)).toEqual(agentsBefore);
      expect(persistedConversation(root, created.id)).toMatchObject({
        agent_id: null,
        agent_free: true,
        model: "openai/gpt-5.6-luna",
        system: "worker system snapshot",
      });
      const updated = initial.updateConversation(created.id, {
        tags: ["workflow-source"],
      } as never);
      expect(updated.agent_id).toBeNull();
      expect((updated as unknown as { tags?: string[] }).tags).toEqual([
        "workflow-source",
      ]);

      const reloaded = new LocalStore(parentId, { storageDir: root });
      expect(reloaded.retrievePublicConversation(created.id)).toMatchObject({
        id: created.id,
        agent_id: null,
        model: "openai/gpt-5.6-luna",
        parent_agent_id: parentId,
        tags: ["workflow-source"],
      });
      expect(
        reloaded.retrieveExecutionAgentRecord(
          created.id,
          `agent-free:${created.id}`,
        ),
      ).toMatchObject({
        system: "worker system snapshot",
        model: "openai/gpt-5.6-luna",
        model_settings: { reasoning_effort: "low" },
      });
      expect(agentIds(reloaded)).toEqual(agentsBefore);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a second active turn on the same conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "local-ephemeral-active-run-"));
    try {
      const gate = new Promise<void>(() => {});
      const backend = new LocalBackend({
        storageDir: root,
        memfsEnabled: false,
        executor: {
          async execute() {
            const controller = new AbortController();
            return {
              controller,
              async *[Symbol.asyncIterator]() {
                await gate;
                yield {} as LettaStreamingResponse;
              },
            } as unknown as Stream<LettaStreamingResponse>;
          },
        },
      });
      const conversation = await backend.createEphemeralConversation({
        model: "openai/gpt-5.6-luna",
        system: "worker",
      });
      const first = await backend.createConversationMessageStream(
        conversation.id,
        { messages: [{ role: "user", content: "first" }] } as never,
      );
      await expect(
        backend.createConversationMessageStream(conversation.id, {
          messages: [{ role: "user", content: "second" }],
        } as never),
      ).rejects.toThrow("already has an active run");
      first.controller.abort();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps concurrent conversation model snapshots independent", () => {
    const store = new LocalStore("agent-local-parent");
    const first = store.createEphemeralConversation({
      model: "openai/gpt-5.6-luna",
      system: "first",
      model_settings: { reasoning_effort: "low" },
    });
    const second = store.createEphemeralConversation({
      model: "anthropic/claude-sonnet-4-6",
      system: "second",
      model_settings: { max_tokens: 2_000 },
    });

    expect(
      store.retrieveExecutionAgentRecord(first.id, `agent-free:${first.id}`),
    ).toMatchObject({ model: "openai/gpt-5.6-luna", system: "first" });
    expect(
      store.retrieveExecutionAgentRecord(second.id, `agent-free:${second.id}`),
    ).toMatchObject({
      model: "anthropic/claude-sonnet-4-6",
      system: "second",
    });
  });
});
