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
import { createHeadlessEphemeralConversation } from "@/headless-ephemeral-startup";
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

  test.each([false, true])(
    "fresh headless creation preserves explicit parent and initiator scope (remote=%s)",
    async (usesRemoteComputer) => {
      const keys = [
        "HOME",
        "LETTA_BASE_URL",
        "LETTA_PARENT_AGENT_ID",
        "LETTA_CODE_AGENT_ROLE",
        "LETTA_ACTING_USER_ID",
      ] as const;
      const previous = Object.fromEntries(
        keys.map((key) => [key, process.env[key]]),
      );
      const home = mkdtempSync(join(tmpdir(), "letta-parent-scope-"));
      const bodies: Record<string, unknown>[] = [];
      const actingUsers: Array<string | null> = [];
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          expect(new URL(request.url).pathname).toBe(
            "/v1/conversations/ephemeral",
          );
          const body = (await request.json()) as Record<string, unknown>;
          bodies.push(body);
          actingUsers.push(request.headers.get("X-Letta-Acting-User-Id"));
          return Response.json({ ...body, id: "conv-created", agent_id: null });
        },
      });
      try {
        process.env.HOME = home;
        process.env.LETTA_BASE_URL = server.url.toString().replace(/\/$/, "");
        process.env.LETTA_PARENT_AGENT_ID =
          "agent-11111111-1111-4111-8111-111111111111";
        process.env.LETTA_CODE_AGENT_ROLE = "subagent";
        process.env.LETTA_ACTING_USER_ID = "user-initiator";
        await settingsManager.initialize();
        for (const isAgentLaunch of [true, false]) {
          await createHeadlessEphemeralConversation({
            backendMode: "api",
            isAgentLaunch,
            usesRemoteComputer,
            personality: undefined,
            model: "openai/gpt-5.6-luna",
            systemPromptPreset: undefined,
            systemPromptCustom: "minimal prompt",
          });
        }
        expect(actingUsers).toEqual(
          usesRemoteComputer
            ? ["user-initiator", "user-initiator"]
            : [null, null],
        );
        expect(bodies.every((body) => !("requestOptions" in body))).toBe(true);
        expect(bodies[0]?.parent_agent_id).toBe(
          "agent-11111111-1111-4111-8111-111111111111",
        );
        expect(bodies[1]).not.toHaveProperty("parent_agent_id");
        expect(process.env.LETTA_PARENT_AGENT_ID).toBeUndefined();
        expect(
          bodies.every((body) => !("agent_id" in body) && !("secrets" in body)),
        ).toBe(true);
      } finally {
        server.stop(true);
        await settingsManager.reset();
        for (const key of keys) {
          if (previous[key] === undefined) delete process.env[key];
          else process.env[key] = previous[key];
        }
        rmSync(home, { recursive: true, force: true });
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
