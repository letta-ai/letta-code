import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEphemeralConversation } from "@/agent/ephemeral-conversation";
import {
  configureBackendMode,
  configureEphemeralLocalBackend,
  getBackend,
} from "@/backend";
import { releaseToolExecutionContext } from "@/tools/manager";
import { __headlessTestUtils } from "./headless";
import {
  getHeadlessEphemeralIdentity,
  resumeHeadlessEphemeralConversation,
} from "./headless-ephemeral-startup";

describe("ephemeral headless identity", () => {
  const parentAgentId = "agent-12345678-1234-1234-1234-123456789abc";
  const env = {
    LETTA_SUBAGENT_NAME: "Reviewer",
    LETTA_CODE_AGENT_ROLE: "subagent",
    LETTA_PARENT_AGENT_ID: parentAgentId,
  };

  test("forwards the display name, subagent marker and valid agent parent", () => {
    expect(getHeadlessEphemeralIdentity(env)).toEqual({
      name: "Reviewer",
      isSubagent: true,
      parentAgentId,
    });
    expect(getHeadlessEphemeralIdentity({ AGENT_ID: parentAgentId })).toEqual({
      name: undefined,
      isSubagent: false,
    });
  });

  test.each(["conv-child", "agent-local-123", "not-an-agent", ""])(
    "does not link invalid parent %s",
    (parent) => {
      expect(
        getHeadlessEphemeralIdentity({ ...env, LETTA_PARENT_AGENT_ID: parent }),
      ).not.toHaveProperty("parentAgentId");
    },
  );

  test.each([undefined, "agent-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"])(
    "resume replaces ambient parent %s with persisted lineage",
    (ambientParent) => {
      const environment: NodeJS.ProcessEnv = {
        LETTA_PARENT_AGENT_ID: ambientParent,
      };
      const conversation = {
        id: "conv-resumed",
        agent_id: null,
        model: "openai/gpt-5.6-luna",
        parent_agent_id: parentAgentId,
      };
      const resumed = resumeHeadlessEphemeralConversation(
        conversation,
        false,
        environment,
      );
      expect(resumed.parentAgentId).toBe(parentAgentId);
      expect(environment.LETTA_PARENT_AGENT_ID).toBe(parentAgentId);
      expect(resumed.agent.id).toBe(conversation.id);
      const parentless = resumeHeadlessEphemeralConversation(
        { ...conversation, parent_agent_id: null },
        false,
        environment,
      );
      expect(parentless.parentAgentId).toBeUndefined();
      expect(environment.LETTA_PARENT_AGENT_ID).toBeUndefined();
    },
  );

  test("memory workers retain their resource parent", () => {
    expect(
      getHeadlessEphemeralIdentity({
        ...env,
        LETTA_SUBAGENT_LAUNCH_PROFILE: "memory-subagent",
      }),
    ).toEqual({
      name: "Reviewer",
      isSubagent: true,
      parentAgentId,
    });
  });
});

const REPRESENTATIVE_MODELS = [
  "openai/gpt-5.6-luna",
  "anthropic/claude-sonnet-4-6",
  "google_ai/gemini-3.6-flash",
];

describe("ephemeral headless toolset selection", () => {
  let storageDir: string;
  let originalStorageDir: string | undefined;

  beforeEach(() => {
    storageDir = mkdtempSync(join(tmpdir(), "letta-ephemeral-toolset-"));
    originalStorageDir = process.env.LETTA_LOCAL_BACKEND_DIR;
    process.env.LETTA_LOCAL_BACKEND_DIR = storageDir;
    configureBackendMode("local");
    configureEphemeralLocalBackend();
  });

  afterEach(() => {
    configureBackendMode("api");
    if (originalStorageDir === undefined) {
      delete process.env.LETTA_LOCAL_BACKEND_DIR;
    } else {
      process.env.LETTA_LOCAL_BACKEND_DIR = originalStorageDir;
    }
    rmSync(storageDir, { recursive: true, force: true });
  });

  for (const model of REPRESENTATIVE_MODELS) {
    test(`matches an agent-backed conversation for ${model}`, async () => {
      const backend = getBackend();
      const ephemeral = await createLocalEphemeralConversation({
        model,
        systemPromptCustom: "ephemeral toolset test",
      });
      const agent = await backend.createAgent({
        agent_type: "letta_v1_agent",
        name: "Agent-backed toolset test",
        model,
        system: "agent-backed toolset test",
        memory_blocks: [],
        tags: [],
        tools: [],
        include_base_tools: false,
        include_base_tool_rules: false,
        initial_message_sequence: [],
        parallel_tool_calls: true,
      });
      const conversation = await backend.createConversation({
        agent_id: agent.id,
        model,
      });

      const ephemeralPrepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: ephemeral.agent.id,
          conversationId: ephemeral.conversationId,
          cachedAgent: ephemeral.agent,
        });
      const agentPrepared =
        await __headlessTestUtils.prepareHeadlessToolExecutionContext({
          agentId: agent.id,
          conversationId: conversation.id,
          cachedAgent: agent,
        });

      try {
        expect(ephemeralPrepared.preparedToolContext.effectiveModel).toBe(
          model,
        );
        expect(ephemeralPrepared.preparedToolContext.toolset).toBe(
          agentPrepared.preparedToolContext.toolset,
        );
        expect(ephemeralPrepared.availableTools).toEqual(
          agentPrepared.availableTools,
        );
      } finally {
        releaseToolExecutionContext(
          ephemeralPrepared.preparedToolContext.preparedToolContext.contextId,
        );
        releaseToolExecutionContext(
          agentPrepared.preparedToolContext.preparedToolContext.contextId,
        );
      }
    });
  }
});
