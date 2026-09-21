import { describe, expect, test } from "bun:test";
import {
  buildCreatedAgentTags,
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
  LETTA_CODE_SUBAGENT_TAG,
} from "@/agent/agent-tags";
import {
  resolveCreatedAgentMemfsConfig,
  resolveCreatedAgentSystemPrompt,
} from "@/agent/create";
import { buildSystemPrompt } from "@/agent/prompt-assets";

const remoteMemfsBackend = { localMemfs: false, remoteMemfs: true } as const;
const localMemfsBackend = { localMemfs: true, remoteMemfs: false } as const;

function countTags(tags: string[], tag: string): number {
  return tags.filter((candidate) => candidate === tag).length;
}

describe("created agent MemFS defaults", () => {
  test("defaults to remote MemFS on Letta Cloud", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: remoteMemfsBackend,
        isLettaCloud: true,
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "memfs" });
  });

  test("defaults to local MemFS on the local backend", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: localMemfsBackend,
        isLettaCloud: false,
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "local-memfs" });
  });

  test("subagents are stateless: no MemFS even on Letta Cloud", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: remoteMemfsBackend,
        isLettaCloud: true,
        isSubagent: true,
      }),
    ).toEqual({ enableMemfs: false, memoryPromptMode: "standard" });
  });

  test("ignores standard memory prompt mode for regular agents (no opt-out)", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: remoteMemfsBackend,
        requestedMemoryPromptMode: "standard",
        isLettaCloud: true,
      }),
    ).toEqual({ enableMemfs: true, memoryPromptMode: "memfs" });
  });

  test("self-hosted servers without memfs support stay standard", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: remoteMemfsBackend,
        isLettaCloud: false,
      }),
    ).toEqual({ enableMemfs: false, memoryPromptMode: "standard" });
  });
});

describe("created agent system prompt defaults", () => {
  test("delegates the default prompt to Letta Cloud", async () => {
    await expect(
      resolveCreatedAgentSystemPrompt({
        isLettaCloud: true,
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBeNull();
    await expect(
      resolveCreatedAgentSystemPrompt({
        isLettaCloud: true,
        systemPromptPreset: "default",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBeNull();
  });

  test("keeps explicit and non-Cloud prompts client-owned", async () => {
    await expect(
      resolveCreatedAgentSystemPrompt({
        isLettaCloud: true,
        systemPromptCustom: "Custom prompt",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe("Custom prompt");
    await expect(
      resolveCreatedAgentSystemPrompt({
        isLettaCloud: true,
        systemPromptCustom: "",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe("");
    await expect(
      resolveCreatedAgentSystemPrompt({
        isLettaCloud: true,
        systemPromptPreset: "letta",
        memoryPromptMode: "memfs",
      }),
    ).resolves.toBe(buildSystemPrompt("letta", "memfs"));
    await expect(
      resolveCreatedAgentSystemPrompt({
        isLettaCloud: false,
        memoryPromptMode: "standard",
      }),
    ).resolves.toBe(buildSystemPrompt("default", "standard"));
  });
});

describe("created agent tags", () => {
  test("adds Letta Code origin and MemFS tags without dropping user tags", () => {
    const tags = buildCreatedAgentTags({
      tags: ["project:alpha", LETTA_CODE_ORIGIN_TAG, GIT_MEMORY_ENABLED_TAG],
      enableMemfs: true,
    });

    expect(tags).toEqual([
      LETTA_CODE_ORIGIN_TAG,
      GIT_MEMORY_ENABLED_TAG,
      "project:alpha",
    ]);
    expect(countTags(tags, LETTA_CODE_ORIGIN_TAG)).toBe(1);
    expect(countTags(tags, GIT_MEMORY_ENABLED_TAG)).toBe(1);
  });

  test("adds the subagent tag once", () => {
    const tags = buildCreatedAgentTags({
      tags: [LETTA_CODE_SUBAGENT_TAG, "purpose:review"],
      isSubagent: true,
      enableMemfs: true,
    });

    expect(tags).toEqual([
      LETTA_CODE_ORIGIN_TAG,
      LETTA_CODE_SUBAGENT_TAG,
      GIT_MEMORY_ENABLED_TAG,
      "purpose:review",
    ]);
    expect(countTags(tags, LETTA_CODE_SUBAGENT_TAG)).toBe(1);
  });

  test("does not add the MemFS tag when explicitly disabled", () => {
    const tags = buildCreatedAgentTags({
      tags: ["project:alpha"],
      enableMemfs: false,
    });

    expect(tags).toEqual([LETTA_CODE_ORIGIN_TAG, "project:alpha"]);
    expect(tags).not.toContain(GIT_MEMORY_ENABLED_TAG);
  });
});
