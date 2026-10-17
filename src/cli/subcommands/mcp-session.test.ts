import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { connectMcpServer } from "@/mcp-client";
import { executeWorkflow } from "@/tools/workflow/workflow-engine";
import { createAgentMcpSession } from "./mcp";

test("36 workflow MCP calls share one real stdio server with bounded concurrency", async () => {
  let connections = 0;
  let closes = 0;
  let running = 0;
  let peak = 0;
  const session = createAgentMcpSession("agent-1", {
    isServerMcpAvailable: () => false,
    getLocalServers: () => [
      {
        name: "everything",
        transport: "stdio",
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL(
              "./dist/index.js",
              import.meta.resolve(
                "@modelcontextprotocol/server-everything/package.json",
              ),
            ),
          ),
        ],
      },
    ],
    connectLocalServer: async (config, options) => {
      connections++;
      const connection = await connectMcpServer(config, options);
      return {
        ...connection,
        close: async () => {
          closes++;
          await connection.close();
        },
      };
    },
  });
  try {
    const result = await executeWorkflow(
      async () => {
        throw new Error("Tool-only scripts must not start subagents");
      },
      {
        script: `export const meta = { name: 'mcp-batch', description: 'Read tools directly' };
return await parallel(args.map(message => () => tools.mcp__everything__echo({ message })));`,
        args: Array.from({ length: 36 }, (_, i) => String(i)),
        maxConcurrent: 4,
        callTool: async (name, args) => {
          peak = Math.max(peak, ++running);
          try {
            return await session.callTool(name, args);
          } finally {
            running--;
          }
        },
      },
    );
    expect(result.result).toEqual(
      Array.from({ length: 36 }, (_, i) => `Echo: ${i}`),
    );
    expect(result.agentsSpawned).toBe(0);
    expect(connections).toBe(1);
    expect(peak).toBe(4);
  } finally {
    await session.close();
  }
  expect(closes).toBe(1);
}, 20_000);
