import { expect, test } from "bun:test";
import Letta from "@letta-ai/letta-client";
import { runUnifiedMcpTool, type UnifiedMcpClient } from "./unified-mcp";

test("SDK transport does not retain originator headers across attributed and unattributed calls", async () => {
  const received: Array<[string | null, string | null]> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      received.push([
        request.headers.get("x-letta-mcp-originator-token"),
        request.headers.get("x-letta-mcp-originator-isolation"),
      ]);
      return Response.json({ status: "success", func_return: "ok" });
    },
  });
  try {
    const sdk = new Letta({
      apiKey: "test-only-key",
      baseURL: String(server.url),
    });
    const client: UnifiedMcpClient = {
      get: (path) => sdk.get(path),
      post: (path, options) => sdk.post(path, options),
    };
    for (const originatorToken of [
      "test-token-a",
      undefined,
      "",
      "test-token-b",
    ]) {
      await runUnifiedMcpTool({
        client,
        agentId: "agent-test",
        mcpServerId: "server-test",
        toolId: "tool-test",
        args: {},
        originatorToken,
      });
    }
    expect(received).toEqual([
      ["test-token-a", "1"],
      [null, null],
      [null, null],
      ["test-token-b", "1"],
    ]);
  } finally {
    await server.stop(true);
  }
});
