import { describe, expect, mock, test } from "bun:test";
import type { Letta } from "@letta-ai/letta-client";
import {
  buildSearchTargetPlan,
  warmMessageSearchCache,
} from "../../cli/components/MessageSearch";

describe("warmMessageSearchCache", () => {
  test("posts the new internal search cache-warm request shape", async () => {
    const post = mock((_path: string, _opts: { body: unknown }) =>
      Promise.resolve({
        collection: "messages",
        status: "ACCEPTED",
        warmed: true,
      }),
    );
    const client = { post } as unknown as Letta;

    const response = await warmMessageSearchCache(client);

    expect(post).toHaveBeenCalledTimes(1);
    const [path, opts] = post.mock.calls[0] ?? [];
    expect(path).toBe("/v1/_internal_search/cache-warm");
    expect(opts).toEqual({
      body: {
        collection: "messages",
        scope: {},
      },
    });
    expect(opts && "query" in opts).toBe(false);
    expect(response).toEqual({
      collection: "messages",
      status: "ACCEPTED",
      warmed: true,
    });
  });
});

describe("buildSearchTargetPlan", () => {
  test("prefetches adjacent modes and ranges instead of blocking on every combination", () => {
    expect(
      buildSearchTargetPlan("hybrid", "agent", {
        agentId: "agent-1",
        conversationId: "conv-1",
      }),
    ).toEqual({
      primary: { mode: "hybrid", range: "agent" },
      prefetch: [
        { mode: "fts", range: "agent" },
        { mode: "vector", range: "agent" },
        { mode: "hybrid", range: "all" },
        { mode: "hybrid", range: "conv" },
      ],
    });
  });

  test("skips unavailable ranges when there is no current conversation", () => {
    expect(
      buildSearchTargetPlan("hybrid", "agent", {
        agentId: "agent-1",
      }),
    ).toEqual({
      primary: { mode: "hybrid", range: "agent" },
      prefetch: [
        { mode: "fts", range: "agent" },
        { mode: "vector", range: "agent" },
        { mode: "hybrid", range: "all" },
      ],
    });
  });
});
