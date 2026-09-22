import { describe, expect, test } from "bun:test";
import type { SubagentConfig } from "@/agent/subagents";
import {
  buildSubagentPrompt,
  estimateStartupContextTokens,
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
} from "@/agent/subagents/context-budget";
import { buildSubagentArgs } from "@/agent/subagents/subagent-args";

describe("buildSubagentArgs", () => {
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

  test("does not pass --no-memfs (statelessness derives from subagent role env)", () => {
    const args = buildSubagentArgs("test-subagent", baseConfig, null, "hello");

    expect(args).not.toContain("--no-memfs");
    expect(args).toContain("--new-agent");
  });

  test("tags new subagents with type and combines parent into one --tags value", () => {
    const args = buildSubagentArgs(
      "explore",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { parentAgentId: "agent-parent-123" },
    );

    const tagFlagCount = args.filter((a) => a === "--tags").length;
    expect(tagFlagCount).toBe(1);
    const tagsValue = args[args.indexOf("--tags") + 1];
    expect(tagsValue).toBe("type:explore,parent:agent-parent-123");
  });

  test("omits parent tag when no parentAgentId is provided", () => {
    const args = buildSubagentArgs("explore", baseConfig, null, "hello");

    const tagsValue = args[args.indexOf("--tags") + 1];
    expect(tagsValue).toBe("type:explore");
  });

  test("threads the computer selector through as --computer", () => {
    const args = buildSubagentArgs(
      "explore",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { environment: "office-mac" },
    );

    expect(args[args.indexOf("--computer") + 1]).toBe("office-mac");
    // The child submits and exits; the parent follows the remote turn.
    expect(args).toContain("--no-wait");
  });

  test("passes an explicit reasoning effort as --reasoning-effort", () => {
    const args = buildSubagentArgs(
      "explore",
      baseConfig,
      "sonnet-5",
      "hello",
      undefined,
      undefined,
      undefined,
      { reasoningEffort: "low" },
    );

    expect(args[args.indexOf("--model") + 1]).toBe("sonnet-5");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("low");
  });

  test("passes a reasoning effort chosen without a model", () => {
    const args = buildSubagentArgs(
      "explore",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { reasoningEffort: "high" },
    );

    expect(args).not.toContain("--model");
    expect(args[args.indexOf("--reasoning-effort") + 1]).toBe("high");
  });

  test("omits --reasoning-effort when deploying an existing agent", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "hello",
      "agent-existing-123",
      undefined,
      undefined,
      { reasoningEffort: "low" },
    );

    expect(args).toContain("--agent");
    expect(args).not.toContain("--reasoning-effort");
  });

  test("omits --reasoning-effort when none was requested", () => {
    const args = buildSubagentArgs("explore", baseConfig, "sonnet-5", "hello");

    expect(args).not.toContain("--reasoning-effort");
  });

  test("omits --computer and --no-wait by default", () => {
    const args = buildSubagentArgs("explore", baseConfig, null, "hello");

    expect(args).not.toContain("--computer");
    expect(args).not.toContain("--no-wait");
  });

  test("does not tag when deploying an existing agent (fork/recall)", () => {
    const args = buildSubagentArgs(
      "fork",
      baseConfig,
      null,
      "hello",
      "agent-existing",
      undefined,
      undefined,
      { parentAgentId: "agent-parent-123" },
    );

    expect(args).not.toContain("--tags");
  });

  test("passes --backend local for local backend subagents", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      baseConfig,
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { backendMode: "local" },
    );

    expect(args).toContain("--backend");
    expect(args).toContain("local");
    expect(args).not.toContain("--no-memfs");
  });

  test("deploys existing subagent agents without --new-agent (keeps memfs)", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      baseConfig,
      null,
      "hello",
      "agent-existing",
    );

    expect(args).toContain("--agent");
    expect(args).not.toContain("--new-agent");
    expect(args).not.toContain("--no-memfs");
  });

  test("subagents always use unrestricted permission mode", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      {
        ...baseConfig,
        launchProfile: "memory-subagent",
      },
      null,
      "hello",
    );

    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("unrestricted");
  });

  test("caps reflection system prompt plus initial message to startup budget", () => {
    const systemPrompt = "system ".repeat(1_000);
    const memoryPreview = `<parent_memory>\n<memory_filesystem>\n/memory/\n└── system/\n</memory_filesystem>\n${"memory ".repeat(40_000)}\n</parent_memory>`;
    const userPrompt = `Review transcript at /tmp/payload.json\n\n${memoryPreview}`;

    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection", systemPrompt },
      null,
      userPrompt,
    );
    const promptArg = args[args.indexOf("-p") + 1] ?? "";

    expect(
      estimateStartupContextTokens(`${systemPrompt}\n${promptArg}`),
    ).toBeLessThanOrEqual(REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT);
    expect(promptArg).toContain("Review transcript at /tmp/payload.json");
    expect(promptArg).toContain("<parent_memory>");
    expect(promptArg).toContain("<memory_filesystem>");
    expect(promptArg).toContain("Reflection startup context truncated");
    expect(promptArg.length).toBeLessThan(userPrompt.length);
  });

  test("can pass subagent prompt by stdin without leaking prompt text into argv", () => {
    const longPrompt = "prompt ".repeat(40_000);

    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      longPrompt,
      undefined,
      undefined,
      undefined,
      { promptTransport: "stdin" },
    );

    expect(args).not.toContain("--prompt-file");
    expect(args).not.toContain("-p");
    expect(args).not.toContain(longPrompt);
  });

  test("buildSubagentPrompt preserves reflection startup budget before stdin transport", () => {
    const systemPrompt = "system ".repeat(1_000);
    const memoryPreview = `<parent_memory>\n<memory_filesystem>\n/memory/\n└── system/\n</memory_filesystem>\n${"memory ".repeat(40_000)}\n</parent_memory>`;
    const userPrompt = `Review transcript via $TRANSCRIPT_PATH\n\n${memoryPreview}`;

    const prompt = buildSubagentPrompt(
      "reflection",
      { ...baseConfig, name: "reflection", systemPrompt },
      userPrompt,
    );

    expect(
      estimateStartupContextTokens(`${systemPrompt}\n${prompt}`),
    ).toBeLessThanOrEqual(REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT);
    expect(prompt).toContain("Review transcript via $TRANSCRIPT_PATH");
    expect(prompt).toContain("Reflection startup context truncated");
  });

  test("does not cap non-reflection initial messages", () => {
    const longPrompt = "prompt ".repeat(40_000);
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      longPrompt,
    );
    const promptArg = args[args.indexOf("-p") + 1] ?? "";

    expect(promptArg).toBe(longPrompt);
  });

  test("injects --no-system-info-reminder and --no-skills for non-Windows reflection subagents", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { platform: "linux" },
    );

    expect(args).toContain("--no-system-info-reminder");
    expect(args).toContain("--no-skills");
  });

  test("keeps the Windows environment reminder for reflection subagents", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { platform: "win32" },
    );

    expect(args).not.toContain("--no-system-info-reminder");
    expect(args).toContain("--no-skills");
  });

  test("does not inject reflection-only flags for other subagent types", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "hello",
    );

    expect(args).not.toContain("--no-system-info-reminder");
    expect(args).not.toContain("--no-skills");
  });

  test("does not inject reflection-only flags when deploying an existing reflection agent", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      "agent-existing-reflection",
    );

    expect(args).not.toContain("--no-system-info-reminder");
    expect(args).not.toContain("--no-skills");
  });

  test.each([["reflection"], ["memory"], ["history-analyzer"], ["init"]])(
    "injects --base-tools none for %s subagents",
    (type) => {
      const args = buildSubagentArgs(
        type,
        { ...baseConfig, name: type },
        null,
        "hello",
      );

      const idx = args.indexOf("--base-tools");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(args[idx + 1]).toBe("none");
    },
  );

  test("does not inject --base-tools for general-purpose subagents", () => {
    const args = buildSubagentArgs(
      "general-purpose",
      baseConfig,
      null,
      "hello",
    );

    expect(args).not.toContain("--base-tools");
  });

  test("does not inject --base-tools when deploying an existing reflection agent", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
      "agent-existing-reflection",
    );

    // --base-tools requires --new and only applies to fresh agent creation.
    expect(args).not.toContain("--base-tools");
  });
  test("adds MessageChannel to fork subagent scoped tools when inheriting a channel tool context", () => {
    const args = buildSubagentArgs(
      "fork",
      {
        ...baseConfig,
        name: "fork",
        fork: true,
        allowedTools: ["Bash", "Read"],
      },
      null,
      "hello",
      undefined,
      undefined,
      undefined,
      { extraTools: ["MessageChannel"] },
    );

    const idx = args.indexOf("--tools");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]?.split(",")).toEqual([
      "Bash",
      "Read",
      "MessageChannel",
    ]);
  });
});
