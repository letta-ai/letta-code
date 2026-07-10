import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __testSetBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import {
  clearRegisteredPiProviders,
  getRegisteredPiProvider,
} from "@/backend/dev/pi-provider-mod-registry";
import {
  clearModTools,
  getModToolDefinition,
  registerModTool,
} from "@/mods/tool-registry";
import {
  clearCapturedToolExecutionContexts,
  executeTool,
} from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import {
  createListenerModAdapter,
  createListenerModContext,
  LISTENER_MOD_CAPABILITIES,
} from "@/websocket/listener/mod-adapter";

const tempRoots: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "letta-listener-mod-"));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  clearModTools();
  clearRegisteredPiProviders();
  clearCapturedToolExecutionContexts();
  __testSetBackend(null);
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("listener mod adapter", () => {
  test("uses provider and tool capabilities", () => {
    expect(LISTENER_MOD_CAPABILITIES).toEqual({
      tools: true,
      commands: true,
      events: {
        lifecycle: false,
        tools: true,
        turns: true,
        compact: false,
        llm: false,
      },
      permissions: true,
      providers: true,
      ui: {
        panels: false,
      },
    });
  });

  test("builds a listener-scoped mod context", () => {
    const context = createListenerModContext({
      sessionId: "listen-test-session",
      workingDirectory: "/tmp/listener-workspace",
    });

    expect(context.sessionId).toBe("listen-test-session");
    expect(context.cwd).toBe("/tmp/listener-workspace");
    expect(context.workspace).toEqual({
      cwd: "/tmp/listener-workspace",
      currentDir: "/tmp/listener-workspace",
      projectDir: "/tmp/listener-workspace",
    });
    expect(context.agent).toEqual({ id: null, name: null });
    expect(context.model).toEqual({
      id: null,
      displayName: null,
      provider: null,
      reasoningEffort: null,
    });
    expect(context.memfs).toEqual({ enabled: false, memoryDir: null });
  });

  test("builds listener context with active scope metadata", () => {
    const context = createListenerModContext({
      sessionId: "listen-test-session",
      workingDirectory: "/tmp/listener-workspace",
      permissionMode: "standard",
      toolset: "default",
      agent: {
        id: "agent-123",
        name: "Desktop Agent",
        model: "anthropic/claude-sonnet-4-6",
        llm_config: {
          model: "claude-sonnet-4-6",
          model_endpoint_type: "anthropic",
          reasoning_effort: "medium",
        },
      },
    });

    expect(context.agent).toEqual({ id: "agent-123", name: "Desktop Agent" });
    expect(context.model).toMatchObject({
      id: "anthropic/claude-sonnet-4-6",
      provider: "anthropic",
      reasoningEffort: "medium",
    });
    expect(context.permissionMode).toBe("standard");
    expect(context.toolset).toBe("default");
  });

  test("loads provider, tool, and command registrations without exposing events or panels", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    const modPath = join(modsDir, "kilo.ts");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      modPath,
      `export default function activate(letta) {
        letta.providers.register("kilo", {
          name: "Kilo",
          description: "Connect Kilo",
          api: "openai-completions",
          baseUrl: "https://api.kilo.test/v1",
          apiKey: "KILO_API_KEY",
          models: [{
            id: "kilo-code",
            name: "Kilo Code",
            reasoning: true,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 8192,
          }],
        });
        letta.commands.register({
          id: "listener-command",
          description: "Should register on listener",
          args: "<thing>",
          run() { return { type: "handled" }; },
        });
        letta.tools.register({
          name: "listener_tool",
          description: "Should register on listener",
          parameters: { type: "object", properties: {} },
          run(ctx) { return "agent:" + ctx.agent.id; },
        });
        letta.events.on("conversation_open", () => undefined);
        letta.ui.openPanel({ id: "ignored-panel", content: "ignored" });
        letta.ui.setStatus("ignored-status", "ignored");
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "listen-provider-test",
      workingDirectory: root,
    });

    await adapter.reload();

    expect(getRegisteredPiProvider("kilo")?.config).toMatchObject({
      name: "Kilo",
      baseUrl: "https://api.kilo.test/v1",
      models: [{ id: "kilo-code", contextWindow: 128000 }],
    });
    expect(getModToolDefinition("listener_tool")).toMatchObject({
      name: "listener_tool",
      description: "Should register on listener",
      path: modPath,
    });

    const snapshot = adapter.getSnapshot().registry;
    expect(snapshot.capabilities).toEqual(LISTENER_MOD_CAPABILITIES);
    expect(snapshot.loadedPaths).toEqual([modPath]);
    expect(snapshot.commands["listener-command"]).toMatchObject({
      id: "listener-command",
      description: "Should register on listener",
      path: modPath,
    });
    expect(snapshot.tools.listener_tool).toMatchObject({
      name: "listener_tool",
      description: "Should register on listener",
      path: modPath,
    });
    expect(snapshot.events).toEqual({});
    expect(snapshot.ui.panels).toEqual({});

    adapter.dispose();
    expect(getRegisteredPiProvider("kilo")).toBeUndefined();
    expect(getModToolDefinition("listener_tool")).toBeUndefined();
  });

  test("mod tools appear in scoped tool execution context for listener turns", async () => {
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
      name: "listener_echo",
      description: "Echo for listener turns",
      parameters: {
        type: "object",
        properties: { msg: { type: "string" } },
        required: ["msg"],
      },
      owner: {
        id: "global:/tmp/listener-echo.ts",
        path: "/tmp/listener-echo.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/listener-echo.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      run: (ctx) => `echo:${ctx.args.msg}`,
    });

    const prepared = await prepareToolExecutionContextForScope({
      agentId: "agent-1",
      conversationId: "default",
      clientToolAllowlist: ["listener_echo"],
      workingDirectory: "/tmp/listener-workspace",
      permissionModeState: { mode: "standard" },
    });

    expect(prepared.preparedToolContext.loadedToolNames).toEqual([
      "listener_echo",
    ]);
    expect(prepared.preparedToolContext.clientTools.map((t) => t.name)).toEqual(
      ["listener_echo"],
    );

    const result = await executeTool(
      "listener_echo",
      { msg: "hi" },
      { toolContextId: prepared.preparedToolContext.contextId },
    );
    expect(result.status).toBe("success");
    expect(result.toolReturn).toBe("echo:hi");
  });

  test("mod tools receive scoped context matching listener turn scope", async () => {
    __testSetBackend(
      new FakeHeadlessBackend(
        "agent-scoped",
        undefined,
        {},
        {
          modelHandle: "anthropic/claude-sonnet-4-6",
        },
      ),
    );
    const controller = new AbortController();
    registerModTool({
      name: "scope_inspector",
      description: "Inspects listener scope",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/scope-inspector.ts",
        path: "/tmp/scope-inspector.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/scope-inspector.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      run: (ctx) =>
        [
          ctx.agent.id,
          ctx.cwd,
          ctx.model.provider,
          ctx.permissionMode,
          ctx.toolset,
        ].join(":"),
    });

    const prepared = await prepareToolExecutionContextForScope({
      agentId: "agent-scoped",
      conversationId: "conv-1",
      overrideModel: "anthropic/claude-sonnet-4-6",
      clientToolAllowlist: ["scope_inspector"],
      workingDirectory: "/tmp/listener-workspace",
      permissionModeState: { mode: "standard" },
    });

    const result = await executeTool(
      "scope_inspector",
      {},
      { toolContextId: prepared.preparedToolContext.contextId },
    );
    expect(result.status).toBe("success");
    expect(result.toolReturn).toBe(
      "agent-scoped:/tmp/listener-workspace:anthropic:standard:default",
    );
  });

  test("turn_start handlers can modify input", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      join(modsDir, "turn-mod.ts"),
      `export default function activate(letta) {
        letta.events.on("turn_start", (event) => {
          // Prepend a reminder to the first user message
          const transformed = event.input.map((m, i) => {
            if (m.role === "user" && i === 0) {
              const reminder = { type: "text", text: "<reminder>test</reminder>" };
              const content = Array.isArray(m.content) ? m.content : [{ type: "text", text: m.content }];
              return { ...m, content: [reminder, ...content] };
            }
            return m;
          });
          return { input: transformed };
        });
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "turn-test",
      workingDirectory: root,
    });
    await adapter.reload();

    const context = createListenerModContext({
      sessionId: "conv-turn-test",
      workingDirectory: root,
    });
    const originalInput = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "hello" }],
      },
    ];
    const event = {
      agentId: "agent-turn",
      conversationId: "conv-turn-test",
      input: originalInput,
    };

    await adapter.events.emit("turn_start", event, context);

    // Handler should have prepended the reminder
    expect(event.input).toHaveLength(1);
    const firstMsg = event.input[0];
    if (!firstMsg || !("content" in firstMsg)) {
      throw new Error("Expected first message with content");
    }
    expect(Array.isArray(firstMsg.content)).toBe(true);
    const content = firstMsg.content as unknown[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: "<reminder>test</reminder>",
    });
    expect(content[1]).toEqual({ type: "text", text: "hello" });

    adapter.dispose();
  });

  test("turn_start handler errors do not block emission", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      join(modsDir, "throw-mod.ts"),
      `export default function activate(letta) {
        letta.events.on("turn_start", () => {
          throw new Error("handler error");
        });
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "throw-test",
      workingDirectory: root,
    });
    await adapter.reload();

    const context = createListenerModContext({
      sessionId: "conv-throw-test",
      workingDirectory: root,
    });
    const originalInput = [
      {
        role: "user" as const,
        content: [{ type: "text" as const, text: "test" }],
      },
    ];
    const event = {
      agentId: "agent-throw",
      conversationId: "conv-throw-test",
      input: originalInput,
    };

    // Should not throw, emission continues despite handler error
    const result = await adapter.events.emit("turn_start", event, context);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]?.error).toBeInstanceOf(Error);
    expect(result.diagnostics[0]?.error.message).toBe("handler error");

    // Input should be unchanged since handler threw
    expect(event.input).toEqual(originalInput);

    adapter.dispose();
  });

  test("turn_end handlers receive stop reason and assistant message", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      join(modsDir, "turn-end-mod.ts"),
      `export default function activate(letta) {
        letta.events.on("turn_end", (event) => {
          globalThis.__lettaTurnEndSeen = {
            stopReason: event.stopReason,
            assistantMessage: event.assistantMessage,
          };
        });
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "turn-end-test",
      workingDirectory: root,
    });
    await adapter.reload();

    const context = createListenerModContext({
      sessionId: "conv-turn-end-test",
      workingDirectory: root,
    });
    const event = {
      agentId: "agent-turn-end",
      conversationId: "conv-turn-end-test",
      stopReason: "end_turn",
      assistantMessage: "all done",
    };

    const result = await adapter.events.emit("turn_end", event, context);
    expect(result.diagnostics).toHaveLength(0);
    expect(
      (globalThis as { __lettaTurnEndSeen?: unknown }).__lettaTurnEndSeen,
    ).toEqual({
      stopReason: "end_turn",
      assistantMessage: "all done",
    });

    delete (globalThis as { __lettaTurnEndSeen?: unknown }).__lettaTurnEndSeen;
    adapter.dispose();
  });

  test("tool_end handlers are delivered and can replace the result", async () => {
    const root = createTempDir();
    const modsDir = join(root, "mods");
    const cacheDir = join(root, "cache");
    mkdirSync(modsDir, { recursive: true });
    writeFileSync(
      join(modsDir, "tool-end-mod.ts"),
      `export default function activate(letta) {
        letta.events.on("tool_end", (event) => {
          globalThis.__lettaToolEndSeen = {
            toolName: event.toolName,
            args: event.args,
            status: event.status,
            output: event.output,
          };
          if (event.toolName === "Bash") {
            return { result: { status: "success", output: "redacted" } };
          }
        });
      }`,
    );

    const adapter = createListenerModAdapter({
      cacheDirectory: cacheDir,
      globalModsDirectory: modsDir,
      sessionId: "tool-end-test",
      workingDirectory: root,
    });
    await adapter.reload();

    const context = createListenerModContext({
      sessionId: "conv-tool-end-test",
      workingDirectory: root,
    });
    const event: {
      agentId: string;
      conversationId: string;
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      status: "success" | "error";
      output: string;
      result?: { status: "success" | "error"; output: string };
    } = {
      agentId: "agent-tool-end",
      conversationId: "conv-tool-end-test",
      toolCallId: "call-1",
      toolName: "Bash",
      args: { command: "echo secret" },
      status: "success",
      output: "secret",
    };

    const result = await adapter.events.emit("tool_end", event, context);
    expect(result.diagnostics).toHaveLength(0);
    expect(
      (globalThis as { __lettaToolEndSeen?: unknown }).__lettaToolEndSeen,
    ).toEqual({
      toolName: "Bash",
      args: { command: "echo secret" },
      status: "success",
      output: "secret",
    });
    // events.tools is enabled for the listener, so the handler runs and its
    // result override is written back onto the event (first handler wins).
    expect(event.result).toEqual({ status: "success", output: "redacted" });

    delete (globalThis as { __lettaToolEndSeen?: unknown }).__lettaToolEndSeen;
    adapter.dispose();
  });

  test("mod tools with isEnabled are isolated across listener scopes", async () => {
    __testSetBackend(
      new FakeHeadlessBackend(
        "agent-iso",
        undefined,
        {},
        {
          modelHandle: "anthropic/claude-sonnet-4-6",
        },
      ),
    );
    const controller = new AbortController();
    registerModTool({
      name: "scoped_only",
      description: "Only available for agent-iso in workspace-a",
      parameters: { type: "object", properties: {}, required: [] },
      owner: {
        id: "global:/tmp/scoped-only.ts",
        path: "/tmp/scoped-only.ts",
        scope: "global",
        generation: 1,
      },
      path: "/tmp/scoped-only.ts",
      approvalPolicy: "auto",
      requiresApproval: false,
      parallelSafe: true,
      activationSignal: controller.signal,
      isEnabled: (ctx) =>
        ctx.agent.id === "agent-iso" && ctx.cwd === "/tmp/workspace-a",
      run: () => "ok",
    });

    // Scope matching: agent-iso + workspace-a should see the tool
    const preparedA = await prepareToolExecutionContextForScope({
      agentId: "agent-iso",
      conversationId: "conv-a",
      clientToolAllowlist: ["scoped_only"],
      workingDirectory: "/tmp/workspace-a",
      permissionModeState: { mode: "standard" },
    });
    expect(preparedA.preparedToolContext.loadedToolNames).toEqual([
      "scoped_only",
    ]);

    // Scope mismatch: agent-iso + workspace-b should NOT see the tool
    const preparedB = await prepareToolExecutionContextForScope({
      agentId: "agent-iso",
      conversationId: "conv-b",
      clientToolAllowlist: ["scoped_only"],
      workingDirectory: "/tmp/workspace-b",
      permissionModeState: { mode: "standard" },
    });
    expect(preparedB.preparedToolContext.loadedToolNames).toEqual([]);
  });
});
