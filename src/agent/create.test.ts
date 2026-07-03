import { describe, expect, test } from "bun:test";
import {
  buildCreatedAgentTags,
  resolveCreatedAgentMemfsConfig,
} from "@/agent/create";
import { GIT_MEMORY_ENABLED_TAG } from "@/agent/memory-git";
import {
  LETTA_CODE_ORIGIN_TAG,
  LETTA_CODE_SUBAGENT_TAG,
} from "@/agent/system-prompt-versioning";

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
