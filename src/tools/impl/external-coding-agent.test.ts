import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  buildExternalCodingAgentCommand,
  buildExternalCodingAgentMcpReminder,
  formatExternalCodingAgentId,
  parseExternalCodingAgentId,
  parseExternalCodingAgentOutput,
  resolveExternalCodingAgentMcpReminder,
  runExternalCodingAgent as runExternalCodingAgentImpl,
  selectExternalCodingAgentMcpEntries,
  validateExternalCodingAgentMcpOptions,
} from "./external-coding-agent";
import { clearNativeSessionCaptureForTests } from "./native-session-capture";

// Existing lifecycle tests use synthetic parent IDs; keep discovery local to
// the dedicated skill tests rather than querying real attached repositories.
function runExternalCodingAgent(
  options: Parameters<typeof runExternalCodingAgentImpl>[0],
  deps: Parameters<typeof runExternalCodingAgentImpl>[1] = {},
) {
  return runExternalCodingAgentImpl(options, {
    resolveSkillsReminder: async () => undefined,
    ...deps,
  });
}

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

beforeAll(() => settingsManager.initialize());
afterEach(() => clearNativeSessionCaptureForTests());

describe("external coding agent commands", () => {
  test("builds Claude Code JSON invocation with safe root-compatible permissions", () => {
    const command = buildExternalCodingAgentCommand({
      type: "claude-code",
      prompt: "Implement it",
      model: "opus",
      mcpReminder: "MCP reminder",
      cwd: "/repo",
    });
    expect(command.executable).toBe("claude");
    expect(command.args).toContain("stream-json");
    expect(command.args).toContain("--verbose");
    expect(command.args).toContain("acceptEdits");
    expect(command.args).not.toContain("--dangerously-skip-permissions");
    expect(command.args).toContain("--append-system-prompt");
    expect(command.args).not.toContain("Implement it");
    expect(command.stdin).toBe("Implement it");
  });

  test("uses Codex app-server instead of exec resume", () => {
    const command = buildExternalCodingAgentCommand({
      type: "codex",
      prompt: "Implement it",
      model: "gpt-test",
      mcpReminder: "MCP reminder",
      cwd: "/repo",
    });
    expect(command).toEqual({
      executable: "codex",
      args: ["app-server", "--stdio"],
    });
  });

  test.each([
    ["claude-code", `claude_${SESSION_ID}`],
    ["codex", `codex_${SESSION_ID}`],
  ] as const)("builds native %s resume commands", (type, agentId) => {
    const target = parseExternalCodingAgentId(agentId);
    expect(target).not.toBeNull();
    const command = buildExternalCodingAgentCommand({
      type,
      prompt: "Continue",
      resumeSessionId: target?.sessionId,
      cwd: "/repo",
    });
    if (type === "claude-code") {
      expect(command.args).toContain("--resume");
      expect(command.args).toContain(SESSION_ID);
    } else {
      expect(command.args).toEqual(["app-server", "--stdio"]);
      expect(command.args).not.toContain("resume");
    }
  });

  test("round-trips synthetic external agent IDs", () => {
    expect(
      parseExternalCodingAgentId(
        formatExternalCodingAgentId("claude-code", "session-1"),
      ),
    ).toBeNull();
    expect(
      parseExternalCodingAgentId(
        formatExternalCodingAgentId("claude-code", SESSION_ID),
      ),
    ).toEqual({ type: "claude-code", sessionId: SESSION_ID });
    expect(parseExternalCodingAgentId("agent-real")).toBeNull();
    expect(
      parseExternalCodingAgentId(
        formatExternalCodingAgentId("claude-code", SESSION_ID, "device-1"),
      ),
    ).toEqual({
      type: "claude-code",
      sessionId: SESSION_ID,
      computer: "device-1",
    });
    expect(parseExternalCodingAgentId(`claude_not-a-uuid@device-1`)).toBeNull();
    expect(parseExternalCodingAgentId(`claude_${SESSION_ID}@`)).toBeNull();
  });
});

describe("external coding agent MCP metadata", () => {
  const inventory = [
    { name: "exa", toolCount: 2 },
    { name: "linear", toolCount: null },
  ];

  test("supports all and exact named subsets", () => {
    expect(selectExternalCodingAgentMcpEntries(inventory)).toEqual(inventory);
    expect(selectExternalCodingAgentMcpEntries(inventory, ["linear"])).toEqual([
      { name: "linear", toolCount: null },
    ]);
    expect(
      buildExternalCodingAgentMcpReminder([{ name: "exa", toolCount: 2 }]),
    ).toContain("MCP servers with available tools: exa (2 tools)");
  });

  test("inherits local and cloud MCP discovery by default, with explicit opt-out", async () => {
    const deps = {
      getLocalServerNames: (id: string) => {
        expect(id).toBe("parent");
        return ["filesystem"];
      },
      listServerSideServers: async (id: string) => {
        expect(id).toBe("parent");
        return inventory;
      },
    };
    const reminder = await resolveExternalCodingAgentMcpReminder(
      "parent",
      undefined,
      deps,
    );
    expect(reminder).toContain("filesystem, exa (2 tools), linear");
    expect(
      await resolveExternalCodingAgentMcpReminder(
        "parent",
        { inherit: false },
        deps,
      ),
    ).toBeUndefined();
    const subset = await resolveExternalCodingAgentMcpReminder(
      "parent",
      { inherit: true, servers: ["linear"] },
      deps,
    );
    expect(subset).toContain("available tools: linear");
    expect(subset).not.toContain("filesystem");
  });

  test("fails missing subsets and servers without inheritance", () => {
    expect(() =>
      selectExternalCodingAgentMcpEntries(inventory, ["missing"]),
    ).toThrow("not available to the parent agent: missing");
    expect(
      validateExternalCodingAgentMcpOptions({
        inherit: false,
        servers: ["exa"],
      }),
    ).toBe("mcp.servers requires mcp.inherit to be true");
  });
});

describe("external coding agent output and preflight", () => {
  test.skipIf(process.platform === "win32").each([
    ["claude-code", false],
    ["codex", false],
    ["claude-code", true],
    ["codex", true],
  ] as const)(
    "finds %s native installs (existing wrapper: %s)",
    async (type, wrapper) => {
      const home = mkdtempSync(join(tmpdir(), "external-cli-path-"));
      const bin = join(home, ".local", "bin");
      const executable = type === "claude-code" ? "claude" : "codex";
      mkdirSync(bin, { recursive: true });
      // Exercise real OS executable lookup, not a mocked preflight.
      const script = (source: string) =>
        `#!/bin/sh\nprintf '%s\\n' '{"loggedIn":true,"session_id":"${SESSION_ID}","result":"${source}"}'\n`;
      writeFileSync(join(bin, executable), script("native"), { mode: 0o755 });
      const wrapperBin = join(home, "wrappers");
      if (wrapper) {
        mkdirSync(wrapperBin);
        writeFileSync(join(wrapperBin, executable), script("wrapper"), {
          mode: 0o755,
        });
      }
      const originalPath = wrapper
        ? `${wrapperBin}:/usr/bin:/bin`
        : "/usr/bin:/bin";
      const inheritedEnv = { HOME: home, PATH: originalPath };
      const runWorker = (env: NodeJS.ProcessEnv) => {
        expect(env.PATH).toBe(`${originalPath}:${bin}`);
        const child = spawnSync(executable, [], { env, encoding: "utf8" });
        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout).result).toBe(
          wrapper ? "wrapper" : "native",
        );
        return child.stdout;
      };
      try {
        const result = await runExternalCodingAgent(
          { type, prompt: "test", parentAgentId: "parent", cwd: home },
          {
            env: inheritedEnv,
            resolveSecretEnv: async () => ({}),
            runProcess: async (_command, { env }) => ({
              exitCode: 0,
              stdout: runWorker(env),
              stderr: "",
            }),
            runCodexTurn: async (_options, deps) => ({
              agentId: "parent",
              success: true,
              report: runWorker(deps?.env ?? {}),
            }),
          },
        );
        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(inheritedEnv.PATH).toBe(originalPath);
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  test.each(["claude-code", "codex"] as const)(
    "does not start %s preflight after cancellation",
    async (type) => {
      const controller = new AbortController();
      controller.abort(new Error("cancelled"));
      let preflightCalls = 0;
      const result = await runExternalCodingAgent(
        {
          type,
          prompt: "test",
          parentAgentId: "parent",
          signal: controller.signal,
        },
        {
          runPreflight: async () => {
            preflightCalls++;
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("cancelled");
      expect(preflightCalls).toBe(0);
    },
  );

  test("parses Claude Code completion and native session id", () => {
    expect(
      parseExternalCodingAgentOutput(
        "claude-code",
        JSON.stringify({ result: "done", session_id: "claude-session" }),
      ),
    ).toEqual({ report: "done", sessionId: "claude-session" });
  });

  test("parses Codex JSONL completion and native thread id", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "codex-thread" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "done" },
      }),
    ].join("\n");
    expect(parseExternalCodingAgentOutput("codex", output)).toEqual({
      report: "done",
      sessionId: "codex-thread",
    });
  });

  test.each(["claude-code", "codex"] as const)(
    "returns clear unavailable executable failures for %s",
    async (type) => {
      const result = await runExternalCodingAgent(
        { type, prompt: "test", parentAgentId: "parent" },
        {
          runPreflight: async () => {
            throw new Error("Required executable was not found on PATH");
          },
        },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found on PATH");
    },
  );

  test("returns a clear Claude Code authentication failure", async () => {
    const type = "claude-code";
    const result = await runExternalCodingAgent(
      { type, prompt: "test", parentAgentId: "parent" },
      {
        runPreflight: async () => ({
          exitCode: 0,
          stdout: '{"loggedIn":false}',
          stderr: "",
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("authentication is not ready");
  });

  test("uses the Codex app-server turn even when native login status would fail", async () => {
    const preflightArgs: string[][] = [];
    const result = await runExternalCodingAgent(
      { type: "codex", prompt: "test", parentAgentId: "parent" },
      {
        runPreflight: async (_executable, args) => {
          preflightArgs.push(args);
          return { exitCode: 0, stdout: "codex-cli 0.151.0", stderr: "" };
        },
        runCodexTurn: async () => ({
          agentId: "codex_thread-1",
          report: "completed through configured provider",
          success: true,
        }),
      },
    );
    expect(preflightArgs).toEqual([["--version"]]);
    expect(result.success).toBe(true);
    expect(result.report).toContain("configured provider");
  });

  test("reports the real Codex turn's provider failure instead of declaring login success", async () => {
    const result = await runExternalCodingAgent(
      { type: "codex", prompt: "test", parentAgentId: "parent" },
      {
        runPreflight: async () => ({
          exitCode: 0,
          stdout: "codex-cli 0.151.0",
          stderr: "",
        }),
        runCodexTurn: async () => ({
          agentId: "parent",
          report: "",
          success: false,
          error: "No ChatGPT connection is available",
        }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("No ChatGPT connection");
  });

  test("a failed new Codex start settles its thread capture admission", async () => {
    let starts = 0;
    const run = () =>
      runExternalCodingAgent(
        {
          type: "codex",
          prompt: "test",
          parentAgentId: "parent",
          parentConversationId: "conversation-parent",
        },
        {
          env: { ...process.env, LETTA_BASE_URL: "https://api.letta.com" },
          runPreflight: async () => ({
            exitCode: 0,
            stdout: "codex-cli 0.151.0",
            stderr: "",
          }),
          runCodexTurn: async (options) => {
            starts += 1;
            await options.beforeStart?.(SESSION_ID);
            throw new Error("turn/start rejected");
          },
        },
      );
    expect((await run()).error).toContain("turn/start rejected");
    const second = await Promise.race([
      run(),
      Bun.sleep(500).then(() => {
        throw new Error("second Codex start blocked on leaked admission");
      }),
    ]);
    expect(second.error).toContain("turn/start rejected");
    const third = await Promise.race([
      run(),
      Bun.sleep(500).then(() => {
        throw new Error("third Codex start blocked by the reset fence");
      }),
    ]);
    expect(third.error).toContain("turn/start rejected");
    expect(starts).toBe(3);
  });

  test.each([
    ["claude-code", '{"loggedIn":true}', '{"result":"done","session_id":"c1"}'],
  ] as const)(
    "preserves parent identity and session id for %s",
    async (type, auth, output) => {
      let receivedEnv: NodeJS.ProcessEnv | undefined;
      const result = await runExternalCodingAgent(
        { type, prompt: "test", parentAgentId: "parent" },
        {
          env: { ...process.env, LETTA_ACTING_USER_ID: "ambient-user" },
          runPreflight: async () => ({ exitCode: 0, stdout: auth, stderr: "" }),
          runProcess: async (_command, options) => {
            receivedEnv = options.env;
            return { exitCode: 0, stdout: output, stderr: "" };
          },
        },
      );
      expect(result.success).toBe(true);
      expect(result.agentId).toBe(
        type === "claude-code" ? "claude_c1" : "codex_x1",
      );
      expect(result.runtimeSessionId).toBe(
        type === "claude-code" ? "c1" : "x1",
      );
      expect(receivedEnv?.AGENT_ID).toBe("parent");
      expect(receivedEnv?.LETTA_AGENT_ID).toBe("parent");
      expect(receivedEnv?.LETTA_PARENT_AGENT_ID).toBe("parent");
      expect(receivedEnv?.LETTA_CODE_AGENT_ROLE).toBe("subagent");
      expect(receivedEnv?.LETTA_ACTING_USER_ID).toBe("ambient-user");
    },
  );

  test("explicit unattributed runtime suppresses ambient external-worker actor", async () => {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    await runWithRuntimeContext({ suppressActingUserFallback: true }, () =>
      runExternalCodingAgent(
        {
          type: "claude-code",
          prompt: "test",
          parentAgentId: "parent",
        },
        {
          env: { ...process.env, LETTA_ACTING_USER_ID: "ambient-user" },
          runPreflight: async () => ({
            exitCode: 0,
            stdout: '{"loggedIn":true}',
            stderr: "",
          }),
          runProcess: async (_command, options) => {
            receivedEnv = options.env;
            return {
              exitCode: 0,
              stdout: '{"result":"done","session_id":"c1"}',
              stderr: "",
            };
          },
        },
      ),
    );
    expect(receivedEnv?.LETTA_ACTING_USER_ID).toBeUndefined();
  });

  test("explicit null clears an inherited external-worker actor", async () => {
    let receivedEnv: NodeJS.ProcessEnv | undefined;
    await runExternalCodingAgent(
      {
        type: "claude-code",
        prompt: "test",
        parentAgentId: "parent",
        actingUserId: null,
      },
      {
        env: { ...process.env, LETTA_ACTING_USER_ID: "ambient-user" },
        runPreflight: async () => ({
          exitCode: 0,
          stdout: '{"loggedIn":true}',
          stderr: "",
        }),
        runProcess: async (_command, options) => {
          receivedEnv = options.env;
          return {
            exitCode: 0,
            stdout: '{"result":"done","session_id":"c1"}',
            stderr: "",
          };
        },
      },
    );
    expect(receivedEnv?.LETTA_ACTING_USER_ID).toBeUndefined();
  });
});

describe("external coding agent vault secrets", () => {
  test("exports the MCP-scope vault with the parent's own secrets winning", async () => {
    const { __testSeedSecretsCache, clearSecretsCache } = await import(
      "@/utils/secrets-store"
    );
    const { resolveExternalCodingAgentSecretEnv } = await import(
      "./external-coding-agent"
    );
    __testSeedSecretsCache("agent-ext-child", { SHARED: "child-value" });
    __testSeedSecretsCache("agent-ext-root", {
      SHARED: "root-value",
      GITHUB_TOKEN: "root-token",
    });
    const parents: Record<string, string> = {
      "agent-ext-child": "agent-ext-root",
    };
    try {
      const inherited = await runWithRuntimeContext(
        {
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
            parent_agent_id: "agent-ext-root",
            agent_role: "subagent",
          },
        },
        () =>
          resolveExternalCodingAgentSecretEnv(
            "agent-ext-child",
            async (id) => parents[id],
          ),
      );
      expect(inherited).toEqual({
        SHARED: "child-value",
        GITHUB_TOKEN: "root-token",
      });
      const ownOnly = await runWithRuntimeContext(
        {
          executionSettings: {
            allowed_tools: [],
            disallowed_tools: [],
            disable_memory_guard: false,
          },
        },
        () =>
          resolveExternalCodingAgentSecretEnv(
            "agent-ext-child",
            async (id) => parents[id],
          ),
      );
      expect(ownOnly).toEqual({ SHARED: "child-value" });
    } finally {
      clearSecretsCache("agent-ext-child");
      clearSecretsCache("agent-ext-root");
    }
  });

  test("launches the worker with the resolved vault in its environment", async () => {
    let seenEnv: NodeJS.ProcessEnv | undefined;
    await runExternalCodingAgent(
      { type: "claude-code", prompt: "test", parentAgentId: "parent" },
      {
        env: {},
        resolveSecretEnv: async () => ({ GITHUB_TOKEN: "vault-token" }),
        runPreflight: async (_executable, _args, env) => {
          seenEnv = env;
          return { exitCode: 1, stdout: "", stderr: "stop" };
        },
      },
    );
    expect(seenEnv?.GITHUB_TOKEN).toBe("vault-token");
    expect(seenEnv?.LETTA_AGENT_ID).toBe("parent");
  });

  test("scrubs exported vault values from the worker's report", async () => {
    const token = "ghp_exported_vault_value_123";
    const result = await runExternalCodingAgent(
      { type: "codex", prompt: "test", parentAgentId: "parent" },
      {
        env: {},
        resolveSecretEnv: async () => ({ GITHUB_TOKEN: token }),
        runPreflight: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
        runCodexTurn: async () => ({
          agentId: "codex_thread",
          runtimeSessionId: "thread",
          report: `the token is ${token}`,
          success: true,
          durationMs: 1,
        }),
      },
    );
    expect(result.success).toBe(true);
    expect(result.report).not.toContain(token);
    expect(result.report).toContain("the token is");
  });
});

describe("external coding agent reminder composition", () => {
  test.each(["opencode", "cursor"] as const)(
    "%s forwards MCP without discovering or forwarding skills",
    async (type) => {
      let discovered = false;
      let received: string | undefined;
      const result = await runExternalCodingAgent(
        {
          type,
          parentAgentId: "parent",
          prompt: "test",
          mcpReminder: "MCP",
        },
        {
          resolveSkillsReminder: async () => {
            discovered = true;
            return "skills";
          },
          resolveSecretEnv: async () => ({}),
          [type === "cursor" ? "runCursorTurn" : "runOpenCodeTurn"]:
            async (options: { mcpReminder?: string }) => {
              received = options.mcpReminder;
              return { agentId: "parent", report: "done", success: true };
            },
        },
      );
      expect(result.success).toBe(true);
      expect(discovered).toBe(false);
      expect(received).toBe("MCP");
    },
  );

  for (const type of ["claude-code", "codex"] as const) {
    test.each([
      ["skills", "MCP", "skills\n\nMCP"],
      ["skills", undefined, "skills"],
      [undefined, "MCP", "MCP"],
      [undefined, undefined, undefined],
    ])(
      `${type} forwards skills and MCP independently (%s, %s)`,
      async (skills, mcp, expected) => {
        let received: string | undefined;
        const result = await runExternalCodingAgent(
          {
            type,
            parentAgentId: "parent",
            cwd: "/repo",
            prompt: "test",
            mcpReminder: mcp,
          },
          {
            resolveSkillsReminder: async (parent, cwd) => {
              expect(parent).toBe("parent");
              expect(cwd).toBe("/repo");
              return skills;
            },
            resolveSecretEnv: async () => ({}),
            runPreflight: async () => ({
              exitCode: 0,
              stdout: '{"loggedIn":true}',
              stderr: "",
            }),
            runProcess: async (command) => {
              const index = command.args.indexOf("--append-system-prompt");
              received = index < 0 ? undefined : command.args[index + 1];
              return {
                exitCode: 0,
                stdout: '{"result":"done","session_id":"c1"}',
                stderr: "",
              };
            },
            runCodexTurn: async (options) => {
              received = options.mcpReminder;
              return { agentId: "parent", report: "done", success: true };
            },
          },
        );
        expect(result.success).toBe(true);
        expect(received).toBe(expected);
      },
    );
  }
});
