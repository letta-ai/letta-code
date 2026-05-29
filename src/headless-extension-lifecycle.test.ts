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
import {
  clearExtensionTools,
  getExtensionToolDefinition,
} from "@/extensions/tool-registry";
import { __headlessTestUtils } from "@/headless";
import {
  createHeadlessExtensionContext,
  createHeadlessExtensionRuntime,
  HEADLESS_EXTENSION_CAPABILITIES,
} from "@/headless-extension-runtime";
import { executeTool } from "@/tools/manager";

function readHeadlessSource(): string {
  return readFileSync(
    fileURLToPath(new URL("./headless.ts", import.meta.url)),
    "utf-8",
  );
}

describe("headless extension runtime", () => {
  afterEach(() => {
    clearExtensionTools();
  });

  test("uses headless extension capabilities", () => {
    expect(HEADLESS_EXTENSION_CAPABILITIES).toEqual({
      tools: true,
      commands: false,
      events: {
        lifecycle: true,
        tools: true,
        turns: true,
      },
      providers: true,
      ui: {
        panels: false,
        statusValues: false,
        customStatuslineRenderer: false,
      },
    });
  });

  test("builds extension context for headless lifecycle events", () => {
    const context = createHeadlessExtensionContext({
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

  test("loads the runtime before headless modes and emits lifecycle events on exit", () => {
    const source = readHeadlessSource();

    const runtimeIndex = source.indexOf(
      "const headlessExtensionRuntime = createHeadlessExtensionRuntime",
    );
    const initialToolContextIndex = source.indexOf("const initialToolContext");
    const bidirectionalIndex = source.indexOf(
      "// If input-format is stream-json, use bidirectional mode",
    );
    expect(runtimeIndex).toBeGreaterThan(-1);
    expect(initialToolContextIndex).toBeGreaterThan(runtimeIndex);
    expect(bidirectionalIndex).toBeGreaterThan(runtimeIndex);

    expect(source).toContain("await headlessExtensionRuntime.reload()");
    expect(source).toContain("await emitHeadlessConversationOpen({");
    expect(source).toContain("await emitHeadlessConversationClose({");
    expect(source).toContain("headlessExtensionRuntime.dispose()");
  });

  test("registers extension tools for headless tool snapshots and disables commands/UI", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-headless-ext-tools-"));
    const extensionDir = path.join(root, "global-extensions");
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
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(
        path.join(extensionDir, "headless-tool.ts"),
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
            description: "Echo from headless extension",
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

      const runtime = createHeadlessExtensionRuntime({
        agent,
        backend,
        cacheDirectory: path.join(root, "extension-cache"),
        conversationId: "default",
        globalExtensionsDirectory: extensionDir,
      });

      await runtime.reload();
      const snapshot = runtime.getSnapshot().registry;

      expect(snapshot.tools[toolName]).toBeDefined();
      expect(snapshot.commands).toEqual({});
      expect(snapshot.ui.panels).toEqual({});
      expect(snapshot.ui.statusValues).toEqual({});
      expect(getExtensionToolDefinition(toolName)).toBeDefined();

      const prepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          cachedAgent: agent,
          conversationId: "default",
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

      runtime.dispose();
      expect(getExtensionToolDefinition(toolName)).toBeUndefined();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  test("emits tool_start before built-in tool execution", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "letta-headless-tool-start-"));
    const extensionDir = path.join(root, "global-extensions");
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
      mkdirSync(extensionDir, { recursive: true });
      writeFileSync(originalPath, "original content");
      writeFileSync(replacementPath, "replacement content");
      writeFileSync(
        path.join(extensionDir, "tool-start.ts"),
        `export default function activate(letta) {
          letta.events.on("tool_start", (event) => {
            if (event.toolName !== "Read") return;
            return { args: { ...event.args, file_path: ${JSON.stringify(replacementPath)} } };
          });
        }`,
      );

      const runtime = createHeadlessExtensionRuntime({
        agent,
        backend,
        cacheDirectory: path.join(root, "extension-cache"),
        conversationId: "default",
        globalExtensionsDirectory: extensionDir,
      });

      await runtime.reload();
      const prepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          cachedAgent: agent,
          conversationId: "default",
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

      runtime.dispose();
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
