import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import {
  clearAvailableModelsCache,
  getAvailableModelHandles,
} from "@/agent/available-models";
import {
  __testSetBackend,
  type AgentCreateBody,
  type Backend,
  type ConversationCreateBody,
} from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { LocalBackend } from "@/backend/local";
import { settingsManager } from "@/settings-manager";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import { __listenClientTestUtils } from "@/websocket/listen-client";
import { applyToolsetUpdateForRuntime } from "@/websocket/listener/commands/model-toolset";

/**
 * Tests for the model update command logic.
 *
 * These tests deliberately avoid mock.module to prevent mock leakage
 * across bun's shared test module graph. Pure function tests cover the
 * conditional status message and error handling; structural assertions
 * verify wiring that can't be tested without mocking API calls.
 */

function readModelToolsetCommandSource(): string {
  const commandPath = fileURLToPath(
    new URL("./listener/commands/model-toolset.ts", import.meta.url),
  );
  return readFileSync(commandPath, "utf-8");
}

function readCliConfigurationHandlerSource(): string {
  const handlerPath = fileURLToPath(
    new URL("../cli/app/use-configuration-handlers.ts", import.meta.url),
  );
  return readFileSync(handlerPath, "utf-8");
}

function readLocalChannelGatewaySource(): string {
  const gatewayPath = fileURLToPath(
    new URL("../channels/gateway-local.ts", import.meta.url),
  );
  return readFileSync(gatewayPath, "utf-8");
}

class MockSocket {
  readyState = WebSocket.OPEN;
  sentPayloads: string[] = [];

  send(data: string): void {
    this.sentPayloads.push(data);
  }
}

class NativeChatGptCatalogBackend extends FakeHeadlessBackend {
  override async listModels(): ReturnType<Backend["listModels"]> {
    return [
      {
        handle: "chatgpt-jin/gpt-5.6-sol-fast",
        display_name: "GPT-5.6 Sol Fast",
        provider_type: "chatgpt_oauth",
        provider_category: "byok",
      },
    ] as never;
  }
}

beforeEach(installRuntimeModelCatalogFixture);

afterEach(async () => {
  clearRuntimeModelCatalogFixture();
  clearAvailableModelsCache();
  __testSetBackend(null);
  await settingsManager.reset();
});

describe("listen-client model update status message", () => {
  test("does not add toolset details to the model update", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Claude Sonnet 4",
      toolsetError: null,
    });

    expect(result.message).toBe("Model updated to Claude Sonnet 4.");
    expect(result.level).toBe("info");
  });

  test("does not add toolset details to the CLI model update", () => {
    const source = readCliConfigurationHandlerSource();

    expect(source).not.toContain("Auto toolset selected: switched to");
    expect(source).not.toContain("Manual toolset override remains active");
  });

  test("includes reasoning effort when updateArgs has reasoning_effort", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Opus 4.6",
      toolsetError: null,
      updateArgs: { reasoning_effort: "medium" },
    });

    expect(result.message).toBe("Model updated to Opus 4.6 (Medium).");
    expect(result.level).toBe("info");
  });

  test("shows No Reasoning for reasoning_effort none", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Opus 4.6",
      toolsetError: null,
      updateArgs: { reasoning_effort: "none" },
    });

    expect(result.message).toBe("Model updated to Opus 4.6 (No Reasoning).");
  });

  test("shows Max for reasoning_effort xhigh on older Anthropic models", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Opus 4.6",
      toolsetError: null,
      updateArgs: { reasoning_effort: "xhigh" },
    });

    expect(result.message).toBe("Model updated to Opus 4.6 (Max).");
  });

  test("shows Extra High for reasoning_effort xhigh on Fable and Opus 4.7+", () => {
    for (const modelLabel of ["Fable 5", "Opus 4.7", "Opus 4.8"]) {
      const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
        modelLabel,
        toolsetError: null,
        updateArgs: { reasoning_effort: "xhigh" },
      });

      expect(result.message).toBe(
        `Model updated to ${modelLabel} (Extra High).`,
      );
    }
  });

  test("shows Extra High for reasoning_effort xhigh on GPT-5.6 Sol ChatGPT", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GPT-5.6 Sol (ChatGPT)",
      toolsetError: null,
      updateArgs: { reasoning_effort: "xhigh" },
      modelHandle: "chatgpt-plus-pro/gpt-5.6-sol",
    });

    expect(result.message).toBe(
      "Model updated to GPT-5.6 Sol (ChatGPT) (Extra High).",
    );
  });

  test("shows Max for reasoning_effort max on GPT-5.6 Sol ChatGPT", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GPT-5.6 Sol (ChatGPT)",
      toolsetError: null,
      updateArgs: { reasoning_effort: "max" },
      modelHandle: "chatgpt-plus-pro/gpt-5.6-sol",
    });

    expect(result.message).toBe(
      "Model updated to GPT-5.6 Sol (ChatGPT) (Max).",
    );
  });

  test("omits effort when updateArgs has no reasoning_effort", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "GLM-5",
      toolsetError: null,
      updateArgs: { context_window: 180000 },
    });

    expect(result.message).toBe("Model updated to GLM-5.");
  });

  test("reports warning level when toolset switch failed", () => {
    const result = __listenClientTestUtils.buildModelUpdateStatusMessage({
      modelLabel: "Claude Sonnet 4",
      toolsetError: "Network timeout",
    });

    expect(result.message).toContain("Model updated to Claude Sonnet 4.");
    expect(result.message).toContain("Warning: toolset switch failed");
    expect(result.message).toContain("Network timeout");
    expect(result.level).toBe("warning");
  });
});

describe("listen-client applyModelUpdateForRuntime wiring", () => {
  test("updates scoped runtime tools and wraps toolset refresh in try/catch", () => {
    const source = readModelToolsetCommandSource();

    expect(source).toContain(
      "await ensureCorrectMemoryTool(agentId, model.handle)",
    );
    expect(source).toContain("await prepareToolExecutionContextForScope({");
    expect(source).toContain("overrideModel: model.handle");
    expect(source).toContain(
      "preparedToolContext.preparedToolContext.loadedToolNames;",
    );

    // Tool refresh failures should still degrade cleanly to a warning.
    expect(source).toContain("toolsetError =");
    expect(source).toContain(
      'error instanceof Error ? error.message : "Failed to switch toolset"',
    );
  });

  test("routes default conversations to agent update and non-default to conversation update", () => {
    const source = readModelToolsetCommandSource();

    // Agent-scoped update for default conversation
    expect(source).toContain('conversationId === "default"');
    expect(source).toContain("updateAgentLLMConfig(");
    expect(source).toContain('appliedTo = "agent"');

    // Conversation-scoped update for non-default
    expect(source).toContain("updateConversationLLMConfig(");
    expect(source).toContain('appliedTo = "conversation"');

    // Context-window preservation must RE-SEND the current value explicitly
    // (contextWindowOverride), never omit the field (an omitted
    // context_window_limit makes the server re-derive and clamp it to a
    // legacy 128k default — LET-9786), and must not preserve a value that
    // looks like that server clamp (preservableContextWindow).
    expect(source).not.toContain("avoidOverwritingExistingContextWindow");
    expect(source).not.toContain("delete updateArgsForRequest.context_window");
    expect(source).toContain("preservableContextWindow(");
    expect(source).toContain("contextWindowOverride: preservedContextWindow");
  });

  test("preserves registry provider type for BYOK model id updates", () => {
    const resolved = __listenClientTestUtils.resolveModelForUpdate({
      model_id: "opus-4.8-medium",
      model_handle: "lc-anthropic/claude-opus-4-8",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.handle).toBe("lc-anthropic/claude-opus-4-8");
    expect(resolved?.updateArgs?.provider_type).toBe("anthropic");
    expect(resolved?.updateArgs?.reasoning_effort).toBe("medium");
  });

  test("reports the current scoped model for channel /model without args", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-current-model-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = storageDir;
      await settingsManager.reset();
      await settingsManager.initialize();

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Current Model Agent",
        model: "anthropic/claude-sonnet-4-6",
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      await expect(
        __listenClientTestUtils.getCurrentModelStatusForRuntime({
          agentId: agent.id,
          conversationId: "default",
        }),
      ).resolves.toMatchObject({
        modelHandle: "anthropic/claude-sonnet-4-6",
        scope: "agent",
      });
      await expect(
        __listenClientTestUtils.getCurrentModelStatusForRuntime({
          agentId: agent.id,
          conversationId: conversation.id,
        }),
      ).resolves.toMatchObject({
        modelHandle: "anthropic/claude-sonnet-4-6",
        scope: "conversation",
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves ChatGPT OAuth provider type for alias-backed model id updates", () => {
    const resolved = __listenClientTestUtils.resolveModelForUpdate({
      model_id: "gpt-5.5-plus-pro-high",
      model_handle: "chatgpt-jin/gpt-5.5",
    });

    expect(resolved).not.toBeNull();
    expect(resolved?.handle).toBe("chatgpt-jin/gpt-5.5");
    expect(resolved?.updateArgs?.provider_type).toBe("chatgpt_oauth");
    expect(resolved?.updateArgs?.reasoning_effort).toBe("high");
  });

  test("switches ChatGPT alias model id updates to Codex toolset", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "ws-chatgpt-alias-model-id-"),
    );
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = storageDir;
      await settingsManager.reset();
      await settingsManager.initialize();

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "ChatGPT Alias Agent",
        model: "anthropic/claude-sonnet-4-6",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
          parallel_tool_calls: true,
        },
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const listener = __listenClientTestUtils.createListenerRuntime();
      const scopedRuntime =
        __listenClientTestUtils.getOrCreateConversationRuntime(
          listener,
          agent.id,
          conversation.id,
        );
      const model = __listenClientTestUtils.resolveModelForUpdate({
        model_id: "gpt-5.5-plus-pro-high",
        model_handle: "chatgpt-jin/gpt-5.5",
      });
      if (!model) {
        throw new Error("Expected gpt-5.5-plus-pro-high model fixture");
      }

      const response = await __listenClientTestUtils.applyModelUpdateForRuntime(
        {
          socket: new MockSocket() as unknown as WebSocket,
          listener,
          scopedRuntime,
          requestId: "chatgpt-alias-model-id",
          model,
        },
      );

      expect(response.success).toBe(true);
      expect(response.model_id).toBe("gpt-5.5-plus-pro-high");
      expect(response.model_handle).toBe("chatgpt-jin/gpt-5.5");
      expect(response.model_settings).toMatchObject({
        provider_type: "chatgpt_oauth",
        reasoning: { reasoning_effort: "high" },
      });
      expect(scopedRuntime.currentToolset).toBe("codex");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("switches native ChatGPT Fast aliases to Codex toolset", async () => {
    const storageDir = await mkdtemp(
      join(os.tmpdir(), "ws-chatgpt-fast-alias-"),
    );
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = storageDir;
      await settingsManager.reset();
      await settingsManager.initialize();

      __testSetBackend(new NativeChatGptCatalogBackend());
      await getAvailableModelHandles();

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "ChatGPT Fast Alias Agent",
        model: "anthropic/claude-sonnet-4-6",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
          parallel_tool_calls: true,
        },
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const listener = __listenClientTestUtils.createListenerRuntime();
      const scopedRuntime =
        __listenClientTestUtils.getOrCreateConversationRuntime(
          listener,
          agent.id,
          conversation.id,
        );
      const model = __listenClientTestUtils.resolveModelForUpdate({
        model_id: "chatgpt-jin/gpt-5.6-sol-fast",
      });
      if (!model) throw new Error("Expected native ChatGPT Fast model fixture");

      const response = await __listenClientTestUtils.applyModelUpdateForRuntime(
        {
          socket: new MockSocket() as unknown as WebSocket,
          listener,
          scopedRuntime,
          requestId: "chatgpt-fast-alias",
          model,
        },
      );

      expect(response.success).toBe(true);
      expect(response.model_handle).toBe("chatgpt-jin/gpt-5.6-sol-fast");
      expect(response.model_settings).toMatchObject({
        provider_type: "chatgpt_oauth",
      });
      expect(scopedRuntime.currentToolset).toBe("codex");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("resolves provider metadata for conversation model overrides", async () => {
    const backend = new NativeChatGptCatalogBackend(
      "agent-conversation-toolset",
      undefined,
      {},
      { modelHandle: "anthropic/claude-sonnet-4-6" },
    );
    __testSetBackend(backend);
    const agent = await backend.retrieveAgent("agent-conversation-toolset");
    const conversation = await backend.createConversation({
      agent_id: agent.id,
      model: "chatgpt-jin/gpt-5.6-sol-fast",
    } as ConversationCreateBody);

    const prepared = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: conversation.id,
      cachedAgent: {
        ...agent,
        model: "anthropic/claude-sonnet-4-6",
        model_settings: { provider_type: "anthropic" },
      },
    });

    expect(prepared.toolsetPreference).toBe("auto");
    expect(prepared.toolset).toBe("codex");
    expect(prepared.preparedToolContext.loadedToolNames).toContain(
      "ApplyPatch",
    );
    expect(prepared.preparedToolContext.loadedToolNames).not.toContain("Edit");
  });

  test("switches BYOK Opus 4.8 max update from stale ChatGPT provider state to default toolset", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-byok-opus-max-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = storageDir;
      await settingsManager.reset();
      await settingsManager.initialize();

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "BYOK Opus Agent",
        model: "chatgpt-jin/gpt-5.5",
        model_settings: {
          provider_type: "chatgpt_oauth",
          reasoning: { reasoning_effort: "high" },
          parallel_tool_calls: true,
        },
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);

      const listener = __listenClientTestUtils.createListenerRuntime();
      const scopedRuntime =
        __listenClientTestUtils.getOrCreateConversationRuntime(
          listener,
          agent.id,
          conversation.id,
        );
      const model = __listenClientTestUtils.resolveModelForUpdate({
        model_id: "opus-4.8-max",
        model_handle: "lc-anthropic/claude-opus-4-8",
      });
      if (!model) throw new Error("Expected opus-4.8-max model fixture");

      const response = await __listenClientTestUtils.applyModelUpdateForRuntime(
        {
          socket: new MockSocket() as unknown as WebSocket,
          listener,
          scopedRuntime,
          requestId: "byok-opus-max",
          model,
        },
      );

      expect(response.success).toBe(true);
      expect(response.model_id).toBe("opus-4.8-max");
      expect(response.model_handle).toBe("lc-anthropic/claude-opus-4-8");
      expect(response.model_settings).toMatchObject({
        provider_type: "anthropic",
        effort: "max",
      });
      expect(scopedRuntime.currentToolset).toBe("default");
      expect(scopedRuntime.currentLoadedTools).toContain("Edit");
      expect(scopedRuntime.currentLoadedTools).not.toContain("exec_command");
      expect(
        (response.model_settings as Record<string, unknown> | null)?.reasoning,
      ).toBeUndefined();
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("keeps manual toolsets scoped to one conversation", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-toolset-scope-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = storageDir;
      await settingsManager.reset();
      await settingsManager.initialize();

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Fable Toolset Agent",
        model: "anthropic/claude-fable-5",
        model_settings: { provider_type: "anthropic" },
      } as AgentCreateBody);
      const conversationA = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      const conversationB = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      settingsManager.setToolsetPreference(agent.id, "codex");

      const listener = __listenClientTestUtils.createListenerRuntime();
      const runtimeA = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        conversationA.id,
      );
      await applyToolsetUpdateForRuntime({
        socket: new MockSocket() as unknown as WebSocket,
        listener,
        scopedRuntime: runtimeA,
        requestId: "toolset-conv-a",
        toolsetPreference: "codex",
      });

      expect(runtimeA.currentToolset).toBe("codex");
      expect(
        settingsManager.getToolsetPreference(agent.id, conversationA.id),
      ).toBe("codex");
      expect(
        settingsManager.getToolsetPreference(agent.id, conversationB.id),
      ).toBe("auto");
      expect(
        __listenClientTestUtils.buildDeviceStatus(listener, {
          agent_id: agent.id,
          conversation_id: conversationB.id,
        }).current_toolset_preference,
      ).toBe("auto");

      const preparedB = await prepareToolExecutionContextForScope({
        agentId: agent.id,
        conversationId: conversationB.id,
      });
      expect(preparedB.toolsetPreference).toBe("auto");
      expect(preparedB.toolset).toBe("default");
      expect(preparedB.preparedToolContext.loadedToolNames).toContain("Edit");
      expect(preparedB.preparedToolContext.loadedToolNames).not.toContain(
        "ApplyPatch",
      );

      settingsManager.setToolsetPreference(
        agent.id,
        "gemini",
        conversationB.id,
      );
      const originalModAdapter = listener.modAdapter;
      listener.modAdapter = {
        getAvailablePermissions: () => {
          throw new Error("toolset preparation failed");
        },
      } as never;
      try {
        await expect(
          applyToolsetUpdateForRuntime({
            socket: new MockSocket() as unknown as WebSocket,
            listener,
            scopedRuntime: runtimeA,
            requestId: "toolset-conv-a-failure",
            toolsetPreference: "default",
          }),
        ).rejects.toThrow("toolset preparation failed");
      } finally {
        listener.modAdapter = originalModAdapter;
      }
      expect(
        settingsManager.getToolsetPreference(agent.id, conversationA.id),
      ).toBe("codex");
      expect(
        settingsManager.getToolsetPreference(agent.id, conversationB.id),
      ).toBe("gemini");
      expect(runtimeA.currentToolset).toBe("codex");

      settingsManager.setToolsetPreference(
        agent.id,
        "default",
        conversationB.id,
      );
      const manualDefaultB = await prepareToolExecutionContextForScope({
        agentId: agent.id,
        conversationId: conversationB.id,
        overrideModel: "openai/gpt-5.4",
        overrideProviderType: "openai",
      });
      expect(manualDefaultB.toolsetPreference).toBe("default");
      expect(manualDefaultB.toolset).toBe("default");
      settingsManager.setToolsetPreference(agent.id, "auto", conversationB.id);

      await applyToolsetUpdateForRuntime({
        socket: new MockSocket() as unknown as WebSocket,
        listener,
        scopedRuntime: runtimeA,
        requestId: "toolset-conv-a-auto",
        toolsetPreference: "auto",
      });
      expect(runtimeA.currentToolset).toBe("default");
      expect(
        settingsManager.getToolsetPreference(agent.id, conversationA.id),
      ).toBe("auto");
      expect(settingsManager.getToolsetPreference(agent.id)).toBe("codex");

      settingsManager.setToolsetPreference(agent.id, "codex", conversationB.id);
      const runtimeB = __listenClientTestUtils.getOrCreateConversationRuntime(
        listener,
        agent.id,
        conversationB.id,
      );
      expect(runtimeB.currentToolset).toBeNull();
      expect(
        __listenClientTestUtils.buildDeviceStatus(listener, {
          agent_id: agent.id,
          conversation_id: conversationB.id,
        }).current_toolset_preference,
      ).toBe("codex");
    } finally {
      await settingsManager.reset();
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("preserves conversation context limit for same-handle desktop model updates", async () => {
    const storageDir = await mkdtemp(join(os.tmpdir(), "ws-model-context-"));
    const previousHome = process.env.HOME;
    try {
      process.env.HOME = storageDir;
      await settingsManager.reset();
      await settingsManager.initialize();

      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Desktop Model Agent",
        model: "openai/gpt-5.5",
        context_window_limit: 500000,
        model_settings: {
          provider_type: "openai",
          reasoning: { reasoning_effort: "high" },
          parallel_tool_calls: true,
        },
      } as AgentCreateBody);
      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      await backend.updateConversation(conversation.id, {
        context_window_limit: 500000,
      } as Parameters<typeof backend.updateConversation>[1]);

      const listener = __listenClientTestUtils.createListenerRuntime();
      const scopedRuntime =
        __listenClientTestUtils.getOrCreateConversationRuntime(
          listener,
          agent.id,
          conversation.id,
        );
      const model = __listenClientTestUtils.resolveModelForUpdate({
        model_id: "gpt-5.5-medium",
      });
      if (!model) throw new Error("Expected gpt-5.5-medium model fixture");

      const response = await __listenClientTestUtils.applyModelUpdateForRuntime(
        {
          socket: new MockSocket() as unknown as WebSocket,
          listener,
          scopedRuntime,
          requestId: "model-update-context-1",
          model,
        },
      );

      expect(response.success).toBe(true);
      expect(
        (
          (await backend.retrieveConversation(conversation.id)) as {
            context_window_limit?: number;
          }
        ).context_window_limit,
      ).toBe(500000);
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});

describe("local channel gateway model command wiring", () => {
  test("routes channel /model through the App Server model protocol", () => {
    const source = readLocalChannelGatewaySource();

    expect(source).toContain("registry.setModelHandler");
    expect(source).toContain("gateway.getModelStatus(runtime)");
    expect(source).toContain(
      "buildChannelCurrentModelMessage(channelId, status)",
    );
    expect(source).toContain('modelIdentifier.toLowerCase() === "list"');
    expect(source).toContain("client.request<ListModelsResponseMessage>(");
    expect(source).toContain("client.request<UpdateModelResponseMessage>(");
    expect(source).toContain("settingsManager.getRecentModels()");
    expect(source).toContain(
      "settingsManager.addRecentModel(response.model_handle ?? modelIdentifier)",
    );
    expect(source).toContain("gateway.updateModelStatus(");
  });
});

describe("listen-client list_models response wiring", () => {
  test("buildListModelsResponse is async and uses Promise.allSettled for parallel fetches", () => {
    const source = readModelToolsetCommandSource();

    // The response builder should use Promise.allSettled for parallel fetches
    expect(source).toContain("Promise.allSettled");
    expect(source).toContain("getAvailableModelHandles(");
    expect(source).toContain("listProviders()");
    expect(source).toContain("buildByokProviderAliases(providers)");
  });

  test("handler uses async pattern with buildListModelsResponse", () => {
    const source = readModelToolsetCommandSource();

    // Handler should be wrapped in void (async () => { ... })() pattern
    expect(source).toContain("buildListModelsResponse(parsed.request_id, {");
  });

  test("user-initiated force refresh bypasses the availability cache", () => {
    const source = readModelToolsetCommandSource();

    // The WS command's force flag must reach getAvailableModelHandles as
    // forceRefresh — otherwise "Refresh model list" can be answered from a
    // stale-but-within-TTL cache snapshot (LET-9479).
    expect(source).toContain("forceRefresh: parsed.force === true");
    expect(source).toContain(
      "getAvailableModelHandles(\n      options.forceRefresh === true ? { forceRefresh: true } : undefined,\n    )",
    );
  });

  test("response type includes available_handles and byok_provider_aliases fields", () => {
    const source = readModelToolsetCommandSource();

    // The response payload should include the new fields
    expect(source).toContain("available_handles: availableHandles");
    expect(source).toContain("byok_provider_aliases: byokProviderAliases");
  });

  test("available_handles is null when availability fetch fails (degraded path)", () => {
    const source = readModelToolsetCommandSource();

    // Should handle rejected availability fetch by returning null
    expect(source).toContain('handlesResult.status === "fulfilled"');
    // Null fallback when fetch fails
    expect(source).toContain(": null");
  });

  test("buildListModelsEntries returns entries with expected shape", () => {
    const entries = __listenClientTestUtils.buildListModelsEntries();

    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);

    // Every entry should have required fields
    for (const entry of entries) {
      expect(typeof entry.id).toBe("string");
      expect(typeof entry.handle).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.description).toBe("string");
    }
  });

  test("buildListModelsEntries preserves updateArgs when present", () => {
    const entries = __listenClientTestUtils.buildListModelsEntries();

    // At least some entries should have updateArgs (models with config)
    const withUpdateArgs = entries.filter(
      (e) => e.updateArgs && Object.keys(e.updateArgs).length > 0,
    );
    expect(withUpdateArgs.length).toBeGreaterThan(0);

    // At least some entries with updateArgs should have reasoning_effort
    const withReasoningEffort = withUpdateArgs.filter(
      (e) => "reasoning_effort" in (e.updateArgs as Record<string, unknown>),
    );
    expect(withReasoningEffort.length).toBeGreaterThan(0);
  });

  test("buildListModelsResponse is exposed on test utils", () => {
    expect(typeof __listenClientTestUtils.buildListModelsResponse).toBe(
      "function",
    );
  });
});
