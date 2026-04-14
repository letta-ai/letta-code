import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { clearDynamicMessageChannelToolCache } from "../../channels/messageTool";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type { ChannelAdapter } from "../../channels/types";
import {
  captureToolExecutionContext,
  clearCapturedToolExecutionContexts,
  clearExternalTools,
  clearTools,
  executeTool,
  getToolNames,
  getToolSchema,
  loadSpecificTools,
  prepareCurrentToolExecutionContext,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
  refreshDynamicChannelToolsInLoadedRegistry,
} from "../../tools/manager";

function asText(
  toolReturn: Awaited<ReturnType<typeof executeTool>>["toolReturn"],
) {
  return typeof toolReturn === "string"
    ? toolReturn
    : JSON.stringify(toolReturn);
}

describe("tool execution context snapshot", () => {
  let initialTools: string[] = [];

  function createRunningAdapter(
    channelId: "slack" | "telegram",
    accountId: string,
  ): ChannelAdapter {
    return {
      id: `${channelId}:${accountId}`,
      channelId,
      accountId,
      name: channelId,
      start: async () => {},
      stop: async () => {},
      isRunning: () => true,
      sendMessage: async () => ({ messageId: "msg-1" }),
      sendDirectReply: async () => {},
    };
  }

  beforeAll(() => {
    initialTools = getToolNames();
  });

  afterEach(async () => {
    const registry = getChannelRegistry();
    if (registry) {
      await registry.stopAll();
    }
    clearDynamicMessageChannelToolCache();
    clearCapturedToolExecutionContexts();
  });

  afterAll(async () => {
    clearExternalTools();
    if (initialTools.length > 0) {
      await loadSpecificTools(initialTools);
    } else {
      clearTools();
    }
  });

  test("executes Read using captured context after global toolset changes", async () => {
    await loadSpecificTools(["Read"]);
    const { contextId } = captureToolExecutionContext();

    await loadSpecificTools(["ReadFile"]);

    const withoutContext = await executeTool("Read", {
      file_path: "README.md",
    });
    expect(withoutContext.status).toBe("error");
    expect(asText(withoutContext.toolReturn)).toContain("Tool not found: Read");

    const withContext = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: contextId },
    );
    expect(withContext.status).toBe("success");
  });

  test("executes ReadFile using captured context after global toolset changes", async () => {
    await loadSpecificTools(["ReadFile"]);
    const { contextId } = captureToolExecutionContext();

    await loadSpecificTools(["Read"]);

    const withoutContext = await executeTool("ReadFile", {
      file_path: "README.md",
    });
    expect(withoutContext.status).toBe("error");
    expect(asText(withoutContext.toolReturn)).toContain(
      "Tool not found: ReadFile",
    );

    const withContext = await executeTool(
      "ReadFile",
      { file_path: "README.md" },
      { toolContextId: contextId },
    );
    expect(withContext.status).toBe("success");
  });

  test("prepares explicit tool snapshots without reading the global registry", async () => {
    await loadSpecificTools(["Edit"]);

    const prepared = await prepareToolExecutionContextForSpecificTools([
      "Read",
    ]);

    expect(prepared.loadedToolNames).toContain("Read");
    expect(prepared.loadedToolNames).not.toContain("Edit");

    const withPreparedContext = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: prepared.contextId },
    );

    expect(withPreparedContext.status).toBe("success");
  });

  test("prepares current tool snapshots with fresh MessageChannel discovery", async () => {
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));

    const prepared = await prepareCurrentToolExecutionContext();
    const messageChannel = prepared.clientTools.find(
      (tool) => tool.name === "MessageChannel",
    );

    expect(prepared.loadedToolNames).toContain("MessageChannel");
    expect(messageChannel).toBeDefined();
    expect(messageChannel?.description).toContain(
      "Currently active channels: Slack.",
    );

    if (!messageChannel) {
      throw new Error("MessageChannel tool was not prepared");
    }

    if (!messageChannel.parameters) {
      throw new Error("MessageChannel tool is missing parameters");
    }

    const actionParameter = (
      messageChannel.parameters.properties as Record<
        string,
        { enum?: string[] }
      >
    ).action;

    expect(actionParameter?.enum).toEqual(["send", "react", "upload-file"]);
  });

  test("refreshes the loaded MessageChannel schema for synchronous readers", async () => {
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    await refreshDynamicChannelToolsInLoadedRegistry();

    const schema = getToolSchema("MessageChannel");
    expect(schema?.description).toContain(
      "Currently active channels: Telegram.",
    );
    expect(
      (schema?.input_schema.properties?.channel as { enum?: string[] }).enum,
    ).toEqual(["telegram"]);
  });

  test("omits MessageChannel from scoped snapshots when the conversation has no bound channel routes", async () => {
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
      {
        channelToolScope: { channels: [] },
      },
    );

    expect(prepared.loadedToolNames).not.toContain("MessageChannel");
    expect(
      prepared.clientTools.some((tool) => tool.name === "MessageChannel"),
    ).toBe(false);
  });

  test("preserves scoped MessageChannel discovery even when the global cache was seeded differently", async () => {
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    await refreshDynamicChannelToolsInLoadedRegistry();

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
      {
        channelToolScope: {
          channels: [{ channelId: "slack", accountId: "acct-slack" }],
        },
      },
    );
    const messageChannel = prepared.clientTools.find(
      (tool) => tool.name === "MessageChannel",
    );

    expect(prepared.loadedToolNames).toContain("MessageChannel");
    expect(messageChannel?.description).toContain(
      "Currently active channels: Slack.",
    );
    expect(messageChannel?.description).not.toContain("Telegram");
    expect(
      (
        messageChannel?.parameters?.properties as Record<
          string,
          { enum?: string[] }
        >
      ).channel?.enum,
    ).toEqual(["slack"]);
  });
});
