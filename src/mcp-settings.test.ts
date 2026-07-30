import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { settingsManager } from "@/settings-manager";
import { setServiceName } from "@/utils/secrets";

const originalHome = process.env.HOME;
let testHome: string;

beforeEach(async () => {
  await settingsManager.reset();
  testHome = await mkdtemp(join(tmpdir(), "letta-mcp-settings-"));
  process.env.HOME = testHome;
  setServiceName("letta-code-mcp-settings-test");
});

afterEach(async () => {
  await settingsManager.reset();
  process.env.HOME = originalHome;
  setServiceName("letta-code");
  await rm(testHome, { recursive: true, force: true });
});

describe("per-agent MCP settings", () => {
  test("stores MCP servers independently per agent", async () => {
    await settingsManager.initialize();
    const server = {
      name: "everything",
      transport: "stdio" as const,
      command: "node",
      args: ["server.js"],
    };

    settingsManager.setMcpServers("agent-a", [server]);

    expect(settingsManager.getMcpServers("agent-a")).toEqual([server]);
    expect(settingsManager.getMcpServers("agent-b")).toEqual([]);
  });

  test("persists MCP servers inside the agent settings entry", async () => {
    await settingsManager.initialize();
    settingsManager.setMcpServers("agent-mcp-persist", [
      {
        name: "exa",
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
      },
    ]);
    await settingsManager.flush();
    await settingsManager.reset();
    await settingsManager.initialize();

    expect(settingsManager.getMcpServers("agent-mcp-persist")).toEqual([
      {
        name: "exa",
        transport: "http",
        url: "https://mcp.exa.ai/mcp",
      },
    ]);
  });
});
