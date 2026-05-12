import { afterAll, describe, expect, mock, test } from "bun:test";

const warmSearchCacheMock = mock((_body: Record<string, unknown>) =>
  Promise.resolve({
    collection: "messages",
    status: "ACCEPTED",
    warmed: true,
  }),
);

mock.module("../../backend/api/search", () => ({
  searchMessages: mock(() => Promise.resolve([])),
  warmSearchCache: warmSearchCacheMock,
}));

const { buildSearchTargetPlan, warmMessageSearchCache } = await import(
  "../../cli/components/MessageSearch"
);

afterAll(() => {
  mock.restore();
});

describe("warmMessageSearchCache", () => {
  test("posts the new internal search cache-warm request shape", async () => {
    const response = await warmMessageSearchCache();

    expect(warmSearchCacheMock).toHaveBeenCalledTimes(1);
    const [body] = warmSearchCacheMock.mock.calls[0] ?? [];
    expect(body).toEqual({
      collection: "messages",
      scope: {},
    });
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
