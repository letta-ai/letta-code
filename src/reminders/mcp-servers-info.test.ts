import { describe, expect, test } from "bun:test";
import {
  buildMcpServersInfoReminderText,
  type McpServersReminderDependencies,
} from "./engine";
import { createSharedReminderState } from "./state";

const MCP_AGENT_ID = "agent-reminder-mcp";

async function buildReminder(
  state: ReturnType<typeof createSharedReminderState>,
  deps: McpServersReminderDependencies,
) {
  return await buildMcpServersInfoReminderText(
    { agent: { id: MCP_AGENT_ID, name: null }, state },
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
    expect(text).toContain("letta mcp tools <server> [--full]");
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

  test("re-emits when the server list changes after the refresh interval", async () => {
    const state = createSharedReminderState();
    let servers = [{ name: "exa", toolCount: 2 }];
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => [...servers],
    };

    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: exa (2 tools)",
    );

    servers = [
      { name: "exa", toolCount: 2 },
      { name: "betterstack", toolCount: 111 },
    ];
    // Within the refresh interval nothing is re-fetched or emitted.
    expect(await buildReminder(state, deps)).toBeNull();

    // Force the refresh window to elapse.
    state.lastMcpServersFetchedAtMs = 0;
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: exa (2 tools), betterstack (111 tools)",
    );

    // Unchanged list after another elapsed window stays silent.
    state.lastMcpServersFetchedAtMs = 0;
    expect(await buildReminder(state, deps)).toBeNull();
  });
});
