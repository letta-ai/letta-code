import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import { LocalBackend } from "@/backend/local/local-backend";
import { listLocalConversations } from "@/backend/local/local-conversation-list";

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
