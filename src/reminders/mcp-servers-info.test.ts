import { describe, expect, test } from "bun:test";
import {
  type AgentReminderContext,
  buildMcpServersInfoReminderText,
  type McpServersReminderDependencies,
} from "./engine";
import { buildListenReminderContext } from "./listen-context";
import {
  createSharedReminderState,
  markPostCompactionContextRemindersPending,
} from "./state";

const MCP_AGENT_ID = "agent-reminder-mcp";

async function buildReminder(
  state: ReturnType<typeof createSharedReminderState>,
  deps: McpServersReminderDependencies,
  mcpServers?: AgentReminderContext["mcpServers"],
) {
  return await buildMcpServersInfoReminderText(
    buildListenReminderContext({ agentId: MCP_AGENT_ID, state, mcpServers }),
    deps,
  );
}

describe("mcp servers info reminder", () => {
  test("reports None once when no servers are available", async () => {
    const state = createSharedReminderState();
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => null,
    };

    const initial = await buildReminder(state, deps);
    expect(initial).toContain("MCP servers with available tools: None");

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

  test("uses included attachments immediately without discovery or tool-count requests", async () => {
    const state = createSharedReminderState();
    const servers = [
      { id: "mcp-1", server_name: "exa", mcp_server_type: "streamable_http" },
    ];
    let discoveryCalls = 0;
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => {
        discoveryCalls++;
        throw new Error("Included relationships must not invoke discovery");
      },
    };

    expect(await buildReminder(state, deps, [])).toContain(
      "MCP servers with available tools: None",
    );

    expect(await buildReminder(state, deps, servers)).toContain(
      "MCP servers with available tools: exa\n",
    );

    // Unchanged lists do not add duplicate reminders.
    expect(await buildReminder(state, deps, servers)).toBeNull();
    markPostCompactionContextRemindersPending(state);
    expect(await buildReminder(state, deps, servers)).toContain(
      "MCP servers with available tools: exa\n",
    );

    expect(await buildReminder(state, deps, [])).toContain(
      "MCP servers with available tools: None",
    );
    expect(discoveryCalls).toBe(0);
  });

  test("keeps local servers alongside an explicitly empty cloud relationship", async () => {
    const text = await buildReminder(
      createSharedReminderState(),
      {
        getLocalServerNames: () => ["filesystem"],
        listServerSideServers: async () => {
          throw new Error("Unexpected fallback discovery");
        },
      },
      [],
    );
    expect(text).toContain("MCP servers with available tools: filesystem\n");
  });

  test("retains throttled discovery only when the relationship is absent", async () => {
    const state = createSharedReminderState();
    let servers = [{ name: "exa", toolCount: 2 }];
    let discoveryCalls = 0;
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => {
        discoveryCalls++;
        return servers;
      },
    };
    expect(await buildReminder(state, deps)).toContain("exa (2 tools)");
    servers = [];
    expect(await buildReminder(state, deps)).toBeNull();
    expect(discoveryCalls).toBe(1);
    state.lastMcpServersFetchedAtMs = 0;
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: None",
    );
    expect(discoveryCalls).toBe(2);

    // A new-server response bypasses even a just-refreshed compatibility cache.
    expect(
      await buildReminder(state, deps, [
        {
          id: "mcp-2",
          server_name: "betterstack",
          mcp_server_type: "streamable_http",
        },
      ]),
    ).toContain("MCP servers with available tools: betterstack\n");
    expect(discoveryCalls).toBe(2);
  });
});
