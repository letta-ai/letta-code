import { afterEach, describe, expect, test } from "bun:test";
import { resetMcpOriginatorAuthority } from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import {
  createMcpSubprocessBroker,
  createMcpSubprocessBrokerClient,
} from "@/backend/api/mcp-subprocess-broker";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import { getMcpScopeAgentId } from "@/mcp-scope";
import { runWithRuntimeContext } from "@/runtime-context";
import { callAgentMcpTool, type McpSubcommandDependencies } from "./mcp";

/**
 * USER_SCOPED_MCP_CONNECTIONS: an MCP tool-run made inside a listener turn
 * attributed to a cloud super run forwards that run's originator token as the
 * `x-letta-mcp-originator-token` header with the isolation compatibility marker.
 * Unattributed calls omit both headers.
 */
describe("MCP originator token forwarding", () => {
  afterEach(() => {
    clearMcpOriginatorTokens();
    resetMcpOriginatorAuthority();
  });

  function originatorHarness() {
    const serverPath = "/v1/agents/agent-cloud/mcp-servers";
    const toolsPath = `${serverPath}/mcp-1/tools`;
    const runPath = `${toolsPath}/tool-1/run`;
    const requests: Array<{
      path: string;
      body: unknown;
      headers?: Record<string, string>;
    }> = [];
    const client: UnifiedMcpClient = {
      get: async (path) => {
        if (path === serverPath) {
          return [
            {
              id: "mcp-1",
              server_name: "github",
              mcp_server_type: "streamable_http",
              server_url: "https://mcp.example.com/mcp",
            },
          ];
        }
        if (path === toolsPath) {
          return [
            {
              id: "tool-1",
              name: "mcp__github__create_issue",
              json_schema: { parameters: { type: "object" } },
            },
          ];
        }
        return [];
      },
      post: async (path, options) => {
        requests.push({
          path,
          body: options?.body,
          headers: options?.headers,
        });
        return { status: "success", func_return: "ok" };
      },
    };
    const deps: McpSubcommandDependencies = {
      env: { LETTA_AGENT_ID: "agent-cloud" },
      initializeSettings: async () => {},
      isServerMcpAvailable: () => true,
      getLocalServers: () => [],
      getClient: async () => client,
    };
    return { deps, requests, runPath };
  }

  test("forwards the held token when the call runs inside an attributed super run", async () => {
    const { deps, requests, runPath } = originatorHarness();
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");

    await runWithRuntimeContext({ mcpOriginatorSuperRunId: "sr-1" }, async () =>
      callAgentMcpTool(
        "agent-cloud",
        "mcp__github__create_issue",
        { title: "Bug" },
        deps,
      ),
    );

    expect(requests).toEqual([
      {
        path: runPath,
        body: { args: { title: "Bug" } },
        headers: {
          "x-letta-mcp-originator-token": "mst_one.secret-a",
          "x-letta-mcp-originator-isolation": "1",
        },
      },
    ]);
  });

  test("omits the header when no token is held for the active super run", async () => {
    const { deps, requests, runPath } = originatorHarness();
    // A token held for a DIFFERENT run must neither be attached nor leak
    // into the miss warning (e.g. after a listener restart replays an
    // acknowledged input with an empty store).
    setMcpOriginatorToken("sr-other", "mst_other.secret-do-not-leak");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (message?: unknown) => {
      warnings.push(String(message));
    };

    try {
      await runWithRuntimeContext(
        { mcpOriginatorSuperRunId: "sr-unattributed" },
        async () =>
          callAgentMcpTool(
            "agent-cloud",
            "mcp__github__create_issue",
            { title: "Bug" },
            deps,
          ),
      );
    } finally {
      console.warn = originalWarn;
    }

    expect(requests).toEqual([
      { path: runPath, body: { args: { title: "Bug" } }, headers: undefined },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("sr-unattributed");
    expect(warnings[0]).not.toContain("secret-do-not-leak");
    expect(warnings[0]).not.toContain("mst_");
  });

  test("omits the header outside any super run context (plain CLI)", async () => {
    const { deps, requests, runPath } = originatorHarness();
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");

    await callAgentMcpTool(
      "agent-cloud",
      "mcp__github__create_issue",
      { title: "Bug" },
      deps,
    );

    expect(requests).toEqual([
      { path: runPath, body: { args: { title: "Bug" } }, headers: undefined },
    ]);
  });

  test("keeps originator authority in the inherited parent when a shell child calls MCP", async () => {
    const { deps, requests, runPath } = originatorHarness();
    const upstreamClient = await deps.getClient?.();
    if (!upstreamClient) throw new Error("Missing MCP test client");
    setMcpOriginatorToken("sr-1", "mst_one.secret-a");
    let activeSuperRunId: string | null = "sr-1";
    const broker = createMcpSubprocessBroker({
      agentId: "agent-child",
      getAllowedAgentIds: async () => {
        const inheritedAgentId = await getMcpScopeAgentId(
          "agent-child",
          {
            LETTA_CODE_AGENT_ROLE: "subagent",
            LETTA_PARENT_AGENT_ID: "agent-cloud",
          },
          async (agentId) =>
            agentId === "agent-child" ? "agent-cloud" : undefined,
        );
        return new Set(["agent-child", inheritedAgentId]);
      },
      getScope: () => ({
        agentId: "agent-child",
        ...(activeSuperRunId
          ? {
              originatorToken:
                activeSuperRunId === "sr-1" ? "mst_one.secret-a" : undefined,
            }
          : {}),
      }),
      getClient: async () => upstreamClient,
    });

    try {
      expect(JSON.stringify(broker.env)).not.toContain("mst_one.secret-a");
      const childClient = createMcpSubprocessBrokerClient(broker.env);
      expect(childClient).not.toBeNull();
      const { getClient: _parentClient, ...childBaseDeps } = deps;
      const childDeps: McpSubcommandDependencies = {
        ...childBaseDeps,
        env: { ...deps.env, ...broker.env },
      };

      await callAgentMcpTool(
        "agent-cloud",
        "mcp__github__create_issue",
        { title: "First" },
        childDeps,
      );
      activeSuperRunId = null;
      await callAgentMcpTool(
        "agent-cloud",
        "mcp__github__create_issue",
        { title: "Second" },
        childDeps,
      );

      expect(requests).toEqual([
        {
          path: runPath,
          body: { args: { title: "First" } },
          headers: {
            "x-letta-mcp-originator-token": "mst_one.secret-a",
            "x-letta-mcp-originator-isolation": "1",
          },
        },
        {
          path: runPath,
          body: { args: { title: "Second" } },
          headers: undefined,
        },
      ]);
    } finally {
      broker.close();
    }
  });
});
