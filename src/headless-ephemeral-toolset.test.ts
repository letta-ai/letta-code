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
