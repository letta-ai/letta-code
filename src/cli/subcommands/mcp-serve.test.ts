import { expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveCloudTools } from "./mcp-serve";

test("relays a changing cloud catalog and opaque tool calls over MCP", async () => {
  const requests: unknown[] = [];
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const server = await serveCloudTools(
    {
      get: async () => {
        throw new Error("unexpected GET");
      },
      post: async (path, options) => {
        requests.push({ path, body: options?.body });
        if (path.endsWith("/list"))
          return {
            serverName: "example-agent",
            instructions: "Server-owned instructions",
            tools: [
              {
                name: "future_tool",
                description: "From cloud",
                inputSchema: {
                  type: "object",
                  properties: { value: { type: "string" } },
                },
              },
            ],
          };
        return { content: [{ type: "text", text: "compact result" }] };
      },
    },
    serverTransport,
  );
  const client = new Client({ name: "test", version: "1" });
  try {
    await client.connect(clientTransport);
    expect(client.getServerVersion()?.name).toBe("example-agent");
    expect(client.getInstructions()).toBe("Server-owned instructions");
    expect((await client.listTools()).tools[0]?.name).toBe("future_tool");
    expect(
      await client.callTool({
        name: "future_tool",
        arguments: { value: "hello" },
      }),
    ).toEqual({ content: [{ type: "text", text: "compact result" }] });
    expect(requests).toEqual([
      { path: "/v1/subagent-tools/list", body: {} },
      {
        path: "/v1/subagent-tools/call",
        body: { name: "future_tool", arguments: { value: "hello" } },
      },
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("fails startup when cloud supplies no verified catalog", async () => {
  const [, transport] = InMemoryTransport.createLinkedPair();
  await expect(
    serveCloudTools(
      {
        get: async () => null,
        post: async () => {
          throw new Error("Forbidden");
        },
      },
      transport,
    ),
  ).rejects.toThrow("Forbidden");
});
