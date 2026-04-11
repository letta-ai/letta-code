import { describe, expect, test } from "bun:test";
import type { SubagentConfig } from "../../agent/subagents";
import {
  buildSubagentArgs,
  buildSubagentChildEnv,
  getTaskBudgetFromEnv,
  getTaskDepthFromEnv,
  getTaskMaxDepthFromEnv,
  resolveSubagentLauncher,
  resolveSubagentModel,
  resolveSubagentWorkingDirectory,
} from "../../agent/subagents/manager";

describe("resolveSubagentLauncher", () => {
  test("explicit launcher takes precedence over .ts script autodetection", () => {
    const launcher = resolveSubagentLauncher(["-p", "hi"], {
      env: {
        LETTA_CODE_BIN: "custom-bun",
        LETTA_CODE_BIN_ARGS_JSON: JSON.stringify(["run", "src/index.ts"]),
      } as NodeJS.ProcessEnv,
      argv: ["bun", "/tmp/dev-entry.ts"],
      execPath: "/opt/homebrew/bin/bun",
      platform: "darwin",
    });

    expect(launcher).toEqual({
      command: "custom-bun",
      args: ["run", "src/index.ts", "-p", "hi"],
    });
  });

  test("explicit launcher takes precedence over .js script autodetection", () => {
    const launcher = resolveSubagentLauncher(["-p", "hi"], {
      env: {
        LETTA_CODE_BIN: "custom-node",
      } as NodeJS.ProcessEnv,
      argv: ["node", "/tmp/letta.js"],
      execPath: "/usr/local/bin/node",
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "custom-node",
      args: ["-p", "hi"],
    });
  });

  test("preserves existing .ts dev behavior for any ts entrypoint", () => {
    const launcher = resolveSubagentLauncher(
      ["--output-format", "stream-json"],
      {
        env: {} as NodeJS.ProcessEnv,
        argv: ["bun", "/tmp/custom-runner.ts"],
        execPath: "/opt/homebrew/bin/bun",
        platform: "darwin",
      },
    );

    expect(launcher).toEqual({
      command: "/opt/homebrew/bin/bun",
      args: ["/tmp/custom-runner.ts", "--output-format", "stream-json"],
    });
  });

  test("uses node runtime for bundled js on win32", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", "C:\\Program Files\\Letta\\letta.js"],
      execPath: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });

    expect(launcher).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: ["C:\\Program Files\\Letta\\letta.js", "-p", "prompt"],
    });
  });

  test("keeps direct js spawn behavior on non-win32", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", "/usr/local/lib/letta.js"],
      execPath: "/usr/local/bin/node",
      platform: "linux",
    });

    expect(launcher).toEqual({
      command: "/usr/local/lib/letta.js",
      args: ["-p", "prompt"],
    });
  });

  test("falls back to global letta when no launcher hints available", () => {
    const launcher = resolveSubagentLauncher(["-p", "prompt"], {
      env: {} as NodeJS.ProcessEnv,
      argv: ["node", ""],
      execPath: "/usr/local/bin/node",
      platform: "linux",
    });

    expect(launcher).toEqual({
      command: "letta",
      args: ["-p", "prompt"],
    });
  });

  test("keeps explicit launcher with spaces as a single command token", () => {
    const launcher = resolveSubagentLauncher(
      ["--output-format", "stream-json"],
      {
        env: {
          LETTA_CODE_BIN:
            '"C:\\Users\\Example User\\AppData\\Roaming\\npm\\letta.cmd"',
        } as NodeJS.ProcessEnv,
        argv: ["node", "C:\\Program Files\\Letta\\letta.js"],
        execPath: "C:\\Program Files\\nodejs\\node.exe",
        platform: "win32",
      },
    );

    expect(launcher).toEqual({
      command: "C:\\Users\\Example User\\AppData\\Roaming\\npm\\letta.cmd",
      args: ["--output-format", "stream-json"],
    });
  });
});

describe("resolveSubagentWorkingDirectory", () => {
  test("prefers USER_CWD when present", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/fixture-dir",
      } as NodeJS.ProcessEnv,
      "/tmp/repo-root",
    );

    expect(cwd).toBe("/tmp/fixture-dir");
  });

  test("falls back to process cwd when USER_CWD is absent", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {} as NodeJS.ProcessEnv,
      "/tmp/repo-root",
    );

    expect(cwd).toBe("/tmp/repo-root");
  });
});

describe("buildSubagentArgs", () => {
  const baseConfig: SubagentConfig = {
    name: "test-subagent",
    description: "test",
    systemPrompt: "test prompt",
    allowedTools: "all",
    recommendedModel: "inherit",
    skills: [],
    memoryBlocks: "none",
    mode: "stateful",
    fork: false,
    background: false,
  };

  test("adds --no-memfs for newly spawned subagents by default", () => {
    const args = buildSubagentArgs("test-subagent", baseConfig, null, "hello");

    expect(args).toContain("--init-blocks");
    expect(args).toContain("none");
    expect(args).toContain("--no-memfs");
  });

  test("does not force --no-memfs when deploying an existing subagent agent", () => {
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

  test("passes memory permission mode through when configured", () => {
    const args = buildSubagentArgs(
      "test-subagent",
      {
        ...baseConfig,
        permissionMode: "memory",
      },
      null,
      "hello",
    );

    expect(args).toContain("--permission-mode");
    expect(args).toContain("memory");
  });

  test("buildSubagentChildEnv increments depth and inherits depth limit", () => {
    const childEnv = buildSubagentChildEnv(
      {
        LETTA_TASK_DEPTH: "2",
        LETTA_TASK_MAX_DEPTH: "7",
      } as NodeJS.ProcessEnv,
      {
        config: baseConfig,
      },
    );

    expect(getTaskDepthFromEnv(childEnv)).toBe(3);
    expect(getTaskMaxDepthFromEnv(childEnv)).toBe(7);
  });

  test("buildSubagentChildEnv inherits advisory budget by default", () => {
    const childEnv = buildSubagentChildEnv(
      {
        LETTA_TASK_BUDGET_TOKENS: "1200",
      } as NodeJS.ProcessEnv,
      {
        config: baseConfig,
      },
    );

    expect(getTaskBudgetFromEnv(childEnv)).toBe(1200);
  });

  test("buildSubagentChildEnv allows explicit advisory budget override", () => {
    const childEnv = buildSubagentChildEnv(
      {
        LETTA_TASK_BUDGET_TOKENS: "1200",
      } as NodeJS.ProcessEnv,
      {
        config: baseConfig,
        budgetTokens: 300,
      },
    );

    expect(getTaskBudgetFromEnv(childEnv)).toBe(300);
  });
});

describe("resolveSubagentModel", () => {
  test("prefers BYOK-swapped handle when available", async () => {
    const cases = [
      { parentProvider: "lc-anthropic", baseProvider: "anthropic" },
      { parentProvider: "lc-openai", baseProvider: "openai" },
      { parentProvider: "lc-zai", baseProvider: "zai" },
      { parentProvider: "lc-gemini", baseProvider: "google_ai" },
      { parentProvider: "lc-openrouter", baseProvider: "openrouter" },
      { parentProvider: "lc-minimax", baseProvider: "minimax" },
      { parentProvider: "lc-bedrock", baseProvider: "bedrock" },
      { parentProvider: "chatgpt-plus-pro", baseProvider: "chatgpt-plus-pro" },
    ];

    for (const { parentProvider, baseProvider } of cases) {
      const recommendedHandle = `${baseProvider}/test-model`;
      const swappedHandle = `${parentProvider}/test-model`;
      const parentHandle = `${parentProvider}/parent-model`;

      const result = await resolveSubagentModel({
        recommendedModel: recommendedHandle,
        parentModelHandle: parentHandle,
        availableHandles: new Set([recommendedHandle, swappedHandle]),
      });

      expect(result).toBe(swappedHandle);
    }
  });

  test("falls back to parent model when recommended is unavailable", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(),
    });

    expect(result).toBe("lc-anthropic/parent-model");
  });

  test("BYOK parent ignores base-provider recommended when swap is unavailable", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(["anthropic/test-model"]),
    });

    expect(result).toBe("lc-anthropic/parent-model");
  });

  test("BYOK parent accepts recommended handle when already using same BYOK prefix", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "lc-anthropic/test-model",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(["lc-anthropic/test-model"]),
    });

    expect(result).toBe("lc-anthropic/test-model");
  });

  test("uses recommended model when parent is not BYOK and model is available", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "anthropic/parent-model",
      availableHandles: new Set(["anthropic/test-model"]),
    });

    expect(result).toBe("anthropic/test-model");
  });

  test("explicit user model overrides all other resolution", async () => {
    const result = await resolveSubagentModel({
      userModel: "lc-openrouter/custom-model",
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(["lc-anthropic/test-model"]),
    });

    expect(result).toBe("lc-openrouter/custom-model");
  });

  test("inherits parent when recommended is inherit", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "inherit",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(["lc-anthropic/parent-model"]),
    });

    expect(result).toBe("lc-anthropic/parent-model");
  });

  test("uses auto default when available", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "sonnet-4.5",
      availableHandles: new Set(["letta/auto", "anthropic/test-model"]),
    });

    expect(result).toBe("letta/auto");
  });

  test("uses auto-fast default for free tier when available", async () => {
    const result = await resolveSubagentModel({
      billingTier: "free",
      availableHandles: new Set(["letta/auto-fast", "letta/auto"]),
    });

    expect(result).toBe("letta/auto-fast");
  });

  test("free tier falls back to auto when auto-fast is unavailable", async () => {
    const result = await resolveSubagentModel({
      billingTier: "free",
      availableHandles: new Set(["letta/auto"]),
    });

    expect(result).toBe("letta/auto");
  });

  test("falls back when auto is unavailable", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "anthropic/test-model",
      availableHandles: new Set(["anthropic/test-model"]),
    });

    expect(result).toBe("anthropic/test-model");
  });

  test("keeps inherit behavior when auto is unavailable", async () => {
    const result = await resolveSubagentModel({
      recommendedModel: "inherit",
      parentModelHandle: "openai/gpt-5",
      availableHandles: new Set(["openai/gpt-5"]),
    });

    expect(result).toBe("openai/gpt-5");
  });

  test("user-provided model still overrides default auto", async () => {
    const result = await resolveSubagentModel({
      userModel: "openai/gpt-5",
      recommendedModel: "sonnet-4.5",
      availableHandles: new Set(["letta/auto", "openai/gpt-5"]),
    });

    expect(result).toBe("openai/gpt-5");
  });
});
