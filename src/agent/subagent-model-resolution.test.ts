import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import type { SubagentConfig } from "@/agent/subagents";
import {
  estimateStartupContextTokens,
  REFLECTION_STARTUP_CONTEXT_TOKEN_LIMIT,
} from "@/agent/subagents/context-budget";
import {
  buildSubagentArgs,
  buildSubagentPrompt,
  getModelHandleFromAgent,
  recallPromptForBackend,
  resolveSubagentLauncher,
  resolveSubagentModel,
  resolveSubagentWorkingDirectory,
} from "@/agent/subagents/manager";

describe("recallPromptForBackend", () => {
  test("uses separate API and local recall prompts", () => {
    const apiPrompt = recallPromptForBackend("api");
    const localPrompt = recallPromptForBackend("local");

    expect(apiPrompt).toContain("Semantic similarity search");
    expect(apiPrompt).not.toContain("transcript-backed exact text search");
    expect(localPrompt).toContain("transcript-backed full-text search");
    expect(localPrompt).toContain("Accessing the Underlying Files");
    expect(localPrompt).toContain("~/.letta/lc-local-backend");
    expect(localPrompt).not.toContain("--mode <mode>");
    expect(localPrompt).not.toContain("Semantic similarity search");
  });
});

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

  test("resolves relative dev entrypoint against launcher cwd", () => {
    const cwd =
      process.platform === "win32"
        ? path.win32.join("C:\\", "Users", "example", "dev", "letta-code-prod")
        : path.posix.join("/", "Users", "example", "dev", "letta-code-prod");
    const expectedScriptPath =
      process.platform === "win32"
        ? path.win32.join(cwd, "src", "index.ts")
        : path.posix.join(cwd, "src", "index.ts");
    const execPath =
      process.platform === "win32"
        ? "C:\\bun\\bun.exe"
        : "/opt/homebrew/bin/bun";

    const launcher = resolveSubagentLauncher(
      ["--output-format", "stream-json"],
      {
        env: {} as NodeJS.ProcessEnv,
        argv: ["bun", "src/index.ts"],
        execPath,
        platform: process.platform,
        cwd,
      },
    );

    expect(launcher).toEqual({
      command: execPath,
      args: [
        "--loader=.md:text",
        "--loader=.mdx:text",
        "--loader=.txt:text",
        "run",
        expectedScriptPath,
        "--output-format",
        "stream-json",
      ],
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

  test("reflection subagents with the memory-subagent profile run from the inherited parent memory root", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/project-root",
      } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "reflection",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot: "/Users/test/.letta/agents/agent-parent/memory",
      },
    );

    expect(cwd).toBe("/Users/test/.letta/agents/agent-parent/memory");
  });

  test("reflection subagents with memoryScope run from USER_CWD while MEMORY_DIR points at the worktree", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/project-root",
      } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "reflection",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot: "/Users/test/.letta/agents/agent-parent/memory",
        memoryScope: {
          primaryRoot:
            "/Users/test/.letta/agents/agent-parent/memory-worktrees/reflection-123",
          writableRoots: [
            "/Users/test/.letta/agents/agent-parent/memory-worktrees/reflection-123",
          ],
        },
      },
    );

    expect(cwd).toBe("/tmp/project-root");
  });

  test("non-reflection subagents still prefer USER_CWD", () => {
    const cwd = resolveSubagentWorkingDirectory(
      {
        USER_CWD: "/tmp/project-root",
      } as NodeJS.ProcessEnv,
      "/tmp/fallback-root",
      {
        subagentType: "general-purpose",
        launchProfile: "memory-subagent",
        inheritedPrimaryRoot: "/Users/test/.letta/agents/agent-parent/memory",
      },
    );

    expect(cwd).toBe("/tmp/project-root");
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
    fork: false,
    background: false,
    launchProfile: "default",
  };

  test("adds --no-memfs for newly spawned subagents by default", () => {
    const args = buildSubagentArgs("test-subagent", baseConfig, null, "hello");

    expect(args).toContain("--no-memfs");
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

  test("passes --backend local and --no-memfs for local backend subagents", () => {
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

  test("injects --no-system-info-reminder and --no-skills for reflection subagents", () => {
    const args = buildSubagentArgs(
      "reflection",
      { ...baseConfig, name: "reflection" },
      null,
      "hello",
    );

    expect(args).toContain("--no-system-info-reminder");
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

describe("getModelHandleFromAgent", () => {
  test("prefers top-level provider-qualified model handles for local backend agents", () => {
    expect(
      getModelHandleFromAgent({
        model: "ollama/llama3.1:8b",
        llm_config: {
          model_endpoint_type: "openai",
          model: "ollama/llama3.1:8b",
        },
      }),
    ).toBe("ollama/llama3.1:8b");
  });

  test("reconstructs provider-qualified handles from model settings", () => {
    expect(
      getModelHandleFromAgent({
        model: "llama3.1:8b",
        model_settings: { provider_type: "ollama" },
      }),
    ).toBe("ollama/llama3.1:8b");
  });

  test("falls back to llm_config endpoint and model for server agents", () => {
    expect(
      getModelHandleFromAgent({
        llm_config: {
          model_endpoint_type: "anthropic",
          model: "claude-sonnet-4-6",
        },
      }),
    ).toBe("anthropic/claude-sonnet-4-6");
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

  test("explicit user inherit follows subagent inherit instead of literal model", async () => {
    const result = await resolveSubagentModel({
      userModel: "inherit",
      recommendedModel: "inherit",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(["lc-anthropic/parent-model"]),
    });

    expect(result).toBe("lc-anthropic/parent-model");
    expect(result).not.toBe("inherit");
  });

  test("explicit user inherit overrides subagent recommended model", async () => {
    const result = await resolveSubagentModel({
      userModel: "inherit",
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "openai/parent-model",
      availableHandles: new Set(["anthropic/test-model"]),
    });

    expect(result).toBe("openai/parent-model");
  });

  test("explicit user inherit still allows default fallback without a parent model", async () => {
    const result = await resolveSubagentModel({
      userModel: "inherit",
      recommendedModel: "inherit",
      availableHandles: new Set(["letta/auto"]),
    });

    expect(result).toBe("letta/auto");
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

  test("uses letta/auto-memory for reflection subagents by default", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      recommendedModel: "inherit",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(),
    });

    expect(result).toBe("letta/auto-memory");
  });

  test("local backend subagents inherit the active parent model", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      recommendedModel: "inherit",
      parentModelHandle: "chatgpt-plus-pro/gpt-5.5",
      backendMode: "local",
      availableHandles: new Set(),
    });

    expect(result).toBe("chatgpt-plus-pro/gpt-5.5");
  });

  test("local backend inherits parent model for non-reflection subagents", async () => {
    const result = await resolveSubagentModel({
      subagentType: "general-purpose",
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "lmstudio/local-model",
      backendMode: "local",
      availableHandles: new Set(["anthropic/test-model"]),
    });

    expect(result).toBe("lmstudio/local-model");
  });

  test("explicit user model overrides local backend parent inheritance", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      userModel: "openai/gpt-5",
      recommendedModel: "inherit",
      parentModelHandle: "lmstudio/local-model",
      backendMode: "local",
      availableHandles: new Set(["openai/gpt-5"]),
    });

    expect(result).toBe("openai/gpt-5");
  });

  test("uses letta/auto-memory for reflection subagents with no recommended model", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(),
    });

    expect(result).toBe("letta/auto-memory");
  });

  test("honors reflection subagent model overrides", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      recommendedModel: "anthropic/test-model",
      parentModelHandle: "lc-anthropic/parent-model",
      availableHandles: new Set(),
    });

    expect(result).toBe("anthropic/test-model");
  });

  test("resolves reflection subagent model aliases before honoring overrides", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      recommendedModel: "auto",
      availableHandles: new Set(["letta/auto"]),
    });

    expect(result).toBe("letta/auto");
  });

  test("does not override an explicit user model for reflection subagents", async () => {
    const result = await resolveSubagentModel({
      subagentType: "reflection",
      userModel: "openai/gpt-5",
      recommendedModel: "anthropic/test-model",
      availableHandles: new Set(["openai/gpt-5", "letta/auto-memory"]),
    });

    expect(result).toBe("openai/gpt-5");
  });

  test("does not affect non-reflection subagents", async () => {
    const result = await resolveSubagentModel({
      subagentType: "general-purpose",
      recommendedModel: "anthropic/test-model",
      availableHandles: new Set(["letta/auto", "anthropic/test-model"]),
    });

    expect(result).toBe("anthropic/test-model");
  });
});
