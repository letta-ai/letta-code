import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectReflectionSweepSegments,
  finalizeReflectionSegmentReview,
} from "../../cli/helpers/reflectionReview";

type MockMessage = {
  id: string;
  date: string;
  message_type: string;
  content: Array<{ type: "text"; text: string }>;
};

function buildPage<T>(items: T[]) {
  return {
    getPaginatedItems: () => items,
  };
}

describe("reflection review sweep", () => {
  let transcriptRoot: string;

  beforeEach(async () => {
    transcriptRoot = await mkdtemp(join(tmpdir(), "letta-reflection-review-"));
    process.env.LETTA_TRANSCRIPT_ROOT = transcriptRoot;
  });

  afterEach(async () => {
    delete process.env.LETTA_TRANSCRIPT_ROOT;
    await rm(transcriptRoot, { recursive: true, force: true });
  });

  test("collects unreviewed segment and advances checkpoint on success", async () => {
    const now = new Date("2026-04-02T21:00:00.000Z");
    const messages: MockMessage[] = [
      {
        id: "m1",
        date: "2026-04-02T18:00:00.000Z",
        message_type: "user_message",
        content: [{ type: "text", text: "hello" }],
      },
      {
        id: "m2",
        date: "2026-04-02T18:02:00.000Z",
        message_type: "assistant_message",
        content: [{ type: "text", text: "hi" }],
      },
    ];

    const mockClient = {
      conversations: {
        list: async () =>
          buildPage([
            {
              id: "conv-1",
              created_at: "2026-04-02T17:00:00.000Z",
              updated_at: "2026-04-02T18:02:00.000Z",
              last_message_at: "2026-04-02T18:02:00.000Z",
            },
          ]),
        messages: {
          list: async (
            _conversationId: string,
            query: {
              order: "asc" | "desc";
              after?: string;
            },
          ) => {
            if (query.order === "asc") {
              const index = messages.findIndex(
                (item) => item.id === query.after,
              );
              const sliced = index >= 0 ? messages.slice(index + 1) : messages;
              return buildPage(sliced);
            }
            return buildPage([...messages].reverse());
          },
        },
      },
      agents: {
        messages: {
          list: async () => buildPage([]),
        },
      },
    };

    const firstSweep = await collectReflectionSweepSegments({
      agentId: "agent-1",
      primaryConversationId: "default",
      now,
      client: mockClient,
    });

    expect(firstSweep).toHaveLength(1);
    expect(firstSweep[0]?.startMessageId).toBe("m1");
    expect(firstSweep[0]?.endMessageId).toBe("m2");
    const segment = firstSweep[0];
    expect(segment).toBeDefined();
    if (!segment) {
      return;
    }

    await finalizeReflectionSegmentReview({
      agentId: "agent-1",
      segment,
      triggerSource: "step-count",
      success: true,
      reflectionAgentId: "agent-reflection-1",
    });

    const secondSweep = await collectReflectionSweepSegments({
      agentId: "agent-1",
      primaryConversationId: "default",
      now,
      client: mockClient,
    });
    expect(secondSweep).toHaveLength(0);

    const statePath = join(
      transcriptRoot,
      "agent-1",
      "reflection-review",
      "state.json",
    );
    const stateRaw = await readFile(statePath, "utf-8");
    const state = JSON.parse(stateRaw) as {
      conversations: Array<{
        conversation_id: string;
        last_reviewed_message_id: string | null;
        reflection_agent_id: string | null;
      }>;
    };

    const checkpoint = state.conversations.find(
      (entry) => entry.conversation_id === "conv-1",
    );
    expect(checkpoint?.last_reviewed_message_id).toBe("m2");
    expect(checkpoint?.reflection_agent_id).toBe("agent-reflection-1");
  });
});
