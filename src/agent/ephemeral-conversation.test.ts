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
import { resolveSubagentSecretEnv } from "@/agent/subagents/subagent-launcher";
import { configureBackendMode, getBackend } from "@/backend";
import { createHeadlessEphemeralConversation } from "@/headless-ephemeral-startup";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { setupRuntimeModelCatalogFixture } from "@/test-utils/runtime-model-catalog";
import { resolveExternalTaskParentAgentId } from "@/tools/impl/task";
import {
  executeTool,
  prepareToolExecutionContextForSpecificTools,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { createTempRuntimeScriptCommand } from "@/tools/runtime-script";
import {
  clearSecretsCache,
  getVerifiedSecretOwner,
  initSecretsFromServer,
  loadSecrets,
  setSecretOnServer,
} from "@/utils/secrets-store";

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
        // apiRequest forwards the headless acting user from the environment
        // even when this caller does not add per-request headers.
        expect(actingUsers).toEqual(["user-initiator", "user-initiator"]);
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

  test("local secrets inherit only a persisted, verified parent", async () => {
    const storageDir = mkdtempSync(
      join(tmpdir(), "letta-local-parent-secrets-"),
    );
    const originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
    try {
      configureBackendMode("local");
      const backend = getBackend();
      const parent = await backend.createAgent({ name: "Parent" } as never);
      await setSecretOnServer("CHILD_TEST_SECRET", "parent-only", parent.id);
      const child = await createLocalEphemeralConversation({
        model: "openai/gpt-5.6-luna",
        systemPromptCustom: "child",
        parentAgentId: parent.id,
      });
      const unrelated = await createLocalEphemeralConversation({
        model: "openai/gpt-5.6-luna",
        systemPromptCustom: "unrelated",
      });
      await initSecretsFromServer(child.conversationId);
      await initSecretsFromServer(unrelated.conversationId);
      expect(loadSecrets(child.conversationId).CHILD_TEST_SECRET).toBe(
        "parent-only",
      );
      expect(
        loadSecrets(unrelated.conversationId).CHILD_TEST_SECRET,
      ).toBeUndefined();
      expect(getVerifiedSecretOwner(child.conversationId)).toBe(parent.id);
      expect(
        await runWithRuntimeContext(
          { agentId: null, conversationId: child.conversationId },
          () => resolveExternalTaskParentAgentId(),
        ),
      ).toBe(parent.id);
      expect(
        await runWithRuntimeContext(
          { agentId: null, conversationId: unrelated.conversationId },
          () => resolveExternalTaskParentAgentId(),
        ),
      ).toBeNull();
      const retrieveConversation = (id: string) =>
        backend.retrieveConversation(id);
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: parent.id,
          existingConversationId: child.conversationId,
          retrieveConversation,
        }),
      ).toEqual({ CHILD_TEST_SECRET: "parent-only" });
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: child.conversationId,
          existingConversationId: child.conversationId,
          retrieveConversation,
        }),
      ).toEqual({ CHILD_TEST_SECRET: "parent-only" });
      const fork = await backend.forkConversation(child.conversationId, {
        ephemeral: true,
      });
      expect(await backend.retrieveConversation(fork.id)).toMatchObject({
        agent_id: null,
        parent_agent_id: parent.id,
      });
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: child.conversationId,
          existingConversationId: fork.id,
          retrieveConversation,
        }),
      ).toEqual({ CHILD_TEST_SECRET: "parent-only" });
      // Headless startup hydrates the fork's own conversation scope before
      // dispatching its client-side tools.
      await initSecretsFromServer(fork.id);
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: unrelated.conversationId,
          retrieveConversation,
        }),
      ).toEqual({});
      expect(
        await resolveSubagentSecretEnv({
          parentAgentId: parent.id,
          existingConversationId: unrelated.conversationId,
          retrieveConversation,
        }),
      ).toEqual({});
      const script = createTempRuntimeScriptCommand(
        "process.stdout.write(process.env.CHILD_TEST_SECRET ?? 'absent')",
      );
      const runChildShell = async (conversationId: string) => {
        const context = await prepareToolExecutionContextForSpecificTools(
          ["Bash"],
          {
            runtimeContext: {
              agentId: null,
              conversationId,
              workingDirectory: storageDir,
            },
            workingDirectory: storageDir,
          },
        );
        try {
          const result = await executeTool(
            "Bash",
            { command: script.command, timeout: 5000 },
            { toolContextId: context.contextId },
          );
          return JSON.stringify(result.toolReturn);
        } finally {
          releaseToolExecutionContext(context.contextId);
        }
      };
      try {
        const first = await runChildShell(child.conversationId);
        expect(first).toContain("CHILD_TEST_SECRET=<REDACTED>");
        expect(first).not.toContain("parent-only");
        expect(await runChildShell(fork.id)).toContain(
          "CHILD_TEST_SECRET=<REDACTED>",
        );
        expect(await runChildShell(unrelated.conversationId)).toContain(
          "absent",
        );
        await setSecretOnServer(
          "CHILD_TEST_SECRET",
          "rotated-parent-only",
          parent.id,
        );
        clearSecretsCache(null);
        await initSecretsFromServer(child.conversationId);
        const resumed = await runChildShell(child.conversationId);
        expect(resumed).toContain("CHILD_TEST_SECRET=<REDACTED>");
        expect(resumed).not.toContain("rotated-parent-only");
        expect(
          await runWithRuntimeContext(
            { agentId: null, conversationId: child.conversationId },
            () => Promise.resolve(loadSecrets()),
          ),
        ).toEqual({ CHILD_TEST_SECRET: "rotated-parent-only" });
      } finally {
        script.cleanup();
      }
    } finally {
      if (originalStorageDir === undefined)
        delete process.env.LETTA_LOCAL_BACKEND_DIR;
      else process.env.LETTA_LOCAL_BACKEND_DIR = originalStorageDir;
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  test("persists local execution state without creating an agent", async () => {
    const storageDir = mkdtempSync(join(tmpdir(), "letta-local-persistent-"));
    const originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;

    try {
      configureBackendMode("local");
      const result = await createLocalEphemeralConversation({
        model: "openai/gpt-5.6-luna",
        systemPromptCustom: "isolated local prompt",
      });

      expect(result.agent.id).toBe(result.conversationId);
      expect(result.conversationId).toStartWith("local-conv-");
      const persisted = await getBackend().retrieveConversation(
        result.conversationId,
      );
      expect(persisted.agent_id).toBeNull();
      expect(projectResumedEphemeralConversation(persisted).system).toBe(
        "isolated local prompt",
      );
      expect(existsSync(join(storageDir, "agents"))).toBe(false);
      expect(existsSync(join(storageDir, "conversations"))).toBe(true);
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
