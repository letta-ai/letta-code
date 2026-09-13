import { describe, expect, test } from "bun:test";
import {
  buildReflectionIntegrationConversationTitle,
  buildReflectionIntegrationPrompt,
} from "@/cli/helpers/reflection-integration";

describe("reflection integration", () => {
  test("titles the conversation with the source reflection agent", () => {
    expect(
      buildReflectionIntegrationConversationTitle("agent-reflection-123"),
    ).toBe("Reflection integration (reflection agent-reflection-123)");
    expect(buildReflectionIntegrationConversationTitle()).toBe(
      "Reflection integration",
    );
  });

  test("includes worktree metadata and optional instructions", () => {
    const prompt = buildReflectionIntegrationPrompt({
      worktree: {
        id: "review-1",
        worktreeDir: "/tmp/memory-worktrees/reflection-review-1",
        parentMemoryDir: "/tmp/memory",
        worktreeBaseDir: "/tmp/memory-worktrees",
        branchName: "letta/reflection/review-1",
        baseHead: "base-sha",
        gitCommonDir: "/tmp/memory/.git",
      },
      instructions: "Preserve the user's exact wording.",
      reflectionSubagentId: "agent-reflection-123",
    });

    expect(prompt).toContain("/tmp/memory-worktrees/reflection-review-1");
    expect(prompt).toContain("Preserve the user's exact wording.");
    expect(prompt).toContain(
      "## IMPORTANT: Additional reflection merge instructions from the user",
    );
    expect(prompt).toContain("<reflection-merge-instructions>");
    expect(prompt).toContain("merge(reflection): <concise summary>");
    expect(prompt).toContain("Reflection-Subagent-ID: agent-reflection-123");
    expect(prompt).toContain("Merge the completed reflection branch");
    expect(prompt).toContain("provide a concise normal summary");
    expect(prompt).not.toContain("reflection-merge-decision");
  });
});
