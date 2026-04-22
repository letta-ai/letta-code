import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";

import type { SubagentConfig } from "../../agent/subagents";

const EXPLICIT_PARENT_AGENT_ID = "agent-parent-explicit";
const DRIFTED_AGENT_ID = "agent-drifted-ambient";
let cliMemoryScope: string[] = [];

const spawnCalls: Array<{
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}> = [];

const spawnMock = mock(
  (command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    const callIndex = spawnCalls.length;
    spawnCalls.push({
      command,
      args,
      env: options?.env ?? {},
    });

    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: ReturnType<typeof mock>;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = mock(() => {});

    queueMicrotask(() => {
      proc.emit("spawn");
      if (callIndex === 0) {
        proc.stderr.emit(
          "data",
          Buffer.from(
            "Provider anthropic is not supported; supported providers: openai",
          ),
        );
        proc.emit("close", 1);
        return;
      }

      proc.stdout.emit(
        "data",
        Buffer.from(`${JSON.stringify({ type: "result", result: "ok" })}\n`),
      );
      proc.emit("close", 0);
    });

    return proc;
  },
);

const getCurrentAgentIdMock = mock(() => DRIFTED_AGENT_ID);

mock.module("node:child_process", () => ({
  spawn: spawnMock,
}));

mock.module("../../agent/context", () => ({
  getCurrentAgentId: getCurrentAgentIdMock,
}));

mock.module("../../agent/client", () => ({
  getClient: async () => ({
    agents: {
      retrieve: async () => ({
        llm_config: {
          model_endpoint_type: "openai",
          model: "gpt-4.1",
        },
      }),
    },
    get: async () => ({ billing_tier: "pro" }),
  }),
}));

mock.module("../../settings-manager", () => ({
  settingsManager: {
    getSettings: () => ({ env: {} }),
    getSettingsWithSecureTokens: async () => ({ env: {} }),
  },
}));

mock.module("../../permissions/cli", () => ({
  cliPermissions: {
    getMemoryScope: () => [...cliMemoryScope],
    getAllowedTools: () => [],
    getDisallowedTools: () => [],
    setMemoryScope: (scope: string) => {
      cliMemoryScope = scope
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
    clear: () => {
      cliMemoryScope = [];
    },
  },
}));

mock.module("../../permissions/memoryScope", () => ({
  parseScopeList: (scope?: string) => (scope ? scope.split(",") : []),
  resolveAllowedMemoryRoots: ({
    currentAgentId,
  }: {
    currentAgentId: string | null;
  }) => ({
    primaryRoot: currentAgentId ? `/mem/${currentAgentId}` : null,
  }),
}));

mock.module("../../permissions/mode", () => ({
  permissionMode: {
    getMode: () => "default",
  },
}));

mock.module("../../permissions/session", () => ({
  sessionPermissions: {
    getRules: () => ({ allow: [] }),
  },
}));

mock.module("../../tools/impl/shellEnv", () => ({
  resolveLettaInvocation: () => ({ command: "letta", args: [] }),
  resolveEntryScriptPath: (entry: string) => entry,
}));

mock.module("../../cli/helpers/subagentState.js", () => ({
  addToolCall: () => {},
  emitStreamEvent: () => {},
  updateSubagent: () => {},
}));

mock.module("../../cli/helpers/appUrls", () => ({
  buildChatUrl: () => "app://subagent",
}));

const reflectionConfig: SubagentConfig = {
  name: "reflection",
  description: "Test reflection agent",
  systemPrompt: "Reflect",
  allowedTools: [],
  recommendedModel: "inherit",
  skills: [],
  memoryBlocks: "all",
  mode: "stateful",
  fork: false,
  background: true,
  permissionMode: "memory",
};

mock.module("../../agent/subagents", () => ({
  getAllSubagentConfigs: async () => ({
    reflection: reflectionConfig,
  }),
}));

const { spawnSubagent } = await import("../../agent/subagents/manager");

describe("spawnSubagent provider fallback preserves explicit parent scope", () => {
  beforeEach(() => {
    spawnCalls.length = 0;
    cliMemoryScope = [];
    spawnMock.mockClear();
    getCurrentAgentIdMock.mockClear();
  });

  afterEach(() => {
    spawnCalls.length = 0;
    cliMemoryScope = [];
  });

  test("retry child keeps explicit parent scope instead of drifting to ambient context", async () => {
    const result = await spawnSubagent(
      "reflection",
      "Reflect on the parent agent",
      "anthropic/claude-sonnet-4-5",
      "subagent-test-1",
      undefined,
      undefined,
      undefined,
      undefined,
      false,
      EXPLICIT_PARENT_AGENT_ID,
    );

    expect(result.success).toBe(true);
    expect(result.report).toBe("ok");
    expect(spawnMock).toHaveBeenCalledTimes(2);

    expect(spawnCalls[0]?.env.LETTA_PARENT_AGENT_ID).toBe(
      EXPLICIT_PARENT_AGENT_ID,
    );
    expect(spawnCalls[1]?.env.LETTA_PARENT_AGENT_ID).toBe(
      EXPLICIT_PARENT_AGENT_ID,
    );

    expect(
      new Set(spawnCalls[0]?.env.LETTA_MEMORY_SCOPE?.split(",") ?? []),
    ).toEqual(new Set([EXPLICIT_PARENT_AGENT_ID]));
    expect(
      new Set(spawnCalls[1]?.env.LETTA_MEMORY_SCOPE?.split(",") ?? []),
    ).toEqual(new Set([EXPLICIT_PARENT_AGENT_ID]));

    expect(spawnCalls[0]?.env.MEMORY_DIR).toBe(
      `/mem/${EXPLICIT_PARENT_AGENT_ID}`,
    );
    expect(spawnCalls[1]?.env.MEMORY_DIR).toBe(
      `/mem/${EXPLICIT_PARENT_AGENT_ID}`,
    );
  });
});
