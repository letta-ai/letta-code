import { describe, expect, test } from "bun:test";
import {
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
  ONBOARDING_ORIGIN_TAG,
} from "@/agent/agent-tags";
import {
  buildCreateAgentRequest,
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

describe("buildCreateAgentRequest", () => {
  test("owns the complete default creation policy without a personality", async () => {
    const request = await buildCreateAgentRequest({
      model: "openai/gpt-5.2",
      memoryBlocks: [
        { label: "persona", value: "You are Ezra." },
        { label: "human", value: "The human reads the docs." },
      ],
    });

    expect(request).toMatchObject({
      agent_type: LETTA_CODE_AGENT_TYPE,
      model: "openai/gpt-5.2",
      system: buildSystemPrompt("default", "memfs"),
      memory_blocks: [
        { label: "persona", value: "You are Ezra." },
        { label: "human", value: "The human reads the docs." },
      ],
      tags: [LETTA_CODE_ORIGIN_TAG, GIT_MEMORY_ENABLED_TAG],
      tools: DEFAULT_CREATED_AGENT_BASE_TOOLS,
      include_base_tools: false,
      include_base_tool_rules: false,
      initial_message_sequence: [],
      parallel_tool_calls: true,
      compaction_settings: { model: "letta/auto" },
    });
    expect(request).not.toHaveProperty("name");
    expect(request).not.toHaveProperty("description");
  });

  test("merges caller identity into a personality by block label", async () => {
    const request = await buildCreateAgentRequest({
      personalityId: "memo",
      memoryBlocks: [
        { label: "persona", value: "Custom persona" },
        { label: "project", value: "Custom project" },
      ],
    });

    expect(request.memory_blocks?.map((block) => block.label)).toEqual([
      "persona",
      "human",
      "project",
    ]);
    expect(
      request.memory_blocks?.find((block) => block.label === "persona")?.value,
    ).toBe("Custom persona");
    expect(
      request.memory_blocks?.find((block) => block.label === "project")?.value,
    ).toBe("Custom project");
  });

  test("forces subagents onto hidden, stateless standard memory", async () => {
    const request = await buildCreateAgentRequest({
      isSubagent: true,
      memoryPromptMode: "memfs",
      enableMemfs: true,
      memoryBlocks: [{ label: "persona", value: "Stateful" }],
      blockIds: ["block-shared"],
      hidden: false,
    });

    expect(request.system).toBe(buildSystemPrompt("default", "standard"));
    expect(request.tags).toEqual([LETTA_CODE_ORIGIN_TAG, "role:subagent"]);
    expect(request.tags).not.toContain(GIT_MEMORY_ENABLED_TAG);
    expect(request.hidden).toBe(true);
    expect(request).not.toHaveProperty("memory_blocks");
    expect(request).not.toHaveProperty("block_ids");
  });

  test("keeps MemFS tags and prompts coherent", async () => {
    const request = await buildCreateAgentRequest({ enableMemfs: false });
    expect(request.system).toBe(buildSystemPrompt("default", "standard"));
    expect(request.tags).not.toContain(GIT_MEMORY_ENABLED_TAG);

    await expect(
      buildCreateAgentRequest({
        enableMemfs: false,
        memoryPromptMode: "memfs",
      }),
    ).rejects.toThrow("must describe the same memory mode");
  });

  test("pins exact caller overrides without restoring server defaults", async () => {
    const request = await buildCreateAgentRequest({
      name: "Worker",
      model: "custom/self-hosted-model",
      system: "Custom prompt",
      memoryPromptMode: "standard",
      memoryBlocks: [],
      blockIds: ["block-1"],
      extraTags: ["role:worker"],
      enableMemfs: false,
      baseTools: [],
      hidden: true,
      parallelToolCalls: false,
      compactionModel: "custom/summarizer",
    });

    expect(request).toMatchObject({
      name: "Worker",
      model: "custom/self-hosted-model",
      system: "Custom prompt",
      memory_blocks: [],
      block_ids: ["block-1"],
      tags: [LETTA_CODE_ORIGIN_TAG, "role:worker"],
      tools: [],
      include_base_tools: false,
      include_base_tool_rules: false,
      hidden: true,
      parallel_tool_calls: false,
      compaction_settings: { model: "custom/summarizer" },
    });
  });
});

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
