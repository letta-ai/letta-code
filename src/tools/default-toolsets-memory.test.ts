import { describe, expect, test } from "bun:test";
import {
  ANTHROPIC_DEFAULT_TOOLS,
  GEMINI_DEFAULT_TOOLS,
  GEMINI_PASCAL_TOOLS,
  OPENAI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
} from "@/tools/manager";

const DEFAULT_TOOLSETS = [
  ANTHROPIC_DEFAULT_TOOLS,
  OPENAI_DEFAULT_TOOLS,
  GEMINI_DEFAULT_TOOLS,
  OPENAI_PASCAL_TOOLS,
  GEMINI_PASCAL_TOOLS,
];

describe("default toolsets use memory subagent instead of direct memory tools", () => {
  test("do not expose direct memory mutation tools by default", () => {
    for (const tools of DEFAULT_TOOLSETS) {
      expect(tools).not.toContain("memory");
      expect(tools).not.toContain("memory_apply_patch");
    }
  });

  test("default toolsets can still launch Agent(memory)", () => {
    for (const tools of DEFAULT_TOOLSETS) {
      expect(tools).toContain("Task");
    }
  });
});
