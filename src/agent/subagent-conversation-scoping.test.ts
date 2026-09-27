import { describe, expect, test } from "bun:test";
import type { SubagentConfig } from "@/agent/subagents";
import { buildSubagentArgs } from "@/agent/subagents/manager";

describe("buildSubagentArgs conversation scoping", () => {
  const baseConfig: SubagentConfig = {
    name: "test-subagent",
    description: "test",
    systemPrompt: "test prompt",
    allowedTools: "all",
    recommendedModel: "inherit",
    skills: [],
    fork: false,
    launchProfile: "default",
  };

  test("preserves agent scope when resuming the default conversation", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "synthetic task",
      "agent-synthetic",
      "default",
      3,
    );
    expect(args[args.indexOf("--agent") + 1]).toBe("agent-synthetic");
    expect(args[args.indexOf("--conv") + 1]).toBe("default");
    expect(args).not.toContain("--new");
    expect(args).not.toContain("--new-agent");
  });

  test("concrete conversation resumes still derive their agent", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "synthetic task",
      "agent-synthetic",
      "conv-synthetic",
      3,
    );
    expect(args[args.indexOf("--conv") + 1]).toBe("conv-synthetic");
    expect(args).not.toContain("--agent");
  });
});
