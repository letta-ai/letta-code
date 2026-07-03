import { describe, expect, test } from "bun:test";
import {
  buildCreatedAgentTags,
  GIT_MEMORY_ENABLED_TAG,
  LETTA_CODE_ORIGIN_TAG,
  LETTA_CODE_SUBAGENT_TAG,
} from "@/agent/agent-tags";
import { resolveCreatedAgentMemfsConfig } from "@/agent/create";

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

  test("keeps explicit MemFS disable on created agents", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: remoteMemfsBackend,
        enableMemfs: false,
        isLettaCloud: true,
      }),
    ).toEqual({ enableMemfs: false, memoryPromptMode: "standard" });
  });

  test("treats standard memory prompt mode as an opt-out", () => {
    expect(
      resolveCreatedAgentMemfsConfig({
        capabilities: remoteMemfsBackend,
        requestedMemoryPromptMode: "standard",
        isLettaCloud: true,
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
