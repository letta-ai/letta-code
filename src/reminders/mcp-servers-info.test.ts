import { describe, expect, spyOn, test } from "bun:test";
import { __testSetBackend, getBackend } from "@/backend";
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
          listServerSideServers: async (id, timeoutMs) => {
            expect(timeoutMs).toBe(3_000);
            expect(id).toBe("parent");
            return [{ name: "linear", toolCount: 3 }];
          },
        }),
    );
    expect(text).toContain("filesystem, linear (3 tools)");
  });
  test("skips the reminder when the backend has no server-side MCP and no local servers exist", async () => {
    const state = createSharedReminderState();
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => null,
    };

    expect(await buildReminder(state, deps)).toBeNull();
    expect(state.lastSentMcpServerNamesKey).toBeNull();
    expect(await buildReminder(state, deps)).toBeNull();

    // Compaction re-arms the reminder but still has nothing to announce.
    markPostCompactionContextRemindersPending(state);
    expect(await buildReminder(state, deps)).toBeNull();
  });

  test("reports None once when server-side MCP returns no servers", async () => {
    const state = createSharedReminderState();
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [],
      listServerSideServers: async () => [],
    };

    const initial = await buildReminder(state, deps);
    expect(initial).toContain("MCP servers with available tools: None");
    expect(initial).toContain(
      "Do not automatically store results of principal-restricted operations in shared memory.",
    );

    expect(await buildReminder(state, deps)).toBeNull();
  });

  test("announces local servers added later and reports None once they are removed", async () => {
    const state = createSharedReminderState();
    let localNames: string[] = [];
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [...localNames],
      listServerSideServers: async () => null,
    };

    expect(await buildReminder(state, deps)).toBeNull();

    localNames = ["filesystem"];
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: filesystem",
    );
    expect(await buildReminder(state, deps)).toBeNull();

    localNames = [];
    const removed = await buildReminder(state, deps);
    expect(removed).toContain("MCP servers with available tools: None");
    expect(removed).toContain(
      "Do not automatically store results of principal-restricted operations in shared memory.",
    );
    expect(await buildReminder(state, deps)).toBeNull();

    // Servers were announced in this session, so compaction re-sends None.
    markPostCompactionContextRemindersPending(state);
    expect(await buildReminder(state, deps)).toContain(
      "MCP servers with available tools: None",
    );
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
    expect(text).toContain("--args-file <path>");
    expect(text).toContain(
      "Exit code 2 means the tool returned an error result",
    );
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

  test("a failed first discovery does not count as announced", async () => {
    const state = createSharedReminderState();
    let localNames = ["filesystem"];
    const deps: McpServersReminderDependencies = {
      getLocalServerNames: () => [...localNames],
      listServerSideServers: async () => {
        throw new Error("api down");
      },
    };
    expect(await buildReminder(state, deps)).toBeNull();
    expect(state.lastSentMcpServerNamesKey).toBeNull();

    localNames = [];
    expect(
      await buildReminder(state, {
        ...deps,
        listServerSideServers: async () => null,
      }),
    ).toBeNull();

    localNames = ["filesystem"];
    expect(
      await buildReminder(state, {
        ...deps,
        listServerSideServers: async () => null,
      }),
    ).toContain("MCP servers with available tools: filesystem");
  });
});

test("MCP reminder uses cached counts without requesting tool lists", async () => {
  const previousBackend = getBackend();
  const urlSpy = spyOn(serverUrl, "getServerUrl").mockReturnValue(
    "http://localhost:8283",
  );
  const backend = new FakeHeadlessBackend(MCP_AGENT_ID);
  Object.defineProperty(backend, "capabilities", {
    value: { ...backend.capabilities, serverSideToolManagement: true },
  });
  const requests: string[] = [];
  let count = 53;
  __testSetBackend(backend);
  __testOverrideGetClient(async () => ({
    get: async (path: string) => {
      requests.push(path);
      if (path !== `/v1/agents/${MCP_AGENT_ID}/mcp-servers`) {
        throw new Error("Unexpected request");
      }
      return [
        { id: "mail", server_name: "mail", cached_num_tools: count },
        { id: "empty", server_name: "empty", cached_num_tools: 0 },
        { id: "unknown", server_name: "unknown", cached_num_tools: null },
        { id: "legacy", server_name: "legacy" },
      ];
    },
    mcpServers: { list: async () => [{ id: "mail", mcp_server_type: "sse" }] },
  }));
  try {
    const state = createSharedReminderState();
    const deps = { getLocalServerNames: () => [] };
    expect(await buildReminder(state, deps)).toContain(
      "available tools: mail (53 tools), empty (0 tools), unknown, legacy\n",
    );
    count = 1;
    expect(await buildReminder(state, deps)).toContain("mail (1 tool)");
    expect(requests).toEqual(
      Array(2).fill(`/v1/agents/${MCP_AGENT_ID}/mcp-servers`),
    );
  } finally {
    urlSpy.mockRestore();
    __testOverrideGetClient(null);
    __testSetBackend(previousBackend);
  }
});
