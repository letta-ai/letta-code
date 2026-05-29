import { describe, expect, test } from "bun:test";
import type { Conversation } from "@letta-ai/letta-client/resources/conversations/conversations";
import type { ConversationSearchResult } from "@/backend/conversation-search";
import {
  filterBootstrapRelevantConversations,
  selectBootstrapRecentConversations,
} from "@/cli/helpers/conversation-bootstrap";

function conversation(id: string): Conversation {
  return { id, summary: `Conversation ${id}` } as Conversation;
}

function result(id: string, score: number): ConversationSearchResult {
  return {
    embedded_text: `Description ${id}`,
    conversation: conversation(id),
    rrf_score: score,
  };
}

describe("filterBootstrapRelevantConversations", () => {
  test("rejects weak single-channel RRF matches", () => {
    expect(
      filterBootstrapRelevantConversations(
        [result("one", 0.0082), result("two", 0.008)],
        {},
      ),
    ).toEqual([]);
  });

  test("keeps only high-confidence results near the strongest score", () => {
    expect(
      filterBootstrapRelevantConversations(
        [
          result("one", 0.016393),
          result("two", 0.015388),
          result("three", 0.015038),
        ],
        {},
      ).map((item) => item.conversation.id),
    ).toEqual(["one", "two"]);
  });

  test("keeps prod-like CI matches while dropping the weaker tail", () => {
    expect(
      filterBootstrapRelevantConversations(
        [
          result("ci-rank-1", 0.016393),
          result("ci-rank-2", 0.016001),
          result("ci-rank-3", 0.015757),
          result("ci-rank-4", 0.015749),
          result("ci-rank-5", 0.015388),
          result("weak-tail-1", 0.015038),
          result("weak-tail-2", 0.014939),
        ],
        {},
      ).map((item) => item.conversation.id),
    ).toEqual([
      "ci-rank-1",
      "ci-rank-2",
      "ci-rank-3",
      "ci-rank-4",
      "ci-rank-5",
    ]);
  });

  test("dedupes and excludes the active conversation before scoring", () => {
    expect(
      filterBootstrapRelevantConversations(
        [result("current", 0.04), result("one", 0.033), result("one", 0.032)],
        { excludeConversationId: "current" },
      ).map((item) => item.conversation.id),
    ).toEqual(["one"]);
  });
});

describe("selectBootstrapRecentConversations", () => {
  test("backfills recent conversations after removing relevant duplicates", () => {
    const recent = Array.from({ length: 10 }, (_, index) =>
      conversation(`conv-${index + 1}`),
    );

    expect(
      selectBootstrapRecentConversations(recent, {
        excludeConversationId: "conv-4",
        relevantConversationIds: new Set(["conv-1", "conv-2", "conv-3"]),
      }).map((item) => item.id),
    ).toEqual(["conv-5", "conv-6", "conv-7", "conv-8", "conv-9"]);
  });
});
