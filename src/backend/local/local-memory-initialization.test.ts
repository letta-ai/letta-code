import { afterEach, describe, expect, test } from "bun:test";
import { initialMemoryFilesFromCreateBody } from "./local-memory-initialization";

const originalAgentMemory = process.env.LETTA_LOCAL_AGENT_MEMORY;

afterEach(() => {
  if (originalAgentMemory === undefined)
    delete process.env.LETTA_LOCAL_AGENT_MEMORY;
  else process.env.LETTA_LOCAL_AGENT_MEMORY = originalAgentMemory;
});

describe("local memory initialization", () => {
  test("builds root plain files for Agent Memory", () => {
    process.env.LETTA_LOCAL_AGENT_MEMORY = "1";

    expect(
      initialMemoryFilesFromCreateBody({
        memory_blocks: [
          { label: "persona", value: "Root persona." },
          { label: "system/human/profile", value: "Root human." },
        ],
      } as never),
    ).toEqual([
      expect.objectContaining({
        relativePath: "human_profile.md",
        content: "Root human.",
      }),
      expect.objectContaining({ relativePath: "MEMORY.md" }),
      expect.objectContaining({
        relativePath: "persona.md",
        content: "Root persona.",
      }),
    ]);
  });

  test("preserves legacy system paths and frontmatter when disabled", () => {
    delete process.env.LETTA_LOCAL_AGENT_MEMORY;

    expect(
      initialMemoryFilesFromCreateBody({
        memory_blocks: [{ label: "persona", value: "Legacy persona." }],
      } as never),
    ).toEqual([
      {
        relativePath: "system/persona.md",
        content: "---\ndescription: Memory block persona\n---\nLegacy persona.",
      },
    ]);
  });
});
