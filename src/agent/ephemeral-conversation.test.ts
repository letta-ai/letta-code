import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEphemeralConversationCreateBody,
  createEphemeralConversation,
  createLocalEphemeralConversation,
} from "@/agent/ephemeral-conversation";
import {
  configureBackendMode,
  configureEphemeralLocalBackend,
} from "@/backend";
import { settingsManager } from "@/settings-manager";
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
      parentAgentId: "agent-parent",
      name: "Joi",
      isSubagent: true,
    });

    expect(body.model).toBe("openai/gpt-5.6-luna");
    expect(body.system).toBe("isolated prompt");
    expect(body.parent_agent_id).toBe("agent-parent");
    expect(body.name).toBe("Joi");
    expect(body.is_subagent).toBe(true);
    expect(body.context_window_limit).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("memory_blocks");
  });

  test("creates a null-owned child through the ephemeral endpoint", async () => {
    let requestBody: Record<string, unknown> | undefined;
    let requestPath: string | undefined;
    let actingUserId: string | null | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestPath = new URL(request.url).pathname;
        actingUserId = request.headers.get("X-Letta-Acting-User-Id");
        requestBody = (await request.json()) as Record<string, unknown>;
        return Response.json({
          id: "conv-child",
          agent_id: null,
          parent_agent_id: "agent-parent",
          name: "Joi",
          is_subagent: true,
          model: "openai/gpt-5.6-luna",
          context_window_limit: 128_000,
        });
      },
    });
    const originalBaseUrl = process.env.LETTA_BASE_URL;
    const originalActingUserId = process.env.LETTA_ACTING_USER_ID;
    process.env.LETTA_BASE_URL = server.url.toString().replace(/\/$/, "");
    process.env.LETTA_ACTING_USER_ID = "user-parent";

    try {
      await settingsManager.initialize();
      const result = await createEphemeralConversation({
        model: "gpt-5.6-luna",
        systemPromptCustom: "isolated prompt",
        parentAgentId: "agent-parent",
        name: "Joi",
        isSubagent: true,
      });

      expect(result.conversationId).toBe("conv-child");
      expect(result.agent.id).toBe("conv-child");
      expect(result.agent.name).toBe("Joi");
      expect(requestPath).toBe("/v1/conversations/ephemeral");
      expect(actingUserId).toBe("user-parent");
      expect(requestBody).toMatchObject({
        system: "isolated prompt",
        parent_agent_id: "agent-parent",
        name: "Joi",
        is_subagent: true,
      });
    } finally {
      if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
      else process.env.LETTA_BASE_URL = originalBaseUrl;
      if (originalActingUserId === undefined)
        delete process.env.LETTA_ACTING_USER_ID;
      else process.env.LETTA_ACTING_USER_ID = originalActingUserId;
      server.stop(true);
      await settingsManager.reset();
    }
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
});
