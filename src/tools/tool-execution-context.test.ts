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
import type { Message } from "@letta-ai/letta-client/resources/agents/messages";
import { __testSetBackend, type Backend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  __testOverrideLoadChannelAccounts,
  __testOverrideSaveChannelAccounts,
  clearChannelAccountStores,
  upsertChannelAccount,
} from "@/channels/accounts";
import { clearDynamicMessageChannelToolCache } from "@/channels/message-tool";
import { ChannelRegistry, getChannelRegistry } from "@/channels/registry";
import {
  __testOverrideLoadRoutes,
  __testOverrideSaveRoutes,
  clearAllRoutes,
  setRouteInMemory,
} from "@/channels/routing";
import type { ChannelAdapter } from "@/channels/types";
import {
  clearExtensionPermissions,
  registerExtensionPermission,
} from "@/extensions/permission-registry";
import {
  clearExtensionTools,
  registerExtensionTool,
} from "@/extensions/tool-registry";
import type { ExtensionToolStartEvent } from "@/extensions/types";
import {
  LETTA_INHERITED_CHANNEL_CONTEXT_ENV,
  runWithRuntimeContext,
} from "@/runtime-context";
import {
  captureToolExecutionContext,
  clearCapturedToolExecutionContexts,
  clearExternalTools,
  clearTools,
  executeTool,
  getExecutionContextById,
  getToolNames,
  getToolSchema,
  loadSpecificTools,
  prepareCurrentToolExecutionContext,
  prepareToolExecutionContextForModel,
  prepareToolExecutionContextForSpecificTools,
  refreshDynamicChannelToolsInLoadedRegistry,
  registerExternalTools,
} from "@/tools/manager";
import {
  prepareToolExecutionContextForScope,
  resolveConversationChannelToolScope,
} from "@/tools/toolset";

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

  function registerEchoExtensionTool(signal: AbortSignal): void {
    registerExtensionTool({
      name: "local_echo",
      description: "Echo input from a local extension",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
      owner: {
        id: "global:/tmp/local-echo.ts",
        path: "/tmp/local-echo.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/local-echo.ts",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: signal,
      getContext: () => {
        throw new Error("context should not be needed for this test");
      },
      isAvailable: () => true,
      run: (ctx) => `echo:${ctx.args.message}`,
    });
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
    clearExternalTools();
    clearExtensionPermissions();
    clearExtensionTools();
    clearAllRoutes();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    delete process.env[LETTA_INHERITED_CHANNEL_CONTEXT_ENV];
    __testSetBackend(null);
  });

  function installChannelAccountTestOverrides(): void {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
  }

  afterAll(async () => {
    clearExternalTools();
    clearExtensionPermissions();
    clearExtensionTools();
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

  test("rechecks extension permission overlays after tool_start arg transforms", async () => {
    await loadSpecificTools(["Read"]);
    registerExtensionPermission({
      id: "execution-gate",
      description: "Deny mutated reads",
      path: "/tmp/execution-gate.ts",
      owner: {
        id: "global:/tmp/execution-gate.ts",
        path: "/tmp/execution-gate.ts",
        scope: "global",
        generation: 1,
      },
      activationSignal: new AbortController().signal,
      getContext: () => {
        throw new Error("unused");
      },
      isAvailable: () => true,
      check(event) {
        if (
          event.phase === "execution" &&
          event.toolName === "Read" &&
          event.args.file_path === "package.json"
        ) {
          return { decision: "deny", reason: "mutated path blocked" };
        }
        return undefined;
      },
    });

    const prepared = await prepareCurrentToolExecutionContext({
      extensionEvents: {
        async emit(name, event) {
          if (name === "tool_start") {
            const toolStartEvent = event as ExtensionToolStartEvent;
            toolStartEvent.args = {
              ...toolStartEvent.args,
              file_path: "package.json",
            };
          }
          return { diagnostics: [], handlerCount: 0, name, results: [] };
        },
      },
    });

    const result = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("error");
    expect(asText(result.toolReturn)).toContain(
      "extension permission:execution-gate",
    );
    expect(asText(result.toolReturn)).toContain("mutated path blocked");
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

  test("Gemini models use the default Claude-style auto toolset", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "google_ai/gemini-2.5-pro",
    );

    expect(prepared.loadedToolNames).toContain("Read");
    expect(prepared.loadedToolNames).toContain("Write");
    expect(prepared.loadedToolNames).toContain("Bash");
    expect(prepared.loadedToolNames).not.toContain("ReadFileGemini");
    expect(prepared.loadedToolNames).not.toContain("WriteFileGemini");
    expect(prepared.loadedToolNames).not.toContain("RunShellCommand");
  });

  test("filters model-derived client tools by request-scoped allowlist", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["Read", "Grep", "Glob"] },
    );

    expect(prepared.loadedToolNames).toEqual(["Read"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(["Read"]);
    expect(prepared.loadedToolNames).not.toContain("Bash");

    const denied = await executeTool(
      "Bash",
      { command: "echo no", description: "Print no" },
      { toolContextId: prepared.contextId },
    );
    expect(denied.status).toBe("error");
    expect(asText(denied.toolReturn)).toContain("Tool not found: Bash");
  });

  test("empty request-scoped allowlist disables client tools", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: [] },
    );

    expect(prepared.loadedToolNames).toEqual([]);
    expect(prepared.clientTools).toEqual([]);
  });

  test("request-scoped allowlist accepts server-facing Agent alias", async () => {
    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["Agent"] },
    );

    expect(prepared.loadedToolNames).toEqual(["Task"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(["Agent"]);
  });

  test("request-scoped allowlist filters external tools by name", async () => {
    registerExternalTools([
      {
        name: "RemoteFoo",
        description: "Allowed external tool",
        parameters: { type: "object", properties: {}, required: [] },
      },
      {
        name: "RemoteBar",
        description: "Filtered external tool",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ]);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["Read", "RemoteFoo"] },
    );

    expect(prepared.loadedToolNames).toEqual(["Read"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "Read",
      "RemoteFoo",
    ]);
  });

  test("empty request-scoped allowlist disables external tools too", async () => {
    registerExternalTools([
      {
        name: "RemoteFoo",
        description: "External tool",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ]);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: [] },
    );

    expect(prepared.loadedToolNames).toEqual([]);
    expect(prepared.clientTools).toEqual([]);
  });

  test("prepares and executes extension tools from turn snapshots", async () => {
    const controller = new AbortController();
    registerEchoExtensionTool(controller.signal);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["local_echo"] },
    );

    expect(prepared.loadedToolNames).toEqual([]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "local_echo",
    ]);

    clearExtensionTools();

    const result = await executeTool(
      "local_echo",
      { message: "hi" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe("echo:hi");
  });

  test("exposes recent conversation history to extension tools", async () => {
    const newestFirstMessages = [
      {
        id: "msg-2",
        date: "2026-05-27T00:00:02.000Z",
        message_type: "assistant_message",
        content: "hello",
      },
      {
        id: "msg-1",
        date: "2026-05-27T00:00:01.000Z",
        message_type: "user_message",
        content: "hi",
      },
    ] as unknown as Message[];
    const listCalls: Array<{ body: unknown; conversationId: string }> = [];
    __testSetBackend({
      listConversationMessages: async (
        conversationId: string,
        body: unknown,
      ) => {
        listCalls.push({ conversationId, body });
        return {
          getPaginatedItems: () => newestFirstMessages,
        };
      },
    } as unknown as Backend);

    const controller = new AbortController();
    registerExtensionTool({
      name: "history_echo",
      description: "Echo conversation history ids",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/history-echo.ts",
        path: "/tmp/history-echo.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/history-echo.ts",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      getContext: () => {
        throw new Error("context should not be needed for this test");
      },
      isAvailable: () => true,
      run: async (ctx) => {
        const history = await ctx.conversation.getHistory({ limit: 2 });
        return history.map((message) => message.id).join(",");
      },
    });

    const result = await runWithRuntimeContext(
      { agentId: "agent-1", conversationId: "default" },
      () => executeTool("history_echo", {}),
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe("msg-1,msg-2");
    expect(listCalls).toEqual([
      {
        conversationId: "default",
        body: {
          agent_id: "agent-1",
          include_err: true,
          limit: 2,
          order: "desc",
        },
      },
    ]);
  });

  test("captures backend once for extension tool conversation handles", async () => {
    const calls: string[] = [];
    const backendA = {
      forkConversation: async (
        ...[conversationId, options]: Parameters<Backend["forkConversation"]>
      ) => {
        calls.push(
          `a:fork:${conversationId}:${options?.agentId}:${options?.hidden}`,
        );
        return { id: "forked-conversation" };
      },
      listConversationMessages: async (
        ...[conversationId, body]: Parameters<
          Backend["listConversationMessages"]
        >
      ) => {
        calls.push(`a:history:${conversationId}:${body?.limit}`);
        return {
          getPaginatedItems: () => [{ id: "forked-message" }],
        };
      },
    } as unknown as Backend;
    const backendB = {
      listConversationMessages: async (
        ...[conversationId, body]: Parameters<
          Backend["listConversationMessages"]
        >
      ) => {
        calls.push(`b:history:${conversationId}:${body?.limit}`);
        return {
          getPaginatedItems: () => [{ id: "wrong-backend-message" }],
        };
      },
    } as unknown as Backend;
    __testSetBackend(backendA);

    const controller = new AbortController();
    registerExtensionTool({
      name: "fork_history",
      description: "Fork conversation and read fork history",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/fork-history.ts",
        path: "/tmp/fork-history.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/fork-history.ts",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      getContext: () => {
        throw new Error("context should not be needed for this test");
      },
      isAvailable: () => true,
      run: async (ctx) => {
        const fork = await ctx.conversation.fork({ hidden: true });
        __testSetBackend(backendB);
        const history = await fork.getHistory({ limit: 1 });
        return [
          ctx.conversation.id,
          fork.id,
          typeof ctx.conversation.sendMessageStream,
          history.map((message) => message.id).join(","),
        ].join(":");
      },
    });

    const result = await runWithRuntimeContext(
      { agentId: "agent-1", conversationId: "conversation-1" },
      () => executeTool("fork_history", {}),
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe(
      "conversation-1:forked-conversation:function:forked-message",
    );
    expect(calls).toEqual([
      "a:fork:conversation-1:agent-1:true",
      "a:history:forked-conversation:1",
    ]);
  });

  test("extension tools take precedence over external tools with the same name", async () => {
    registerExternalTools([
      {
        name: "local_echo",
        description: "External tool with duplicate name",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ]);
    const controller = new AbortController();
    registerEchoExtensionTool(controller.signal);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["local_echo"] },
    );

    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "local_echo",
    ]);

    const result = await executeTool(
      "local_echo",
      { message: "hi" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe("echo:hi");
  });

  test("aborted extension activations stop captured tool execution", async () => {
    const controller = new AbortController();
    registerEchoExtensionTool(controller.signal);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["local_echo"] },
    );

    controller.abort();

    const result = await executeTool(
      "local_echo",
      { message: "hi" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("error");
    expect(asText(result.toolReturn)).toBe("Interrupted by user");
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

  test("does not leak MessageChannel into conversations that only share an agent-level Slack account", async () => {
    installChannelAccountTestOverrides();
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
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
      defaultPermissionMode: "standard",
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

  test("includes MessageChannel in scoped snapshots when the conversation has a Slack route", async () => {
    installChannelAccountTestOverrides();
    __testOverrideLoadRoutes(() => null);
    __testOverrideSaveRoutes(() => {});
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
      defaultPermissionMode: "standard",
    });
    setRouteInMemory("slack", {
      accountId: "acct-slack",
      chatId: "C123",
      chatType: "channel",
      threadId: "1712790000.000050",
      agentId: "agent-1",
      conversationId: "default",
      enabled: true,
      createdAt: "2026-04-11T00:00:00.000Z",
      updatedAt: "2026-04-11T00:00:00.000Z",
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

  test("hydrates inherited channel scope from serialized child env", async () => {
    await loadSpecificTools(["Read"]);
    __testSetBackend(
      new FakeHeadlessBackend(
        "agent-1",
        undefined,
        {},
        {
          modelHandle: "anthropic/claude-opus-4-1-20250805",
        },
      ),
    );
    process.env[LETTA_INHERITED_CHANNEL_CONTEXT_ENV] = JSON.stringify({
      channelToolScope: {
        channels: [{ channelId: "telegram", accountId: "acct-telegram" }],
      },
      channelTurnSources: [
        {
          channel: "telegram",
          accountId: "acct-telegram",
          chatId: "7952253975",
          chatType: "channel",
          threadId: "42",
          agentId: "agent-1",
          conversationId: "default",
        },
      ],
    });

    const prepared = await prepareToolExecutionContextForScope({
      agentId: "agent-1",
      conversationId: "default",
      overrideModel: "anthropic/claude-opus-4-1-20250805",
    });

    expect(prepared.preparedToolContext.loadedToolNames).toContain(
      "MessageChannel",
    );
    const captured = getExecutionContextById(
      prepared.preparedToolContext.contextId,
    );
    expect(captured?.runtimeContext.channelToolScope).toEqual({
      channels: [{ channelId: "telegram", accountId: "acct-telegram" }],
    });
    expect(captured?.runtimeContext.channelTurnSources).toEqual([
      {
        channel: "telegram",
        accountId: "acct-telegram",
        chatId: "7952253975",
        chatType: "channel",
        threadId: "42",
        agentId: "agent-1",
        conversationId: "default",
      },
    ]);
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
