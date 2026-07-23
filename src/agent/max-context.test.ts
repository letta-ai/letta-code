import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySetMaxContext,
  MIN_CONTEXT_WINDOW_TOKENS,
  parseContextWindowValue,
  parseSetMaxContextArgs,
  resolveCatalogContextWindow,
} from "@/agent/max-context";
import {
  __testSetBackend,
  type AgentCreateBody,
  type ConversationCreateBody,
} from "@/backend";
import { LocalBackend } from "@/backend/local";
import {
  clearRuntimeModelCatalogFixture,
  installRuntimeModelCatalogFixture,
} from "@/test-utils/runtime-model-catalog";

beforeEach(installRuntimeModelCatalogFixture);

afterEach(() => {
  clearRuntimeModelCatalogFixture();
  __testSetBackend(null);
});

describe("max context command helpers", () => {
  test("parses token counts and override flag", () => {
    expect(parseContextWindowValue("30000")).toBe(30_000);
    expect(parseContextWindowValue("30k")).toBe(30_000);
    expect(parseContextWindowValue("1m")).toBe(1_000_000);
    expect(parseSetMaxContextArgs("10000 --override")).toEqual({
      value: 10_000,
      override: true,
    });
    expect(parseSetMaxContextArgs("")).toEqual({
      value: null,
      override: false,
    });
    expect(() => parseSetMaxContextArgs("10000 --force")).toThrow(
      "Unknown option: --force",
    );
    expect(() => parseSetMaxContextArgs("10000 20000")).toThrow(
      "Usage: /context-limit [tokens] [--override]",
    );
  });

  test("resolves runtime catalog default context windows", () => {
    expect(
      resolveCatalogContextWindow({ modelId: "sonnet" }).contextWindow,
    ).toBe(1_000_000);
    expect(
      resolveCatalogContextWindow({ modelId: "sonnet-4.6" }).contextWindow,
    ).toBe(200_000);
    expect(
      resolveCatalogContextWindow({
        modelHandle: "anthropic/claude-sonnet-4-6",
        llmConfig: { reasoning_effort: "low", enable_reasoner: true },
      }).contextWindow,
    ).toBe(200_000);
    expect(
      resolveCatalogContextWindow({ modelHandle: "custom/model" })
        .contextWindow,
    ).toBeUndefined();
  });

  test("applies min/max validation with override escape hatch", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "max-context-local-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Max Context Agent",
        model: "anthropic/claude-sonnet-5",
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
          parallel_tool_calls: true,
        },
      } as AgentCreateBody);

      await expect(
        applySetMaxContext({
          agentId: agent.id,
          conversationId: "default",
          args: `${MIN_CONTEXT_WINDOW_TOKENS - 1}`,
          currentModelId: "sonnet",
        }),
      ).rejects.toThrow("at least 30,000 tokens");

      await expect(
        applySetMaxContext({
          agentId: agent.id,
          conversationId: "default",
          args: "1100000",
          currentModelId: "sonnet",
        }),
      ).rejects.toThrow("catalog default of 1,000,000 tokens");

      const overrideResult = await applySetMaxContext({
        agentId: agent.id,
        conversationId: "default",
        args: "10000 --override",
        currentModelId: "sonnet",
      });
      expect(overrideResult.contextWindow).toBe(10_000);
      expect(overrideResult.appliedTo).toBe("agent");
      expect(
        (
          (await backend.retrieveAgent(agent.id)) as {
            llm_config?: { context_window?: number };
          }
        ).llm_config?.context_window,
      ).toBe(10_000);

      const resetResult = await applySetMaxContext({
        agentId: agent.id,
        conversationId: "default",
        args: "",
        currentModelId: "sonnet",
      });
      expect(resetResult.contextWindow).toBe(1_000_000);
      expect(resetResult.reset).toBe(true);

      await backend.updateAgent(agent.id, {
        model_settings: {
          provider_type: "anthropic",
          effort: "high",
          parallel_tool_calls: true,
        },
      } as Parameters<typeof backend.updateAgent>[1]);

      const conversation = await backend.createConversation({
        agent_id: agent.id,
      } as ConversationCreateBody);
      const conversationResult = await applySetMaxContext({
        agentId: agent.id,
        conversationId: conversation.id,
        args: "50000",
        currentModelId: "sonnet",
      });
      expect(conversationResult.appliedTo).toBe("conversation");
      expect(conversationResult.conversationModelSettings).toMatchObject({
        provider_type: "anthropic",
        effort: "high",
      });
      expect(
        (
          (await backend.retrieveConversation(conversation.id)) as {
            context_window_limit?: number;
          }
        ).context_window_limit,
      ).toBe(50_000);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });

  test("explains reset fallback for custom models without catalog defaults", async () => {
    const storageDir = await mkdtemp(join(tmpdir(), "max-context-custom-"));
    try {
      const backend = new LocalBackend({
        storageDir,
        executionMode: "deterministic",
      });
      __testSetBackend(backend);
      const agent = await backend.createAgent({
        name: "Custom Model Agent",
        model: "custom/model",
      } as AgentCreateBody);

      await expect(
        applySetMaxContext({
          agentId: agent.id,
          conversationId: "default",
          args: "",
          currentModelHandle: "custom/model",
          currentContextWindow: 131_072,
        }),
      ).rejects.toThrow(
        "No catalog default for model custom/model, so reset is unavailable. Pass an explicit value: /context-limit 131072.",
      );

      const explicitResult = await applySetMaxContext({
        agentId: agent.id,
        conversationId: "default",
        args: "131072",
        currentModelHandle: "custom/model",
      });
      expect(explicitResult.contextWindow).toBe(131_072);
      expect(explicitResult.reset).toBe(false);
      expect(explicitResult.appliedTo).toBe("agent");
      expect(
        (
          (await backend.retrieveAgent(agent.id)) as {
            llm_config?: { context_window?: number };
          }
        ).llm_config?.context_window,
      ).toBe(131_072);
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
