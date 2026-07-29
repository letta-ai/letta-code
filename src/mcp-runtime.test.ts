import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  closeClientMcpServers,
  getClientMcpServerStates,
  replaceClientMcpServers,
} from "@/mcp-runtime";
import { getExternalToolDefinition } from "@/tools/manager";

const EVERYTHING_SERVER = fileURLToPath(
  new URL(
    "./dist/index.js",
    import.meta.resolve("@modelcontextprotocol/server-everything/package.json"),
  ),
);

afterEach(async () => {
  await closeClientMcpServers();
});

describe("client-local MCP runtime", () => {
  test("registers namespaced tools that execute through the local process", async () => {
    const states = await replaceClientMcpServers("agent-a", [
      {
        name: "everything",
        transport: "stdio",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
      },
    ]);

    expect(states[0]?.status).toBe("connected");
    const tool = getExternalToolDefinition("mcp__everything__echo");
    if (!tool?.executor) throw new Error("MCP tool was not registered");
    const result = await tool.executor(
      "call-1",
      "mcp__everything__echo",
      { message: "local" },
      { tool },
    );
    expect(result).toEqual({
      content: [{ type: "text", text: "Echo: local" }],
      isError: false,
    });
  });

  test("replaces MCP tools when the selected agent changes", async () => {
    await replaceClientMcpServers("agent-a", [
      {
        name: "everything",
        transport: "stdio",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
      },
    ]);
    expect(getExternalToolDefinition("mcp__everything__echo")).toBeDefined();

    await replaceClientMcpServers("agent-b", []);
    expect(getExternalToolDefinition("mcp__everything__echo")).toBeUndefined();
    expect(getClientMcpServerStates("agent-a")).toHaveLength(0);
    expect(getClientMcpServerStates("agent-b")).toHaveLength(0);
  });

  test("keeps failed local servers visible without dropping healthy ones", async () => {
    const states = await replaceClientMcpServers("agent-a", [
      {
        name: "missing",
        transport: "stdio",
        command: "/nonexistent/mcp-server",
      },
      {
        name: "everything",
        transport: "stdio",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
      },
    ]);

    expect(states.map((state) => state.status)).toEqual([
      "failed",
      "connected",
    ]);
    expect(getClientMcpServerStates("agent-a")).toHaveLength(2);
    expect(getClientMcpServerStates("agent-b")).toHaveLength(0);
    expect(getExternalToolDefinition("mcp__everything__echo")).toBeDefined();
  });
});
