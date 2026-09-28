import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { projectResumedEphemeralConversation } from "@/agent/ephemeral-conversation";
import type { ConversationMessageCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local/local-backend";
import { listLocalConversations } from "@/backend/local/local-conversation-list";

class InspectableLocalBackend extends LocalBackend {
  executionConfig(conversationId: string) {
    return this.executionAgentForConversation(conversationId, conversationId);
  }
}

function conversation(input: {
  id: string;
  agentId?: string;
  summary?: string;
  updatedAt: string;
  hidden?: boolean;
}): Conversation & { hidden?: boolean } {
  return {
    id: input.id,
    agent_id: input.agentId ?? "agent-1",
    summary: input.summary ?? null,
    created_at: input.updatedAt,
    updated_at: input.updatedAt,
    last_message_at: input.updatedAt,
    ...(input.hidden ? { hidden: true } : {}),
  } as Conversation & { hidden?: boolean };
}

describe("listLocalConversations", () => {
  test("filters titles and IDs case-insensitively before applying the limit", () => {
    const result = listLocalConversations(
      [
        conversation({
          id: "local-conv-newest",
          summary: "Release Planning",
          updatedAt: "2026-07-18T12:00:00.000Z",
        }),
        conversation({
          id: "local-conv-flaky",
          summary: "Flaky Integration Tests",
          updatedAt: "2026-07-17T12:00:00.000Z",
        }),
      ],
      { agent_id: "agent-1", summary_search: "  FLAKY ", limit: 1 },
    );

    expect(result.map((item) => item.id)).toEqual(["local-conv-flaky"]);
  });

  test("keeps completed local resume searches filtered", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "resume-search-"));

    try {
      const backend = new LocalBackend({ storageDir, memfsEnabled: false });
      const agent = await backend.createAgent({ name: "Local" } as never);
      await backend.createConversation({
        agent_id: agent.id,
        summary: "Release Planning",
      } as never);
      const flaky = await backend.createConversation({
        agent_id: agent.id,
        summary: "Flaky Integration Tests",
      } as never);

      const results = (await backend.listConversations({
        agent_id: agent.id,
        summary_search: "flaky",
      } as never)) as Conversation[];

      expect(results.map((item) => item.id)).toEqual([flaky.id]);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("persists detached ownership, resumes by ID, and forks without an agent record", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "detached-conversation-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      const detached = await backend.createDetachedConversation({
        model: "local/default",
        system: "Snapshot of original prompt",
        name: "Task",
        model_settings: { context_window_limit: 16384 },
        context_window_limit: 6144,
      });
      expect(detached).toMatchObject({
        agent_id: null,
        parent_agent_id: null,
        system: "Snapshot of original prompt",
      });
      expect(await readdir(join(storageDir, "agents")).catch(() => [])).toEqual(
        [],
      );
      const reloaded = new LocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      expect(await reloaded.retrieveConversation(detached.id)).toMatchObject({
        agent_id: null,
        system: "Snapshot of original prompt",
      });
      await expect(
        reloaded.getConversationResumeTail(detached.id, detached.id, {
          limit: 10,
        }),
      ).resolves.toBeDefined();
      const stream = await reloaded.createConversationMessageStream(
        detached.id,
        {
          messages: [{ role: "user", content: "hello" }],
        } as ConversationMessageCreateBody,
      );
      for await (const chunk of stream) {
        if ("agent_id" in chunk) expect(chunk.agent_id).toBeNull();
      }
      expect(await reloaded.retrieveRun("local-run-1")).toMatchObject({
        agent_id: null,
        conversation_id: detached.id,
        status: "completed",
      });
      const messages = (
        await reloaded.listConversationMessages(detached.id)
      ).getPaginatedItems();
      expect(messages.length).toBeGreaterThan(0);
      expect(
        messages.every(
          (message) => "agent_id" in message && message.agent_id === null,
        ),
      ).toBe(true);
      const fork = await reloaded.forkConversation(detached.id, {});
      expect(await reloaded.retrieveConversation(fork.id)).toMatchObject({
        agent_id: null,
        parent_agent_id: null,
        system: "Snapshot of original prompt",
        context_window_limit: 6144,
      });
      const reopened = new LocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      const reopenedFork = await reopened.retrieveConversation(fork.id);
      expect(reopenedFork).toMatchObject({
        context_window_limit: 6144,
        model_settings: { context_window_limit: 16384 },
      });
      expect(
        projectResumedEphemeralConversation(reopenedFork).llm_config
          .context_window,
      ).toBe(6144);
      expect(
        (await reopened.listConversationMessages(fork.id))
          .getPaginatedItems()
          .every(
            (message) => "agent_id" in message && message.agent_id === null,
          ),
      ).toBe(true);
      expect(await readdir(join(storageDir, "agents")).catch(() => [])).toEqual(
        [],
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps detached parent linkage distinct from ownership and rejects other agents", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "detached-parent-"));
    try {
      const backend = new InspectableLocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      const parent = await backend.createAgent({
        name: "Parent",
        model_settings: { context_window_limit: 12000, max_tokens: 77 },
      } as never);
      const other = await backend.createAgent({ name: "Other" } as never);
      await expect(
        backend.createDetachedConversation({
          model: "local/default",
          system: "test",
          parent_agent_id: "agent-local-missing",
        }),
      ).rejects.toThrow();
      const child = await backend.createDetachedConversation({
        model: parent.model ?? "local/default",
        system: "Original child prompt",
        parent_agent_id: parent.id,
        model_settings: { max_tokens: 31 },
      });
      expect(backend.executionConfig(child.id)).toMatchObject({
        id: child.id,
        system: "Original child prompt",
        model_settings: { context_window_limit: 12000, max_tokens: 31 },
      });
      await backend.updateAgent(parent.id, {
        model_settings: { context_window_limit: 24000, max_tokens: 99 },
      } as never);
      expect(backend.executionConfig(child.id).model_settings).toMatchObject({
        context_window_limit: 12000,
        max_tokens: 31,
      });
      await expect(
        backend.getConversationResumeTail(other.id, child.id, { limit: 10 }),
      ).rejects.toThrow();
      const reopened = new InspectableLocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      expect(reopened.executionConfig(child.id).model_settings).toMatchObject({
        context_window_limit: 12000,
        max_tokens: 31,
      });
      expect(await reopened.retrieveConversation(child.id)).toMatchObject({
        agent_id: null,
        parent_agent_id: parent.id,
      });
      const stream = await reopened.createConversationMessageStream(child.id, {
        messages: [{ role: "user", content: "hello" }],
      } as ConversationMessageCreateBody);
      for await (const _chunk of stream) {
        /* exercise persisted conversation */
      }
      const fork = await reopened.forkConversation(child.id, {});
      expect(await reopened.retrieveConversation(fork.id)).toMatchObject({
        agent_id: null,
        parent_agent_id: parent.id,
        system: "Original child prompt",
      });
      expect(
        (await reopened.listConversationMessages(child.id))
          .getPaginatedItems()
          .every(
            (message) => "agent_id" in message && message.agent_id === null,
          ),
      ).toBe(true);
      // Pre-existing hidden agent-backed children remain readable as before.
      const legacy = await reopened.createAgent({
        name: "Legacy child",
        hidden: true,
      } as never);
      const legacyConversation = await reopened.createConversation({
        agent_id: legacy.id,
      });
      expect(
        (await reopened.retrieveConversation(legacyConversation.id)).agent_id,
      ).toBe(legacy.id);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("forks an agent-backed parent into a detached child only when requested", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "local-agent-fork-"));
    try {
      const backend = new InspectableLocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      const parent = await backend.createAgent({
        name: "Parent",
        system: "Parent system snapshot",
        model_settings: { context_window_limit: 8192, max_tokens: 75 },
      } as never);
      const source = await backend.createConversation({ agent_id: parent.id });
      const stream = await backend.createConversationMessageStream(source.id, {
        agent_id: parent.id,
        messages: [{ role: "user", content: "source fork history" }],
      } as ConversationMessageCreateBody);
      for await (const _chunk of stream) {
        /* persist real local turn */
      }
      const ordinary = await backend.forkConversation(source.id, {});
      expect((await backend.retrieveConversation(ordinary.id)).agent_id).toBe(
        parent.id,
      );
      const detached = await backend.forkConversation(source.id, {
        ephemeral: true,
        name: "Child fork",
        isSubagent: true,
      });
      expect(await backend.retrieveConversation(detached.id)).toMatchObject({
        agent_id: null,
        parent_agent_id: parent.id,
        name: "Child fork",
        is_subagent: true,
        model_settings: { context_window_limit: 8192, max_tokens: 75 },
      });
      expect(backend.executionConfig(detached.id)).toMatchObject({
        id: detached.id,
        model_settings: { context_window_limit: 8192, max_tokens: 75 },
      });
      expect(backend.executionConfig(detached.id).system).toContain(
        "Parent system snapshot",
      );
      await backend.updateAgent(parent.id, {
        system: "Changed parent system",
        model_settings: { context_window_limit: 32768, max_tokens: 5 },
      } as never);
      const reopened = new InspectableLocalBackend({
        storageDir,
        memfsEnabled: false,
        executionMode: "deterministic",
      });
      expect(await reopened.retrieveConversation(detached.id)).toMatchObject({
        agent_id: null,
        parent_agent_id: parent.id,
        model_settings: { context_window_limit: 8192, max_tokens: 75 },
      });
      expect(reopened.executionConfig(detached.id).system).toContain(
        "Parent system snapshot",
      );
      expect(
        reopened.executionConfig(detached.id).model_settings,
      ).toMatchObject({
        context_window_limit: 8192,
        max_tokens: 75,
      });
      const compiledChild = await reopened.recompileConversation(detached.id);
      expect(compiledChild.match(/<memory_metadata>/g)).toHaveLength(1);
      expect(compiledChild).toContain(`- AGENT_ID: ${detached.id}`);
      expect(compiledChild).not.toContain(`- AGENT_ID: ${parent.id}`);
      const messages = (
        await reopened.listConversationMessages(detached.id)
      ).getPaginatedItems();
      expect(messages.length).toBeGreaterThan(0);
      expect(
        messages.every(
          (message) => "agent_id" in message && message.agent_id === null,
        ),
      ).toBe(true);
      expect(await readdir(join(storageDir, "agents"))).toHaveLength(1);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves agent, hidden, ordering, and cursor filters", () => {
    const result = listLocalConversations(
      [
        conversation({
          id: "local-conv-3",
          summary: "Third",
          updatedAt: "2026-07-18T12:00:00.000Z",
        }),
        conversation({
          id: "local-conv-hidden",
          summary: "Hidden",
          updatedAt: "2026-07-18T13:00:00.000Z",
          hidden: true,
        }),
        conversation({
          id: "local-conv-2",
          summary: "Second",
          updatedAt: "2026-07-17T12:00:00.000Z",
        }),
        conversation({
          id: "local-conv-other-agent",
          agentId: "agent-2",
          summary: "Other",
          updatedAt: "2026-07-19T12:00:00.000Z",
        }),
      ],
      { agent_id: "agent-1", after: "local-conv-3" },
    );

    expect(result.map((item) => item.id)).toEqual(["local-conv-2"]);
  });
});
