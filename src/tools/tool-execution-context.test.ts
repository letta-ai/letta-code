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
  clearModPermissions,
  registerModPermission,
} from "@/mods/permission-registry";
import { clearModTools, registerModTool } from "@/mods/tool-registry";
import type {
  ModDiagnostic,
  ModToolEndEvent,
  ModToolStartEvent,
} from "@/mods/types";
import {
  LETTA_INHERITED_CHANNEL_CONTEXT_ENV,
  runWithRuntimeContext,
} from "@/runtime-context";
import { toolFilter } from "@/tools/filter";
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
  prepareToolExecutionContextForResolvedTarget,
  prepareToolExecutionContextForScope,
  resolveConversationChannelToolScope,
} from "@/tools/toolset";
import {
  __testOverrideSecretsBackend,
  clearSecretsCache,
} from "@/utils/secrets-store";

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

  function registerEchoModTool(signal: AbortSignal): void {
    registerModTool({
      name: "local_echo",
      description: "Echo input from a local mod",
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
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: signal,
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
    clearModPermissions();
    clearModTools();
    toolFilter.reset();
    clearAllRoutes();
    __testOverrideLoadRoutes(null);
    __testOverrideSaveRoutes(null);
    clearChannelAccountStores();
    __testOverrideLoadChannelAccounts(null);
    __testOverrideSaveChannelAccounts(null);
    delete process.env[LETTA_INHERITED_CHANNEL_CONTEXT_ENV];
    __testOverrideSecretsBackend(null);
    clearSecretsCache(null);
    delete process.env.TAVILY_API_KEY;
    __testSetBackend(null);
  });

  function installChannelAccountTestOverrides(): void {
    __testOverrideLoadChannelAccounts(() => []);
    __testOverrideSaveChannelAccounts(() => {});
  }

  afterAll(async () => {
    clearExternalTools();
    clearModPermissions();
    clearModTools();
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

  test("rechecks mod permission overlays after tool_start arg transforms", async () => {
    await loadSpecificTools(["Read"]);
    registerModPermission({
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
      modEvents: {
        async emit(name, event) {
          if (name === "tool_start") {
            const toolStartEvent = event as ModToolStartEvent;
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
      "mod permission:execution-gate",
    );
    expect(asText(result.toolReturn)).toContain("mutated path blocked");
  });

  test("applies a tool_end result override to replace the tool result", async () => {
    await loadSpecificTools(["Read"]);

    const prepared = await prepareCurrentToolExecutionContext({
      modEvents: {
        async emit(name, event) {
          if (name === "tool_start") {
            const toolStartEvent = event as ModToolStartEvent;
            toolStartEvent.args = {
              ...toolStartEvent.args,
              file_path: "package.json",
            };
          }
          if (name === "tool_end") {
            expect((event as ModToolEndEvent).args).toEqual({
              file_path: "package.json",
            });
            (
              event as ModToolEndEvent & {
                result?: { status: "success" | "error"; output: string };
              }
            ).result = { status: "success", output: "redacted by mod" };
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

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe("redacted by mod");
  });

  test("passes the tool result through when no tool_end override", async () => {
    await loadSpecificTools(["Read"]);

    const prepared = await prepareCurrentToolExecutionContext({
      modEvents: {
        async emit(name, _event) {
          return { diagnostics: [], handlerCount: 0, name, results: [] };
        },
      },
    });

    const result = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).not.toBe("redacted by mod");
  });

  test("reports execution-phase ask decisions as blocked approval requests", async () => {
    await loadSpecificTools(["Read"]);
    registerModPermission({
      id: "execution-ask",
      description: "Ask before execution",
      path: "/tmp/execution-ask.ts",
      owner: {
        id: "global:/tmp/execution-ask.ts",
        path: "/tmp/execution-ask.ts",
        scope: "global",
        generation: 1,
      },
      activationSignal: new AbortController().signal,
      check(event) {
        if (event.phase === "execution" && event.toolName === "Read") {
          return { decision: "ask" };
        }
        return undefined;
      },
    });

    const prepared = await prepareCurrentToolExecutionContext();
    const result = await executeTool(
      "Read",
      { file_path: "README.md" },
      { toolContextId: prepared.contextId },
    );

    const text = asText(result.toolReturn);
    expect(result.status).toBe("error");
    expect(text).toContain("blocked by mod permission:execution-ask");
    expect(text).toContain(
      "Approval requested but cannot reopen during execution.",
    );
    expect(text).not.toContain("denied by mod permission:execution-ask");
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

    expect(prepared.loadedToolNames).toEqual(["Agent"]);
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

  test("session tool filter excludes mod tools from current snapshots", async () => {
    toolFilter.setEnabledTools("Bash");
    await loadSpecificTools(["Bash"]);
    registerEchoModTool(new AbortController().signal);

    const prepared = await prepareCurrentToolExecutionContext();

    expect(prepared.loadedToolNames).toEqual(["Bash"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(["Bash"]);

    const denied = await executeTool(
      "local_echo",
      { message: "hi" },
      { toolContextId: prepared.contextId },
    );
    expect(denied.status).toBe("error");
    expect(asText(denied.toolReturn)).toContain("Tool not found: local_echo");
  });

  test("session tool filter excludes external tools from current snapshots", async () => {
    toolFilter.setEnabledTools("Bash");
    await loadSpecificTools(["Bash"]);
    registerExternalTools([
      {
        name: "RemoteFoo",
        description: "External tool filtered by session --tools",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ]);

    const prepared = await prepareCurrentToolExecutionContext();

    expect(prepared.loadedToolNames).toEqual(["Bash"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual(["Bash"]);

    const denied = await executeTool(
      "RemoteFoo",
      {},
      { toolContextId: prepared.contextId },
    );
    expect(denied.status).toBe("error");
    expect(asText(denied.toolReturn)).toContain("Tool not found: RemoteFoo");
  });

  test("empty session tool filter excludes mod tools from current snapshots", async () => {
    toolFilter.setEnabledTools("");
    await loadSpecificTools(["Bash"]);
    registerEchoModTool(new AbortController().signal);

    const prepared = await prepareCurrentToolExecutionContext();

    expect(prepared.loadedToolNames).toEqual([]);
    expect(prepared.clientTools).toEqual([]);

    const denied = await executeTool(
      "local_echo",
      { message: "hi" },
      { toolContextId: prepared.contextId },
    );
    expect(denied.status).toBe("error");
    expect(asText(denied.toolReturn)).toContain("Tool not found: local_echo");
  });

  test("runtime-owned external tools stay scoped to their runtime", async () => {
    registerExternalTools([
      {
        name: "RemoteFoo",
        description: "External tool for first runtime",
        parameters: { type: "object", properties: {}, required: [] },
        runtime: { agentId: "agent-1", conversationId: "conv-1" },
      },
      {
        name: "RemoteBar",
        description: "External tool for second runtime",
        parameters: { type: "object", properties: {}, required: [] },
        runtime: { agentId: "agent-1", conversationId: "conv-2" },
      },
    ]);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["RemoteFoo", "RemoteBar"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );

    expect(prepared.loadedToolNames).toEqual([]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "RemoteFoo",
    ]);
  });

  test("scoped runtime external tools stay hidden unless selected", async () => {
    registerExternalTools([
      {
        name: "AlwaysOnRemote",
        description: "Unscoped runtime tool",
        parameters: { type: "object", properties: {}, required: [] },
        runtime: { agentId: "agent-1", conversationId: "conv-1" },
      },
      {
        name: "ScopedRemote",
        description: "Scoped runtime tool",
        parameters: { type: "object", properties: {}, required: [] },
        runtime: { agentId: "agent-1", conversationId: "conv-1" },
        scopeId: "scope-1",
      },
    ]);

    const base = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["AlwaysOnRemote", "ScopedRemote"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );
    expect(base.clientTools.map((tool) => tool.name)).toEqual([
      "AlwaysOnRemote",
    ]);

    const selected = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      {
        clientToolAllowlist: ["AlwaysOnRemote", "ScopedRemote"],
        externalToolScopeIds: ["scope-1"],
        runtimeContext: { agentId: "agent-1", conversationId: "conv-1" },
      },
    );
    expect(selected.clientTools.map((tool) => tool.name)).toEqual([
      "AlwaysOnRemote",
      "ScopedRemote",
    ]);
  });

  test("prepares and executes mod tools from turn snapshots", async () => {
    const controller = new AbortController();
    registerEchoModTool(controller.signal);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-sonnet-4",
      { clientToolAllowlist: ["local_echo"] },
    );

    expect(prepared.loadedToolNames).toEqual(["local_echo"]);
    expect(prepared.clientTools.map((tool) => tool.name)).toEqual([
      "local_echo",
    ]);

    clearModTools();

    const result = await executeTool(
      "local_echo",
      { message: "hi" },
      { toolContextId: prepared.contextId },
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe("echo:hi");
  });

  test("passes scoped invocation context to mod tool availability and execution", async () => {
    __testSetBackend(
      new FakeHeadlessBackend(
        "agent-1",
        undefined,
        {},
        {
          modelHandle: "anthropic/claude-sonnet-4-6",
        },
      ),
    );
    const controller = new AbortController();
    registerModTool({
      name: "scoped_echo",
      description: "Only available for the resolved scope",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/scoped-echo.ts",
        path: "/tmp/scoped-echo.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/scoped-echo.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      isEnabled: (ctx) =>
        ctx.agent.id === "agent-1" &&
        ctx.cwd === "/tmp/listener-workspace" &&
        ctx.model.provider === "xai-build" &&
        ctx.permissionMode === "standard" &&
        ctx.toolset === "default",
      run: (ctx) =>
        [ctx.agent.id, ctx.cwd, ctx.model.provider, ctx.permissionMode].join(
          ":",
        ),
    });

    const prepared = await prepareToolExecutionContextForScope({
      agentId: "agent-1",
      conversationId: "default",
      overrideModel: "xai-build/grok-build",
      clientToolAllowlist: ["scoped_echo"],
      workingDirectory: "/tmp/listener-workspace",
      permissionModeState: { mode: "standard" },
    });

    expect(prepared.preparedToolContext.loadedToolNames).toEqual([
      "scoped_echo",
    ]);

    const result = await executeTool(
      "scoped_echo",
      {},
      { toolContextId: prepared.preparedToolContext.contextId },
    );

    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe(
      "agent-1:/tmp/listener-workspace:xai-build:standard",
    );
  });

  test("exposes agent-scoped secrets to mod tools", async () => {
    process.env.TAVILY_API_KEY = "env-secret-value";
    const retrieveCalls: string[] = [];
    let seenSecret = "";
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      retrieveAgent: async (agentId) => {
        retrieveCalls.push(agentId);
        return {
          secrets: [{ key: "TAVILY_API_KEY", value: "agent-secret-value" }],
        };
      },
      updateAgent: async () => ({}),
    });

    const controller = new AbortController();
    registerModTool({
      name: "secret_echo",
      description: "Echo a secret",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/secret-echo.ts",
        path: "/tmp/secret-echo.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/secret-echo.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      run: async (ctx) => {
        seenSecret =
          (await ctx.secret("tavily_api_key", { envFallback: true })) ?? "";
        return `secret:${seenSecret}`;
      },
    });

    const result = await runWithRuntimeContext(
      { agentId: "agent-secret-a", conversationId: "default" },
      () => executeTool("secret_echo", {}),
    );

    expect(seenSecret).toBe("agent-secret-value");
    expect(retrieveCalls).toEqual(["agent-secret-a"]);
    expect(result.status).toBe("success");
    expect(asText(result.toolReturn)).toBe("secret:TAVILY_API_KEY=<REDACTED>");
  });

  test("mod tool env fallback secrets are invocation-redacted", async () => {
    process.env.TAVILY_API_KEY = "env-secret-value";
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      retrieveAgent: async () => ({ secrets: [] }),
      updateAgent: async () => ({}),
    });
    const chunks: Array<{ chunk: string; stream: string }> = [];

    const controller = new AbortController();
    registerModTool({
      name: "secret_env_echo",
      description: "Echo an env fallback secret",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/secret-env-echo.ts",
        path: "/tmp/secret-env-echo.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/secret-env-echo.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      run: async (ctx) => {
        const secret = await ctx.secret("TAVILY_API_KEY", {
          envFallback: true,
        });
        ctx.onOutput?.(`stream:${secret}`, "stdout");
        return {
          status: "error",
          content: `content:${secret}`,
          stdout: [`stdout:${secret}`],
          stderr: [`stderr:${secret}`],
        };
      },
    });

    const result = await runWithRuntimeContext(
      { agentId: "agent-secret-env", conversationId: "default" },
      () =>
        executeTool(
          "secret_env_echo",
          {},
          {
            onOutput: (chunk, stream) => chunks.push({ chunk, stream }),
          },
        ),
    );

    expect(result.status).toBe("error");
    expect(asText(result.toolReturn)).toBe("content:TAVILY_API_KEY=<REDACTED>");
    expect(result.stdout).toEqual(["stdout:TAVILY_API_KEY=<REDACTED>"]);
    expect(result.stderr).toEqual(["stderr:TAVILY_API_KEY=<REDACTED>"]);
    expect(chunks).toEqual([
      { chunk: "stream:TAVILY_API_KEY=<REDACTED>", stream: "stdout" },
    ]);
  });

  test("mod tool thrown errors are redacted after ctx.secret", async () => {
    process.env.TAVILY_API_KEY = "throw-secret-value";
    __testOverrideSecretsBackend({
      capabilities: { serverSecrets: true },
      retrieveAgent: async () => ({ secrets: [] }),
      updateAgent: async () => ({}),
    });
    const diagnostics: ModDiagnostic[] = [];

    const controller = new AbortController();
    registerModTool({
      name: "secret_throw",
      description: "Throw a secret",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/secret-throw.ts",
        path: "/tmp/secret-throw.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/secret-throw.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      recordDiagnostic: (diagnostic) => {
        diagnostics.push({
          ...diagnostic,
          owner: {
            id: "global:/tmp/secret-throw.ts",
            path: "/tmp/secret-throw.ts",
            scope: "global",
            generation: 1,
          },
          timestamp: Date.now(),
        });
      },
      run: async (ctx) => {
        const secret = await ctx.secret("TAVILY_API_KEY", {
          envFallback: true,
        });
        throw new Error(`failed:${secret}`);
      },
    });

    const result = await runWithRuntimeContext(
      { agentId: "agent-secret-throw", conversationId: "default" },
      () => executeTool("secret_throw", {}),
    );

    expect(result.status).toBe("error");
    expect(asText(result.toolReturn)).toBe("failed:TAVILY_API_KEY=<REDACTED>");
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.error.message).toBe(
      "failed:TAVILY_API_KEY=<REDACTED>",
    );
  });

  test("exposes recent conversation history to mod tools", async () => {
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
    registerModTool({
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
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
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

  test("captures backend once for mod tool conversation handles", async () => {
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
    registerModTool({
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
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
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

  test("mod tools take precedence over external tools with the same name", async () => {
    registerExternalTools([
      {
        name: "local_echo",
        description: "External tool with duplicate name",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ]);
    const controller = new AbortController();
    registerEchoModTool(controller.signal);

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

  test("aborted mod activations stop captured tool execution", async () => {
    const controller = new AbortController();
    registerEchoModTool(controller.signal);

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

    expect(actionParameter?.enum).toEqual([
      "send",
      "ask",
      "react",
      "upload-file",
    ]);
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
    expect(prepared.loadedToolNames).not.toContain("AskUserQuestion");
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

  test("keeps scoped MessageChannel available for pinned none toolsets", async () => {
    await loadSpecificTools(["Read"]);

    const prepared = await prepareToolExecutionContextForResolvedTarget({
      modelIdentifier: "anthropic/claude-opus-4-1-20250805",
      toolsetPreference: "none",
      channelToolScope: {
        channels: [{ channelId: "discord", accountId: "acct-discord" }],
      },
    });

    expect(prepared.preparedToolContext.loadedToolNames).toEqual([
      "MessageChannel",
    ]);
    expect(
      prepared.preparedToolContext.clientTools.map((tool) => tool.name),
    ).toEqual(["MessageChannel"]);
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

  test("suppresses AskUserQuestion when channel scope has active channels", async () => {
    await loadSpecificTools(["Read"]);

    const registry = new ChannelRegistry();
    registry.registerAdapter(createRunningAdapter("slack", "acct-slack"));

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
      {
        channelToolScope: {
          channels: [{ channelId: "slack", accountId: "acct-slack" }],
        },
      },
    );

    expect(prepared.loadedToolNames).toContain("MessageChannel");
    expect(prepared.loadedToolNames).not.toContain("AskUserQuestion");
  });

  test("keeps AskUserQuestion when no channel scope is active", async () => {
    await loadSpecificTools(["Read"]);

    const prepared = await prepareToolExecutionContextForModel(
      "anthropic/claude-opus-4-1-20250805",
    );

    expect(prepared.loadedToolNames).toContain("AskUserQuestion");
    expect(prepared.loadedToolNames).not.toContain("MessageChannel");
  });
});
