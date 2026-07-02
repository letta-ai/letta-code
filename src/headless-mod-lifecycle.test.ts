import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import type { Backend } from "@/backend";
import { __headlessTestUtils } from "@/headless";
import {
  createHeadlessModAdapter,
  createHeadlessModContext,
  HEADLESS_MOD_CAPABILITIES,
} from "@/headless-mod-adapter";
import { LETTA_DISABLE_MODS_ENV } from "@/mods/disable";
import { clearModTools, getModToolDefinition } from "@/mods/tool-registry";
import { settingsManager } from "@/settings-manager";
import { executeTool } from "@/tools/manager";

function readHeadlessSource(): string {
  return readFileSync(
    fileURLToPath(new URL("./headless.ts", import.meta.url)),
    "utf-8",
  );
}

describe("headless mod adapter", () => {
  afterEach(() => {
    clearModTools();
  });

  test("uses headless mod capabilities", () => {
    expect(HEADLESS_MOD_CAPABILITIES).toEqual({
      tools: true,
      commands: false,
      events: {
        lifecycle: true,
        tools: true,
        turns: true,
        compact: true,
        llm: true,
      },
      permissions: true,
      providers: true,
      ui: {
        panels: false,
      },
    });
  });

  test("builds mod context for headless lifecycle events", () => {
    const context = createHeadlessModContext({
      agent: {
        id: "agent-1",
        name: "Amelia",
        llm_config: {
          context_window: 200000,
          model: "opus",
          reasoning_effort: "high",
        },
      } as AgentState,
      conversationId: "conversation-1",
      lastRunId: "run-1",
      permissionMode: "unrestricted",
      reflectionSettings: { trigger: "step-count", stepCount: 3 },
    });

    expect(context.agent).toEqual({ id: "agent-1", name: "Amelia" });
    expect(context.sessionId).toBe("conversation-1");
    expect(context.lastRunId).toBe("run-1");
    expect(context.permissionMode).toBe("unrestricted");
    expect(context.reflection).toEqual({ mode: "step-count", stepCount: 3 });
    expect(context.contextWindow.size).toBe(200000);
  });

  test("loads the adapter before headless modes and emits lifecycle events on exit", () => {
    const source = readHeadlessSource();

    const adapterIndex = source.indexOf(
      "const headlessModAdapter = createHeadlessModAdapter",
    );
    const initialToolContextIndex = source.indexOf("const initialToolContext");
    const bidirectionalIndex = source.indexOf(
      "// If input-format is stream-json, use bidirectional mode",
    );
    expect(adapterIndex).toBeGreaterThan(-1);
    expect(initialToolContextIndex).toBeGreaterThan(adapterIndex);
    expect(bidirectionalIndex).toBeGreaterThan(adapterIndex);

    expect(source).toContain("await headlessModAdapter.reload()");
    expect(source).toContain("await emitHeadlessConversationOpen({");
    expect(source).toContain("await emitHeadlessConversationClose({");
    expect(source).toContain("headlessModAdapter.dispose()");
  });

  test("registers mod tools for headless tool snapshots and disables commands/UI", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-headless-ext-tools-"));
    const modDir = path.join(root, "global-mods");
    const toolName = "headless_echo_tool";
    const agent = {
      id: "agent-1",
      name: "Amelia",
      llm_config: { model: "anthropic/claude-sonnet-4" },
    } as AgentState;
    const backend = {
      forkConversation: async () => ({ id: "forked" }),
      sendMessageStream: async () => (async function* () {})(),
    } as unknown as Backend;

    try {
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "headless-tool.ts"),
        `export default function activate(letta) {
          letta.commands.register({
            id: "hidden_headless_command",
            description: "Should not register in headless",
            run() { return { type: "handled" }; },
          });
          letta.ui.openPanel({ id: "hidden", content: "hidden" });
          letta.ui.setStatus("hidden", "hidden");
          letta.events.on("tool_start", (event) => {
            if (event.toolName !== "${toolName}") return;
            return {
              args: {
                ...event.args,
                message: String(event.args.message) + ":tool_start",
              },
            };
          });
          letta.tools.register({
            name: "${toolName}",
            description: "Echo from headless mod",
            parameters: {
              type: "object",
              properties: { message: { type: "string" } },
              required: ["message"],
            },
            requiresApproval: false,
            parallelSafe: true,
            run(ctx) {
              return ["headless", ctx.args.message, ctx.agent.id, ctx.conversation.id].join(":");
            },
          });
        }`,
      );

      const adapter = createHeadlessModAdapter({
        agent,
        backend,
        cacheDirectory: path.join(root, "mod-cache"),
        conversationId: "default",
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      const snapshot = adapter.getSnapshot().registry;

      expect(snapshot.tools[toolName]).toBeDefined();
      expect(snapshot.commands).toEqual({});
      expect(snapshot.ui.panels).toEqual({});
      expect(getModToolDefinition(toolName)).toBeDefined();

      const prepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          cachedAgent: agent,
          conversationId: "default",
          modEvents: adapter.events,
        });
      const clientToolNames =
        prepared.preparedToolContext.preparedToolContext.clientTools.map(
          (tool) => tool.name,
        );

      expect(prepared.availableTools).toContain(toolName);
      expect(clientToolNames).toContain(toolName);

      const result = await executeTool(
        toolName,
        { message: "ok" },
        {
          toolContextId:
            prepared.preparedToolContext.preparedToolContext.contextId,
        },
      );

      expect(result.status).toBe("success");
      expect(result.toolReturn).toBe("headless:ok:tool_start:agent-1:default");

      adapter.dispose();
      expect(getModToolDefinition(toolName)).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("loads agent mod source from MemFS when enabled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-headless-agent-mods-"));
    const originalIsMemfsEnabled = settingsManager.isMemfsEnabled;
    const originalLocalBackendFlag =
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
    const originalLocalBackendDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    const agent = {
      id: "agent-1",
      name: "Amelia",
      llm_config: { model: "anthropic/claude-sonnet-4" },
    } as AgentState;
    const backend = {
      forkConversation: async () => ({ id: "forked" }),
      sendMessageStream: async () => (async function* () {})(),
    } as unknown as Backend;
    const storageDir = path.join(root, "local-backend");
    const agentModsDir = path.join(
      storageDir,
      "memfs",
      agent.id,
      "memory",
      "mods",
    );
    const modPath = path.join(agentModsDir, "headless-agent-tool.ts");

    try {
      process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = "1";
      process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
      (settingsManager as typeof settingsManager).isMemfsEnabled = (agentId) =>
        agentId === agent.id;

      mkdirSync(agentModsDir, { recursive: true });
      writeFileSync(
        modPath,
        `export default function activate(letta) {
          letta.tools.register({
            name: "headless_agent_tool",
            description: "Agent-scoped headless tool",
            parameters: { type: "object", properties: {} },
            run() { return "agent"; },
          });
        }`,
      );

      const adapter = createHeadlessModAdapter({
        agent,
        backend,
        cacheDirectory: path.join(root, "mod-cache"),
        conversationId: "default",
        globalModsDirectory: path.join(root, "global-mods"),
      });

      await adapter.reload();
      const snapshot = adapter.getSnapshot().registry;

      expect(snapshot.sources.map((source) => source.scope)).toEqual([
        "global",
        "agent",
      ]);
      expect(snapshot.loadedPaths).toEqual([modPath]);
      expect(snapshot.tools.headless_agent_tool).toMatchObject({
        description: "Agent-scoped headless tool",
        owner: { path: modPath, scope: "agent" },
      });

      adapter.dispose();
      expect(getModToolDefinition("headless_agent_tool")).toBeUndefined();
    } finally {
      (settingsManager as typeof settingsManager).isMemfsEnabled =
        originalIsMemfsEnabled;
      if (originalLocalBackendFlag === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL;
      } else {
        process.env.LETTA_LOCAL_BACKEND_EXPERIMENTAL = originalLocalBackendFlag;
      }
      if (originalLocalBackendDir === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_DIR;
      } else {
        process.env.LETTA_LOCAL_BACKEND_DIR = originalLocalBackendDir;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("disabled headless adapter skips mod loading", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "letta-headless-ext-disabled-"),
    );
    const originalDisableEnv = process.env[LETTA_DISABLE_MODS_ENV];
    const modDir = path.join(root, "global-mods");
    const toolName = "disabled_headless_tool";
    const agent = {
      id: "agent-1",
      name: "Amelia",
      llm_config: { model: "anthropic/claude-sonnet-4" },
    } as AgentState;
    const backend = {
      forkConversation: async () => ({ id: "forked" }),
      sendMessageStream: async () => (async function* () {})(),
    } as unknown as Backend;

    try {
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "headless-tool.ts"),
        `export default function activate(letta) {
          letta.tools.register({
            name: "${toolName}",
            description: "Should not load",
            parameters: { type: "object", properties: {} },
            run() { return "loaded"; },
          });
          letta.commands.register({
            id: "hidden_disabled_command",
            description: "Should not load",
            run() { return { type: "handled" }; },
          });
          letta.ui.setStatuslineRenderer(() => "hidden");
        }`,
      );

      const adapter = createHeadlessModAdapter({
        agent,
        backend,
        cacheDirectory: path.join(root, "mod-cache"),
        conversationId: "default",
        disabled: true,
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      const snapshot = adapter.getSnapshot();

      expect(snapshot.hasModSources).toBe(false);
      expect(snapshot.registry.loadedPaths).toEqual([]);
      expect(snapshot.registry.commands).toEqual({});
      expect(snapshot.registry.tools).toEqual({});
      expect(getModToolDefinition(toolName)).toBeUndefined();
      expect(process.env[LETTA_DISABLE_MODS_ENV]).toBe("1");

      adapter.dispose();
    } finally {
      if (originalDisableEnv === undefined) {
        delete process.env[LETTA_DISABLE_MODS_ENV];
      } else {
        process.env[LETTA_DISABLE_MODS_ENV] = originalDisableEnv;
      }
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("emits tool_start before built-in tool execution", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-headless-tool-start-"));
    const modDir = path.join(root, "global-mods");
    const originalPath = path.join(root, "original.txt");
    const replacementPath = path.join(root, "replacement.txt");
    const agent = {
      id: "agent-1",
      name: "Amelia",
      llm_config: { model: "anthropic/claude-sonnet-4" },
    } as AgentState;
    const backend = {
      forkConversation: async () => ({ id: "forked" }),
      sendMessageStream: async () => (async function* () {})(),
    } as unknown as Backend;

    try {
      mkdirSync(modDir, { recursive: true });
      writeFileSync(originalPath, "original content");
      writeFileSync(replacementPath, "replacement content");
      writeFileSync(
        path.join(modDir, "tool-start.ts"),
        `export default function activate(letta) {
          letta.events.on("tool_start", (event) => {
            if (event.toolName !== "Read") return;
            return { args: { ...event.args, file_path: ${JSON.stringify(replacementPath)} } };
          });
        }`,
      );

      const adapter = createHeadlessModAdapter({
        agent,
        backend,
        cacheDirectory: path.join(root, "mod-cache"),
        conversationId: "default",
        globalModsDirectory: modDir,
      });

      await adapter.reload();
      const prepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          cachedAgent: agent,
          conversationId: "default",
          modEvents: adapter.events,
        });

      const result = await executeTool(
        "Read",
        { file_path: originalPath },
        {
          toolContextId:
            prepared.preparedToolContext.preparedToolContext.contextId,
        },
      );

      expect(result.status).toBe("success");
      expect(result.toolReturn).toContain("replacement content");
      expect(result.toolReturn).not.toContain("original content");

      adapter.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("uses the captured adapter events for tool_start", async () => {
    const root = mkdtempSync(
      path.join(tmpdir(), "letta-headless-tool-start-captured-"),
    );
    const firstModDir = path.join(root, "first-mods");
    const secondModDir = path.join(root, "second-mods");
    const originalPath = path.join(root, "original.txt");
    const firstPath = path.join(root, "first.txt");
    const secondPath = path.join(root, "second.txt");
    const agent = {
      id: "agent-1",
      name: "Amelia",
      llm_config: { model: "anthropic/claude-sonnet-4" },
    } as AgentState;
    const backend = {
      forkConversation: async () => ({ id: "forked" }),
      sendMessageStream: async () => (async function* () {})(),
    } as unknown as Backend;
    let firstAdapter: ReturnType<typeof createHeadlessModAdapter> | null = null;
    let secondAdapter: ReturnType<typeof createHeadlessModAdapter> | null =
      null;

    try {
      mkdirSync(firstModDir, { recursive: true });
      mkdirSync(secondModDir, { recursive: true });
      writeFileSync(originalPath, "original content");
      writeFileSync(firstPath, "first adapter content");
      writeFileSync(secondPath, "second adapter content");
      writeFileSync(
        path.join(firstModDir, "tool-start.ts"),
        `export default function activate(letta) {
          letta.events.on("tool_start", (event) => {
            if (event.toolName !== "Read") return;
            return { args: { ...event.args, file_path: ${JSON.stringify(firstPath)} } };
          });
        }`,
      );
      writeFileSync(
        path.join(secondModDir, "tool-start.ts"),
        `export default function activate(letta) {
          letta.events.on("tool_start", (event) => {
            if (event.toolName !== "Read") return;
            return { args: { ...event.args, file_path: ${JSON.stringify(secondPath)} } };
          });
        }`,
      );

      firstAdapter = createHeadlessModAdapter({
        agent,
        backend,
        cacheDirectory: path.join(root, "first-cache"),
        conversationId: "default",
        globalModsDirectory: firstModDir,
      });
      await firstAdapter.reload();
      const prepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          cachedAgent: agent,
          conversationId: "default",
          modEvents: firstAdapter.events,
        });

      secondAdapter = createHeadlessModAdapter({
        agent,
        backend,
        cacheDirectory: path.join(root, "second-cache"),
        conversationId: "default",
        globalModsDirectory: secondModDir,
      });
      await secondAdapter.reload();

      const result = await executeTool(
        "Read",
        { file_path: originalPath },
        {
          toolContextId:
            prepared.preparedToolContext.preparedToolContext.contextId,
        },
      );

      expect(result.status).toBe("success");
      expect(result.toolReturn).toContain("first adapter content");
      expect(result.toolReturn).not.toContain("second adapter content");
      expect(result.toolReturn).not.toContain("original content");
    } finally {
      firstAdapter?.dispose();
      secondAdapter?.dispose();
      rmSync(root, { force: true, recursive: true });
    }
  });
});
