import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applySetMaxContext,
  MIN_CONTEXT_WINDOW_TOKENS,
  parseContextWindowValue,
  parseSetMaxContextArgs,
  resolveModelJsonContextWindow,
} from "../../agent/maxContext";
import {
  __testSetBackend,
  type AgentCreateBody,
  type ConversationCreateBody,
} from "../../backend";
import { LocalBackend } from "../../backend/local";

afterEach(() => {
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
  });

  test("resolves model.json default context windows", () => {
    expect(
      resolveModelJsonContextWindow({ modelId: "sonnet" }).contextWindow,
    ).toBe(200_000);
    expect(
      resolveModelJsonContextWindow({
        modelHandle: "anthropic/claude-sonnet-4-6",
        llmConfig: { reasoning_effort: "low", enable_reasoner: true },
      }).contextWindow,
    ).toBe(200_000);
    expect(
      resolveModelJsonContextWindow({ modelHandle: "custom/model" })
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
        model: "anthropic/claude-sonnet-4-6",
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
          args: "250000",
          currentModelId: "sonnet",
        }),
      ).rejects.toThrow("model.json default of 200,000 tokens");

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
      expect(resetResult.contextWindow).toBe(200_000);
      expect(resetResult.reset).toBe(true);

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

  test("fails reset when no model.json default exists", async () => {
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
        }),
      ).rejects.toThrow(
        "No default value for max context window found in model.json",
      );
    } finally {
      await rm(storageDir, { recursive: true, force: true });
    }
  });
});
