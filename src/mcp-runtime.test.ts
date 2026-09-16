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
  test("discovers tools without registering them as model-facing tools", async () => {
    const states = await replaceClientMcpServers("agent-a", [
      {
        name: "everything",
        transport: "stdio",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
      },
    ]);

    expect(states[0]?.status).toBe("connected");
    expect(states[0]?.tools.some((tool) => tool.name === "echo")).toBe(true);
    expect(getExternalToolDefinition("mcp__everything__echo")).toBeUndefined();
  });

  test("replaces MCP connections when the selected agent changes", async () => {
    await replaceClientMcpServers("agent-a", [
      {
        name: "everything",
        transport: "stdio",
        command: process.execPath,
        args: [EVERYTHING_SERVER],
      },
    ]);
    expect(getClientMcpServerStates("agent-a")).toHaveLength(1);

    await replaceClientMcpServers("agent-b", []);
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
    expect(getExternalToolDefinition("mcp__everything__echo")).toBeUndefined();
  });
});
