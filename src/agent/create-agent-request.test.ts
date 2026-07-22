import { describe, expect, test } from "bun:test";
import {
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
  ONBOARDING_ORIGIN_TAG,
} from "@/agent/agent-tags";
import {
  buildCreateAgentRequestForPersonality,
  DEFAULT_CREATED_AGENT_BASE_TOOLS,
  LETTA_CODE_AGENT_TYPE,
} from "@/agent/create-agent-request";
import { resolveModel } from "@/agent/model-catalog";
import { buildCreateAgentOptionsForPersonality } from "@/agent/personality";
import {
  DEFAULT_CREATE_AGENT_PERSONALITIES,
  getPersonalityCreationTags,
  getPersonalityOption,
} from "@/agent/personality-presets";
import { buildSystemPrompt } from "@/agent/prompt-assets";

describe("buildCreateAgentRequestForPersonality", () => {
  test("matches the CLI create path for every create-agent personality", async () => {
    for (const personalityId of DEFAULT_CREATE_AGENT_PERSONALITIES) {
      const request = await buildCreateAgentRequestForPersonality({
        personalityId,
      });
      const cliOptions = await buildCreateAgentOptionsForPersonality({
        personalityId,
      });
      const personality = getPersonalityOption(personalityId);

      // Same content the CLI's createAgent() would send for this personality.
      expect(request.name).toBe(cliOptions.name as string);
      expect(request.description).toBe(cliOptions.description as string);
      expect(request.memory_blocks).toEqual(
        cliOptions.memoryBlocks as typeof request.memory_blocks,
      );
      expect(request.model).toBe(
        resolveModel(personality.defaultModel ?? "auto") as string,
      );

      // The CLI resolves the same prompt via memoryPromptMode: "memfs".
      expect(cliOptions.memoryPromptMode).toBe("memfs");
      expect(request.system).toBe(buildSystemPrompt("default", "memfs"));

      expect(request.agent_type).toBe(LETTA_CODE_AGENT_TYPE);
      expect(request.tags).toEqual([
        LETTA_CODE_ORIGIN_TAG,
        GIT_MEMORY_ENABLED_TAG,
        ...getPersonalityCreationTags(personalityId),
      ]);
      expect(cliOptions.tags).toEqual(
        getPersonalityCreationTags(personalityId),
      );
      expect(request.tools).toEqual(DEFAULT_CREATED_AGENT_BASE_TOOLS);
      expect(request.include_base_tools).toBe(false);
      expect(request.include_base_tool_rules).toBe(false);
      expect(request.initial_message_sequence).toEqual([]);
      expect(request.parallel_tool_calls).toBe(true);
      expect(request.compaction_settings).toEqual({ model: "letta/auto" });
    }
  });

  test("onboarding personalities include the cloud onboarding block", async () => {
    const request = await buildCreateAgentRequestForPersonality({
      personalityId: "tutorial",
    });
    expect(request.memory_blocks.map((block) => block.label)).toEqual([
      "persona",
      "human",
      "onboarding",
    ]);
    expect(
      request.memory_blocks.find((block) => block.label === "onboarding")
        ?.value,
    ).toContain("Offer to create one yourself.");
  });

  test("appends extra tags after the Letta Code tags", async () => {
    const request = await buildCreateAgentRequestForPersonality({
      personalityId: "memo",
      extraTags: [ONBOARDING_ORIGIN_TAG, "favorite:user:user-1"],
    });
    expect(request.tags).toEqual([
      LETTA_CODE_ORIGIN_TAG,
      GIT_MEMORY_ENABLED_TAG,
      ONBOARDING_ORIGIN_TAG,
      "favorite:user:user-1",
    ]);
  });

  test("resolves model overrides by ID or handle", async () => {
    const byId = await buildCreateAgentRequestForPersonality({
      personalityId: "memo",
      model: "auto-chat",
    });
    expect(byId.model).toBe(resolveModel("auto-chat") as string);

    const passthrough = await buildCreateAgentRequestForPersonality({
      personalityId: "memo",
      model: "custom/self-hosted-model",
    });
    expect(passthrough.model).toBe("custom/self-hosted-model");

    await expect(
      buildCreateAgentRequestForPersonality({
        personalityId: "memo",
        model: "not-a-model",
      }),
    ).rejects.toThrow("Unknown model");
  });
});
