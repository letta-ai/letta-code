import { expect, test } from "bun:test";
import {
  callCloudTool,
  getCloudToolsClient,
  listCloudTools,
} from "./cloud-tools";
import {
  createMcpSubprocessBroker,
  createMcpSubprocessBrokerClient,
} from "./mcp-subprocess-broker";

test("broker forwards only exact cloud tool routes with fresh parent proof", async () => {
  let token = "first-proof";
  const requests: Array<{ path: string; options: unknown }> = [];
  const broker = createMcpSubprocessBroker({
    agentId: "parent",
    getScope: () => ({ agentId: "parent", originatorToken: token }),
    getClient: async () => ({
      get: async () => null,
      post: async (path, options) => {
        requests.push({ path, options });
        return path.endsWith("/list")
          ? { serverName: "example", instructions: "context", tools: [] }
          : { content: [{ type: "text", text: "result" }] };
      },
    }),
  });
  try {
    expect(JSON.stringify(broker.env)).not.toContain(token);
    const client = createMcpSubprocessBrokerClient(broker.env);
    if (!client) throw new Error("missing broker");
    await listCloudTools(client);
    token = "second-proof";
    await callCloudTool(client, "future_tool", {});
    expect(requests).toEqual([
      {
        path: "/v1/subagent-tools/list",
        options: {
          body: {},
          headers: {
            "x-letta-mcp-originator-token": "first-proof",
            "x-letta-mcp-originator-isolation": "1",
          },
        },
      },
      {
        path: "/v1/subagent-tools/call",
        options: {
          body: { name: "future_tool", arguments: {} },
          headers: {
            "x-letta-mcp-originator-token": "second-proof",
            "x-letta-mcp-originator-isolation": "1",
          },
        },
      },
    ]);
    for (const path of [
      "/v1/subagent-tools/call?agent=other",
      "/v1/subagent-tools/../agents",
      "/v1/subagent-tools/delete",
    ])
      await expect(client.post(path)).rejects.toThrow();
    await expect(client.get("/v1/subagent-tools/list")).rejects.toThrow();
    expect(requests).toHaveLength(2);
  } finally {
    broker.close();
  }
});

test("local MCP commands never initialize cloud credentials for optional tools", async () => {
  const { resolveBackendMode, setConfiguredBackendMode } = await import(
    "@/backend/backend-mode"
  );
  const previous = resolveBackendMode();
  setConfiguredBackendMode("local");
  try {
    await expect(getCloudToolsClient({})).rejects.toThrow(
      "require the API backend",
    );
  } finally {
    setConfiguredBackendMode(previous);
  }
});

test("an injected local backend cannot discover API tools under an API mode flag", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { getBackend, __testSetBackend } = await import("@/backend");
  const { LocalBackend } = await import("@/backend/local");
  const { resolveBackendMode, setConfiguredBackendMode } = await import(
    "@/backend/backend-mode"
  );
  const previousBackend = getBackend();
  const previousMode = resolveBackendMode();
  const storageDir = await mkdtemp(join(tmpdir(), "local-cloud-tools-"));
  setConfiguredBackendMode("api");
  __testSetBackend(new LocalBackend({ storageDir, memfsEnabled: false }));
  try {
    await expect(getCloudToolsClient({})).rejects.toThrow(
      "does not support API tools",
    );
  } finally {
    __testSetBackend(previousBackend);
    setConfiguredBackendMode(previousMode);
    await rm(storageDir, { recursive: true, force: true });
  }
});
