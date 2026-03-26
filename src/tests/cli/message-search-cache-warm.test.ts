import { describe, expect, mock, test } from "bun:test";
import type { Letta } from "@letta-ai/letta-client";
import { warmMessageSearchCache } from "../../cli/components/MessageSearch";

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
