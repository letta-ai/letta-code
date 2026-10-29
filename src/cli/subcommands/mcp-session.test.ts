import { expect, test } from "bun:test";
import type { ConnectedMcpServer } from "@/mcp-client";
import { createAgentMcpSession } from "./mcp";

test("an agent MCP session connects once and closes on close()", async () => {
  let connects = 0;
  let closes = 0;
  const queries: unknown[] = [];
  const connection: ConnectedMcpServer = {
    name: "Mixed Server",
    tools: [{ name: "search", inputSchema: { type: "object" } }],
    callTool: async (_name, args = {}) => {
      queries.push(args.query);
      return { content: [{ type: "text", text: "ok" }] };
    },
    close: async () => {
      closes++;
    },
  };
  const session = createAgentMcpSession("agent-1", {
    initializeSettings: async () => {},
    isServerMcpAvailable: () => false,
    getLocalServers: () => [
      { name: "Mixed Server", transport: "stdio", command: "node" },
    ],
    connectLocalServer: async () => {
      connects++;
      return connection;
    },
  });
  const call = (query: string) =>
    session.callTool("mcp__Mixed_Server__search", { query });

  // Concurrent first calls must share one catalog and its connections.
  await Promise.all([call("a"), call("b")]);
  await call("c");
  expect(connects).toBe(1);
  expect(queries).toEqual(["a", "b", "c"]);

  await session.close();
  expect(closes).toBe(1);
});
