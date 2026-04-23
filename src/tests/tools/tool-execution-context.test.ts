import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "../../channels/accounts";
import { clearDynamicMessageChannelToolCache } from "../../channels/messageTool";
import { ChannelRegistry, getChannelRegistry } from "../../channels/registry";
import type { ChannelAdapter } from "../../channels/types";
import { runWithRuntimeContext } from "../../runtime-context";
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
import { resolveConversationChannelToolScope } from "../../tools/toolset";

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
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
  });

  function installChannelAccountTestOverrides(): void {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
  }

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

  test("captures scoped working directories per execution context", async () => {
    await loadSpecificTools(["Read"]);

    const tempRoot = mkdtempSync(join(tmpdir(), "tool-context-scope-"));
    const dirA = join(tempRoot, "agent-a");
    const dirB = join(tempRoot, "agent-b");
    const fileName = "scope.txt";

    try {
      mkdirSync(dirA, { recursive: true });
      mkdirSync(dirB, { recursive: true });
      writeFileSync(join(dirA, fileName), "from-agent-a", "utf8");
      writeFileSync(join(dirB, fileName), "from-agent-b", "utf8");

      const contextA = runWithRuntimeContext(
        {
          agentId: "agent-a",
          conversationId: "conv-a",
          workingDirectory: dirA,
        },
        () => captureToolExecutionContext(),
      );
      const contextB = runWithRuntimeContext(
        {
          agentId: "agent-b",
          conversationId: "conv-b",
          workingDirectory: dirB,
        },
        () => captureToolExecutionContext(),
      );

      const resultA = await executeTool(
        "Read",
        { file_path: fileName },
        { toolContextId: contextA.contextId },
      );
      const resultB = await executeTool(
        "Read",
        { file_path: fileName },
        { toolContextId: contextB.contextId },
      );

      expect(asText(resultA.toolReturn)).toContain("from-agent-a");
      expect(asText(resultB.toolReturn)).toContain("from-agent-b");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
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

  test("includes MessageChannel in scoped snapshots when the agent has an eligible proactive Slack account even without routes", async () => {
    installChannelAccountTestOverrides();
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));

    upsertChannelAccount("slack", {
      channel: "slack",
      accountId: "acct-slack",
      displayName: "DocsBot Slack",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      mode: "socket",
      botToken: "xoxb-test-token",
      appToken: "xapp-test-token",
      agentId: "agent-1",
      defaultPermissionMode: "default",
    });

    const scope = resolveConversationChannelToolScope("agent-1", "default");
    expect(scope).toEqual({
      channels: [{ channelId: "slack", accountId: "acct-slack" }],
    });

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
      {
        channelToolScope: scope,
      },
    );

    expect(prepared.loadedToolNames).toContain("MessageChannel");
  });

  test("does not grant proactive MessageChannel scope for Telegram-only accounts", async () => {
    installChannelAccountTestOverrides();
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("telegram", "acct-telegram"));

    upsertChannelAccount("telegram", {
      channel: "telegram",
      accountId: "acct-telegram",
      displayName: "Telegram Bot",
      enabled: true,
      dmPolicy: "pairing",
      allowedUsers: [],
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
      token: "telegram-token",
      binding: {
        agentId: "agent-1",
        conversationId: "default",
      },
    });

    const scope = resolveConversationChannelToolScope("agent-1", "default");
    expect(scope).toEqual({ channels: [] });

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
      {
        channelToolScope: scope,
      },
    );

    expect(prepared.loadedToolNames).not.toContain("MessageChannel");
  });
});
