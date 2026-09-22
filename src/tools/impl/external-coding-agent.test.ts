import { describe, expect, test } from "bun:test";
import {
  buildExternalCodingAgentCommand,
  buildExternalCodingAgentMcpReminder,
  formatExternalCodingAgentId,
  parseExternalCodingAgentId,
  parseExternalCodingAgentOutput,
  runExternalCodingAgent,
  selectExternalCodingAgentMcpEntries,
  validateExternalCodingAgentMcpOptions,
} from "./external-coding-agent";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

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
    expect(command.args).toContain("json");
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

  test.each(["claude-code", "codex"] as const)(
    "returns clear authentication failures for %s",
    async (type) => {
      const result = await runExternalCodingAgent(
        { type, prompt: "test", parentAgentId: "parent" },
        {
          runPreflight: async () => ({
            exitCode: type === "claude-code" ? 0 : 1,
            stdout:
              type === "claude-code" ? '{"loggedIn":false}' : "Not logged in",
            stderr: "",
          }),
        },
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("authentication is not ready");
    },
  );

  test.each([
    ["claude-code", '{"loggedIn":true}', '{"result":"done","session_id":"c1"}'],
  ] as const)(
    "preserves parent identity and session id for %s",
    async (type, auth, output) => {
      let receivedEnv: NodeJS.ProcessEnv | undefined;
      const result = await runExternalCodingAgent(
        { type, prompt: "test", parentAgentId: "parent" },
        {
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
    },
  );
});
