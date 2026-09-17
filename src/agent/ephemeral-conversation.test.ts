import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEphemeralConversationCreateBody,
  createEphemeralConversation,
  createLocalEphemeralConversation,
  projectResumedEphemeralConversation,
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
    });

    expect(body.model).toBe("openai/gpt-5.6-luna");
    expect(body.system).toBe("isolated prompt");
    expect(body.context_window_limit).toBeGreaterThan(0);
    expect(body).not.toHaveProperty("agent_id");
    expect(body).not.toHaveProperty("tags");
    expect(body).not.toHaveProperty("memory_blocks");
  });

  test("projects a resumed fork without rebuilding its server-owned prompt", () => {
    const snapshot = {
      id: "conv-fork",
      agent_id: null,
      parent_agent_id: "agent-parent",
      name: "Reviewer",
      model: "openai/gpt-5.6-luna",
      model_settings: { temperature: 0.2 },
      context_window_limit: 12345,
    };
    const agent = projectResumedEphemeralConversation(snapshot);
    expect(agent.id).toBe(snapshot.id);
    expect(agent.name).toBe("Reviewer");
    expect(agent.system).toBe("");
    expect(agent.llm_config?.handle).toBe(snapshot.model);
    expect(agent.llm_config?.context_window).toBe(12345);
    expect(agent.model_settings).toEqual(snapshot.model_settings);
    expect(agent.memory.blocks).toEqual([]);
    expect(agent.tools).toEqual([]);
    expect(agent.tags).toBeUndefined();
    expect(() =>
      projectResumedEphemeralConversation({
        ...snapshot,
        agent_id: "agent-parent",
      }),
    ).toThrow();
    expect(() =>
      projectResumedEphemeralConversation({ ...snapshot, model: null }),
    ).toThrow();
  });

  test.each([200, 500])(
    "creates execution state and identity atomically with POST status %s",
    async (createStatus) => {
      const calls: Array<{
        method: string;
        path: string;
        body: Record<string, unknown> | null;
      }> = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          calls.push({
            method: request.method,
            path: new URL(request.url).pathname,
            body: (await request.json()) as Record<string, unknown>,
          });
          return Response.json(
            createStatus === 200
              ? {
                  id: "conv-test",
                  agent_id: null,
                  model: "openai/gpt-5.6-luna",
                  name: "Reviewer",
                  is_subagent: true,
                  parent_agent_id: "agent-parent",
                  context_window_limit: 12345,
                }
              : { error: "identity failed" },
            { status: createStatus },
          );
        },
      });
      const originalHome = process.env.HOME;
      const testHome = mkdtempSync(join(tmpdir(), "letta-ephemeral-api-"));
      process.env.HOME = testHome;
      const originalBaseUrl = process.env.LETTA_BASE_URL;
      process.env.LETTA_BASE_URL = server.url.toString().replace(/\/$/, "");
      try {
        await settingsManager.initialize();
        const result = createEphemeralConversation({
          model: "openai/gpt-5.6-luna",
          systemPromptCustom: "snapshot prompt",
          name: "Reviewer",
          isSubagent: true,
          parentAgentId: "agent-parent",
        });
        if (createStatus === 200) {
          const created = await result;
          expect(created.agent.id).toBe("conv-test");
          expect(created.agent.name).toBe("Reviewer");
          expect(created.agent.system).toBe("snapshot prompt");
        } else {
          await expect(result).rejects.toThrow("identity failed");
        }
        expect(calls.map((call) => call.method)).toEqual(["POST"]);
        expect(calls[0]?.path).toBe("/v1/conversations/ephemeral");
        expect(calls[0]?.body).toMatchObject({
          parent_agent_id: "agent-parent",
          system: "snapshot prompt",
          name: "Reviewer",
          is_subagent: true,
        });
      } finally {
        if (originalBaseUrl === undefined) delete process.env.LETTA_BASE_URL;
        else process.env.LETTA_BASE_URL = originalBaseUrl;
        server.stop(true);
        await settingsManager.reset();
        if (originalHome === undefined) delete process.env.HOME;
        else process.env.HOME = originalHome;
        rmSync(testHome, { recursive: true, force: true });
      }
    },
  );

  test("creates local execution state outside the persistent local store", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "letta-local-persistent-"));
    const originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    try {
      configureBackendMode("local");
      configureEphemeralLocalBackend();
      const result = await createLocalEphemeralConversation({
        model: "openai/gpt-5.6-luna",
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
