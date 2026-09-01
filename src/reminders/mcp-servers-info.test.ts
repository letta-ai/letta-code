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
      listServerSideNames: async () => null,
    };

    const initial = await buildReminder(state, deps);
    expect(initial).toContain("MCP servers with available tools: None");

    expect(await buildReminder(state, deps)).toBeNull();
  });

  test("lists local and cloud server names with usage instructions", async () => {
    const state = createSharedReminderState();
    const text = await buildReminder(state, {
      getLocalServerNames: () => ["exa"],
      listServerSideNames: async () => ["betterstack", "exa"],
    });

    expect(text).toContain(
      "MCP servers with available tools: exa, betterstack",
    );
    expect(text).toContain('letta mcp search "<what you want to do>"');
    expect(text).toContain("letta mcp call <tool-name>");
  });

  test("stays silent when an available backend fails to list servers", async () => {
    const state = createSharedReminderState();
    const text = await buildReminder(state, {
      getLocalServerNames: () => ["exa"],
      listServerSideNames: async () => {
        throw new Error("api down");
      },
    });
    expect(text).toBeNull();
    expect(state.hasSentMcpServersInfo).toBe(false);
  });

  test("re-emits when the server list changes after the refresh interval", async () => {
    const state = createSharedReminderState();
    let names = ["exa"];
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [...names],
      listServerSideNames: async () => null,
    };

    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: exa",
    );

    names = ["exa", "betterstack"];
    // Within the refresh interval nothing is re-fetched or emitted.
    expect(await buildReminder(state, deps)).toBeNull();

    // Force the refresh window to elapse.
    state.lastMcpServersFetchedAtMs = 0;
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: exa, betterstack",
    );

    // Unchanged list after another elapsed window stays silent.
    state.lastMcpServersFetchedAtMs = 0;
    expect(await buildReminder(state, deps)).toBeNull();
  });
});
