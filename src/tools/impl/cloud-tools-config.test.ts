import { expect, test } from "bun:test";
import { buildClaudeStreamArgs } from "./claude-stream-session";
import {
  cloudToolsConfigArgs,
  discoverCloudToolsConfig,
  nativeCloudToolsConfig,
} from "./cloud-tools-config";

test("launch config uses cloud's name and no tool definitions or credential arguments", async () => {
  const config = await discoverCloudToolsConfig(
    {
      LETTA_CODE_BIN: "/opt/letta",
      LETTA_API_KEY: "secret-key",
      LETTA_MCP_SUBPROCESS_BROKER_KEY: "opaque-local-key",
      LETTA_MCP_SUBPROCESS_BROKER_SOCKET: "/tmp/local.sock",
    },
    {
      get: async () => null,
      post: async () => ({
        serverName: "example-agent",
        instructions: "Cloud instructions",
        tools: [{ name: "future_tool", inputSchema: { type: "object" } }],
      }),
    },
  );
  expect(config).toMatchObject({
    name: "example-agent",
    command: "/opt/letta",
    args: ["mcp", "serve"],
  });
  expect(config?.env?.LETTA_MCP_SUBPROCESS_BROKER_KEY).toBe("opaque-local-key");
  const native = nativeCloudToolsConfig(config);
  expect(native).toMatchObject({
    "example-agent": { command: "/opt/letta", args: ["mcp", "serve"] },
  });
  const args = cloudToolsConfigArgs(config);
  expect(args.join(" ")).toContain('mcp_servers."example-agent"');
  expect(args.join(" ")).toContain("LETTA_MCP_SUBPROCESS_BROKER_KEY");
  const claudeArgs = buildClaudeStreamArgs({ mcpServers: native });
  expect(
    JSON.parse(claudeArgs[claudeArgs.indexOf("--mcp-config") + 1] ?? "{}"),
  ).toEqual({ mcpServers: native });
  for (const value of ["secret-key", "opaque-local-key", "future_tool"]) {
    expect(JSON.stringify([...args, ...claudeArgs])).not.toContain(value);
  }
});

test("does not configure a server for denied discovery or an invalid cloud name", async () => {
  for (const response of [
    null,
    { serverName: "unsafe.name", instructions: "x", tools: [] },
  ]) {
    expect(
      await discoverCloudToolsConfig(
        {},
        { get: async () => null, post: async () => response },
      ),
    ).toBeNull();
  }
});
