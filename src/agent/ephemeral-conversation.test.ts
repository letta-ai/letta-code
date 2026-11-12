import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEphemeralConversationCreateBody,
  createLocalEphemeralConversation,
} from "@/agent/ephemeral-conversation";
import {
  configureBackendMode,
  configureEphemeralLocalBackend,
  getBackend,
} from "@/backend";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";

setupRuntimeModelCatalogFixture();
describe("ephemeral conversation creation", () => {
  afterEach(() => {
    configureBackendMode("api");
  });

  test("builds execution state without agent memory or tags", async () => {
    const body = await buildEphemeralConversationCreateBody({
      model: "gpt-5.6-luna",
      systemPromptCustom: "isolated prompt",
    });

    expect(body.model).toBe("openai/gpt-5.6-luna");
    expect(body.system).toBe("isolated prompt");
    expect(body.context_window_limit).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("memory_blocks");
  });

  test("creates local execution state outside the persistent local store", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "letta-local-persistent-"));
    const originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    try {
      configureBackendMode("local");
      configureEphemeralLocalBackend();
      const result = await createLocalEphemeralConversation({
        model: "openai/gpt-5-mini",
        systemPromptCustom: "isolated local prompt",
      });

      expect(result.agent.id).toStartWith("agent-local-");
      expect(result.conversationId).toStartWith("local-conv-");
      expect(existsSync(join(storageDir, "agents"))).toBe(false);
      expect(existsSync(join(storageDir, "conversations"))).toBe(false);
      expect(existsSync(join(storageDir, "memfs"))).toBe(false);
    } finally {
      if (originalStorageDir === undefined) {
        delete process.env.LETTA_LOCAL_BACKEND_DIR;
      } else {
        process.env.LETTA_LOCAL_BACKEND_DIR = originalStorageDir;
      }
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test("fresh same-model subagents inherit conversation budgets without copying other settings", async () => {
    const backend = getBackend();
    const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
      id: "agent-parent",
      model: "openai/gpt-5.6-luna",
      model_settings: { max_output_tokens: 16000 },
      context_window_limit: 128000,
    } as unknown as Awaited<ReturnType<typeof backend.retrieveAgent>>);
    const conversation = spyOn(
      backend,
      "retrieveConversation",
    ).mockResolvedValue({
      id: "conv-parent",
      agent_id: "agent-parent",
      model: "openai/gpt-5.6-luna",
      model_settings: {
        max_output_tokens: 24000,
        reasoning_effort: "low",
        temperature: 0.3,
      },
      context_window_limit: 256000,
    } as Awaited<ReturnType<typeof backend.retrieveConversation>>);
    try {
      const body = await buildEphemeralConversationCreateBody(
        { model: "gpt-5.6-luna", systemPromptCustom: "probe" },
        {
          LETTA_CODE_AGENT_ROLE: "subagent",
          LETTA_PARENT_AGENT_ID: "agent-parent",
          LETTA_PARENT_CONVERSATION_ID: "conv-parent",
        },
      );
      expect(body.context_window_limit).toBe(256000);
      expect(body.model_settings?.max_output_tokens).toBe(24000);
      expect(body.model_settings?.reasoning_effort).toBe("high");
      expect(body.model_settings?.temperature).toBeUndefined();
    } finally {
      conversation.mockRestore();
      agent.mockRestore();
    }
  });

  test("an unpinned conversation uses the parent agent budgets", async () => {
    const backend = getBackend();
    const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
      id: "agent-parent",
      model: "openai/gpt-5.6-luna",
      llm_config: { max_tokens: 16000, context_window: 192000 },
    } as unknown as Awaited<ReturnType<typeof backend.retrieveAgent>>);
    const conversation = spyOn(
      backend,
      "retrieveConversation",
    ).mockResolvedValue({
      id: "conv-parent",
      agent_id: "agent-parent",
      model: null,
      model_settings: null,
      context_window_limit: null,
    } as Awaited<ReturnType<typeof backend.retrieveConversation>>);
    try {
      const body = await buildEphemeralConversationCreateBody(
        { model: "gpt-5.6-luna", systemPromptCustom: "probe" },
        {
          LETTA_CODE_AGENT_ROLE: "subagent",
          LETTA_PARENT_AGENT_ID: "agent-parent",
          LETTA_PARENT_CONVERSATION_ID: "conv-parent",
        },
      );
      expect(body.context_window_limit).toBe(192000);
      expect(body.model_settings?.max_output_tokens).toBe(16000);
    } finally {
      conversation.mockRestore();
      agent.mockRestore();
    }
  });

  test("a subagent on a different model keeps its own catalog budgets", async () => {
    const backend = getBackend();
    const agent = spyOn(backend, "retrieveAgent").mockResolvedValue({
      id: "agent-parent",
      model: "anthropic/claude-sonnet-5",
      model_settings: { max_output_tokens: 4000 },
      context_window_limit: 64000,
    } as unknown as Awaited<ReturnType<typeof backend.retrieveAgent>>);
    try {
      const body = await buildEphemeralConversationCreateBody(
        { model: "gpt-5.6-luna", systemPromptCustom: "probe" },
        {
          LETTA_CODE_AGENT_ROLE: "subagent",
          LETTA_PARENT_AGENT_ID: "agent-parent",
        },
      );
      expect(body.context_window_limit).toBe(350000);
      expect(body.model_settings?.max_output_tokens).toBe(128000);
    } finally {
      agent.mockRestore();
    }
  });
});
