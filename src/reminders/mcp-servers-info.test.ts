import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { LETTA_CLOUD_API_URL } from "@/auth/oauth";
import { __testSetBackend } from "@/backend";
import { __testOverrideGetClient } from "@/backend/api/client";
import * as serverUrl from "@/backend/api/server-url";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { runWithRuntimeContext } from "@/runtime-context";
import {
  buildMcpServersInfoReminderText,
  type McpServersReminderDependencies,
} from "./engine";
import {
  createSharedReminderState,
  markPostCompactionContextRemindersPending,
} from "./state";

const MCP_AGENT_ID = "agent-reminder-mcp";

async function buildReminder(
  state: ReturnType<typeof createSharedReminderState>,
  deps: McpServersReminderDependencies,
) {
  return await buildMcpServersInfoReminderText(
    { agent: { id: MCP_AGENT_ID, name: null }, state },
    { lookupParentAgent: async () => undefined, ...deps },
  );
}

describe("mcp servers info reminder", () => {
  test("fresh workers discover both MCP placements using the inherited scope", async () => {
    const text = await runWithRuntimeContext(
      {
        executionSettings: {
          allowed_tools: [],
          disallowed_tools: [],
          disable_memory_guard: false,
          parent_agent_id: "parent",
          agent_role: "subagent",
        },
      },
      () =>
        buildReminder(createSharedReminderState(), {
          lookupParentAgent: async (id) =>
            id === MCP_AGENT_ID ? "parent" : undefined,
          getLocalServerNames: (id) => {
            expect(id).toBe("parent");
            return ["filesystem"];
          },
          listServerSideServers: async (id) => {
            expect(id).toBe("parent");
            return [{ name: "linear", toolCount: 3 }];
          },
        }),
    );
    expect(text).toContain("filesystem, linear (3 tools)");
  });
  test("reports None once when no servers are available", async () => {
    const state = createSharedReminderState();
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => null,
    };

    const initial = await buildReminder(state, deps);
    expect(initial).toContain("MCP servers with available tools: None");
    expect(initial).toContain(
      "Do not automatically store results of principal-restricted operations in shared memory.",
    );

    expect(await buildReminder(state, deps)).toBeNull();
  });

  test("lists local and cloud servers with tool counts and usage instructions", async () => {
    const state = createSharedReminderState();
    const text = await buildReminder(state, {
      getLocalServerNames: () => ["filesystem"],
      listServerSideServers: async () => [
        { name: "betterstack", toolCount: 111 },
        { name: "Exa", toolCount: 1 },
        { name: "uncounted", toolCount: null },
      ],
    });

    expect(text).toContain(
      "MCP servers with available tools: filesystem, betterstack (111 tools), Exa (1 tool), uncounted",
    );
    expect(text).toContain('letta mcp search "<what you want to do>"');
    expect(text).toContain("letta mcp tools <server>");
    expect(text).toContain("letta mcp schema <tool-name>");
    expect(text).toContain("letta mcp call <tool-name>");
    expect(text).toContain(
      "Do not automatically store results of principal-restricted operations in shared memory.",
    );
  });

  test("stays silent when an available backend fails to list servers", async () => {
    const state = createSharedReminderState();
    const text = await buildReminder(state, {
      getLocalServerNames: () => ["exa"],
      listServerSideServers: async () => {
        throw new Error("api down");
      },
    });
    expect(text).toBeNull();
    expect(state.hasSentMcpServersInfo).toBe(false);
  });

  test("reports attachments and detachments on the next turn without waiting", async () => {
    const state = createSharedReminderState();
    let servers: Array<{ name: string; toolCount: number }> = [];
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => [...servers],
    };

    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: None",
    );

    servers = [
      { name: "exa", toolCount: 2 },
      { name: "betterstack", toolCount: 111 },
    ];
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: exa (2 tools), betterstack (111 tools)",
    );

    // Unchanged lists do not add duplicate reminders.
    expect(await buildReminder(state, deps)).toBeNull();

    servers = [];
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: None",
    );
  });

  test("retries discovery next turn after failure without losing the last sent list", async () => {
    const state = createSharedReminderState();
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => [{ name: "exa", toolCount: 2 }],
    };
    await buildReminder(state, deps);
    const lastSent = state.lastSentMcpServerNamesKey;
    expect(
      await buildReminder(state, {
        ...deps,
        listServerSideServers: async () => {
          throw new Error("api down");
        },
      }),
    ).toBeNull();
    expect(state.lastSentMcpServerNamesKey).toBe(lastSent);
    expect(
      await buildReminder(state, {
        ...deps,
        listServerSideServers: async () => [],
      }),
    ).toContain("MCP servers with available tools: None");
  });
});

describe("MCP reminder API discovery", () => {
  afterEach(() => {
    mock.restore();
    __testOverrideGetClient(null);
    __testSetBackend(null);
  });

  test.each([LETTA_CLOUD_API_URL, "http://localhost:8283"])(
    "discovers fresh attachments without listing tools on %s",
    async (baseUrl) => {
      spyOn(serverUrl, "getServerUrl").mockReturnValue(baseUrl);
      const backend = new FakeHeadlessBackend(MCP_AGENT_ID);
      Object.defineProperty(backend, "capabilities", {
        value: { ...backend.capabilities, serverSideToolManagement: true },
      });
      __testSetBackend(backend);
      let servers = [
        { id: "remote", server_name: "search", mcp_server_type: "sse" },
        { id: "local", server_name: "stdio", mcp_server_type: "stdio" },
      ];
      const requests: string[] = [];
      let failDiscovery = false;
      __testOverrideGetClient(async () => ({
        get: async (path: string) => {
          requests.push(path);
          if (path.endsWith("/tools"))
            throw new Error("tool listing must not run");
          if (failDiscovery) throw new Error("discovery unavailable");
          return servers;
        },
      }));
      const state = createSharedReminderState();
      let localNames = ["filesystem"];
      const deps = { getLocalServerNames: () => localNames };
      const initial = await buildReminder(state, deps);
      expect(initial).toContain("filesystem, search");
      expect(initial?.includes(", stdio")).toBe(
        baseUrl !== LETTA_CLOUD_API_URL,
      );
      expect(initial).not.toContain(" tools)");
      expect(await buildReminder(state, deps)).toBeNull();

      servers = [
        { id: "new", server_name: "calendar", mcp_server_type: "sse" },
      ];
      expect(await buildReminder(state, deps)).toContain(
        "filesystem, calendar",
      );
      const lastSent = state.lastSentMcpServerNamesKey;
      failDiscovery = true;
      expect(await buildReminder(state, deps)).toBeNull();
      expect(state.lastSentMcpServerNamesKey).toBe(lastSent);
      failDiscovery = false;
      servers = [];
      expect(await buildReminder(state, deps)).toContain(
        "available tools: filesystem",
      );
      markPostCompactionContextRemindersPending(state);
      expect(await buildReminder(state, deps)).toContain(
        "available tools: filesystem",
      );
      localNames = [];
      expect(await buildReminder(state, deps)).toContain(
        "available tools: None",
      );
      expect(requests).toEqual(
        Array(7).fill(`/v1/agents/${MCP_AGENT_ID}/mcp-servers`),
      );
    },
  );
});
