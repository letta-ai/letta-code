import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateProbe } from "./runtime-observations.ts";
import {
  CLAUDE_PROBE_CONTRACT_VERSION,
  captureClaudeRuntime,
  createClaudeRuntimeCommandPlan,
  diffClaudeRuntime,
  isClaudeProbeContractCurrent,
  normalizeVolatile,
  parseClaudeStream,
} from "./runtime-probe.ts";
import {
  type CommandResult,
  type CommandRunner,
  type CommandSpec,
  runBoundedCommand,
  sandboxClaudeCommand,
} from "./runtime-sandbox.ts";
import type { ClaudeRuntimeSnapshot } from "./types.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "runtime-probe-test-"));
  tempRoots.push(root);
  return root;
}

function result(
  stdout = "",
  overrides: Partial<CommandResult> = {},
): CommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
    signal: null,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<ClaudeRuntimeSnapshot> = {},
): ClaudeRuntimeSnapshot {
  return {
    probe_contract_version: CLAUDE_PROBE_CONTRACT_VERSION,
    version: "1.2.3",
    version_output: "1.2.3 (Claude Code)",
    help_text: "--permission-mode auto",
    help_hash: "help-a",
    doctor: { exit_code: 0, summary: "ok" },
    auto_mode_defaults: ["auto default"],
    init: {
      tools: ["Read"],
      model: "claude-test",
      capabilities: null,
      stable_fields: {},
    },
    event_inventory: ["assistant", "system/init"],
    probes: [],
    digest: "digest",
    ...overrides,
  };
}

describe("command planning", () => {
  test("invalidates cached probes when their observation contract changes", () => {
    expect(isClaudeProbeContractCurrent(snapshot())).toBe(true);
    expect(
      isClaudeProbeContractCurrent(
        snapshot({ probe_contract_version: CLAUDE_PROBE_CONTRACT_VERSION - 1 }),
      ),
    ).toBe(false);
    expect(isClaudeProbeContractCurrent(undefined)).toBe(false);
  });

  test("uses an exact local package install and a constrained inert command", () => {
    const plan = createClaudeRuntimeCommandPlan("1.2.3", "/tmp/supplied/root", {
      env: { PATH: "/bin", ANTHROPIC_API_KEY: "secret" },
    });

    expect(plan.packageSpec).toBe("@anthropic-ai/claude-code@1.2.3");
    expect(plan.install.command).toBe("npm");
    expect(plan.install.args.join(" ")).toContain(plan.packageSpec);
    expect(plan.install.args).not.toContain("--ignore-scripts");
    expect(plan.install.args.join(" ")).not.toMatch(
      /@latest|\bnpx\b|--global|-g\b/,
    );
    expect(plan.binary).toStartWith(plan.installRoot);
    expect(plan.init.env.HOME).toBe(plan.home);
    expect(plan.init.env.CLAUDE_CONFIG_DIR).toBe(plan.config);
    expect(plan.init.env.DISABLE_UPDATES).toBe("1");
    expect(plan.install.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(plan.init.env.ANTHROPIC_API_KEY).toBe("secret");
    expect(plan.autoModeDefaults.args).toEqual(["auto-mode", "defaults"]);
    expect(plan.init.args).toContain("stream-json");
    expect(plan.init.args).toContain("dontAsk");
    expect(plan.init.args).toContain("--safe-mode");
    expect(plan.init.args).not.toContain("--tools");
    expect(plan.probes).toHaveLength(2);
    for (const probe of plan.probes) {
      expect(probe.command.args).toContain("--allowedTools");
      expect(probe.command.args).toContain("--safe-mode");
      expect(probe.command.args).not.toContain("--max-turns");
      expect(probe.command.args).toContain("--max-budget-usd");
    }
  });

  test("rejects ranges and dist tags", () => {
    expect(() => createClaudeRuntimeCommandPlan("latest", "/tmp/x")).toThrow(
      "exact",
    );
    expect(() => createClaudeRuntimeCommandPlan("^1.2.3", "/tmp/x")).toThrow(
      "exact",
    );
  });

  test("container sandbox mounts only the disposable root and hides secret values from argv", () => {
    const plan = createClaudeRuntimeCommandPlan("1.2.3", "/tmp/probe-root", {
      env: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-ant-never-in-argv",
        GH_TOKEN: "must-not-be-in-plan",
      },
    });
    const sandboxed = sandboxClaudeCommand(plan.init, plan.root);
    const serialized = sandboxed.args.join(" ");
    expect(sandboxed.command).toBe("/usr/bin/docker");
    expect(serialized).toContain("/tmp/probe-root:/watch:rw");
    expect(serialized).toContain("node:22.18.0-bookworm@sha256:");
    expect(serialized).toContain("--cap-drop ALL");
    expect(serialized).toContain("--read-only");
    expect(serialized).toContain("--env ANTHROPIC_API_KEY");
    expect(serialized).not.toContain("sk-ant-never-in-argv");
    expect(serialized).not.toContain("GH_TOKEN");
    expect(serialized).not.toContain(process.cwd());
  });
});

describe("stream parsing and normalization", () => {
  test("extracts first init, event inventory, calls, and results", () => {
    const stream = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "volatile",
        tools: ["Write", "Read", "Read"],
        model: "claude-test",
        permissionMode: "dontAsk",
        capabilities: { beta: true, timestamp: "gone" },
      }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tool-123",
              name: "Read",
              input: { file_path: "/tmp/random/file" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-123",
              content: "     9→\tnine",
              is_error: false,
            },
          ],
        },
      }),
    ].join("\n");

    const parsed = parseClaudeStream(stream);
    expect(parsed.init?.tools).toEqual(["Read", "Write"]);
    expect(parsed.init?.stableFields).toEqual({ permissionMode: "dontAsk" });
    expect(parsed.init?.capabilities).toEqual({ beta: true });
    expect(parsed.eventTypes).toEqual(["assistant", "system/init", "user"]);
    expect(parsed.toolCalls).toEqual([
      { id: "tool-123", name: "Read", input: { file_path: "<tmp>" } },
    ]);
    expect(parsed.toolResults[0]?.content).toBe("     9→\tnine");
  });

  test("evaluates exact Read bytes rather than mere tool completion", () => {
    const definition = {
      name: "read-lines-9-10-tab-prefix",
      allowedTools: ["Read"],
      prompt: "",
    };
    const exact = parseClaudeStream(
      [
        JSON.stringify({ type: "system", subtype: "init", tools: ["Read"] }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "read-1",
                name: "Read",
                input: { file_path: "./read-fixture.txt", offset: 9, limit: 2 },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-1",
                content: "9\tline9\n10\tline10",
              },
            ],
          },
        }),
      ].join("\n"),
    );
    expect(evaluateProbe(definition.name, exact)).toEqual({
      complete: true,
      assertions: {
        exact_line_9: true,
        exact_line_10: true,
        no_line_9_padding: true,
        no_arrow_separator: true,
        result_not_error: true,
      },
    });

    const arrow = parseClaudeStream(
      [
        JSON.stringify({ type: "system", subtype: "init", tools: ["Read"] }),
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "read-2",
                name: "Read",
                input: { offset: 9, limit: 2 },
              },
            ],
          },
        }),
        JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "read-2",
                content: " 9→line9\n10→line10",
              },
            ],
          },
        }),
      ].join("\n"),
    );
    expect(evaluateProbe(definition.name, arrow).complete).toBe(true);
    expect(evaluateProbe(definition.name, arrow).assertions).toMatchObject({
      exact_line_9: false,
      exact_line_10: false,
      no_arrow_separator: false,
    });
  });

  test("evaluates arbitrary task metadata, null deletion, and permanent deletion", () => {
    const evaluation = evaluateProbe("task-metadata-delete-contract", {
      toolCalls: [
        { id: "create", name: "TaskCreate", input: {} },
        {
          id: "metadata",
          name: "TaskUpdate",
          input: {
            taskId: "1",
            metadata: {
              probe: null,
              count: 3,
              flags: ["ready"],
              details: { source: "claude-watch" },
            },
          },
        },
        { id: "before", name: "TaskGet", input: { taskId: "1" } },
        {
          id: "delete",
          name: "TaskUpdate",
          input: { taskId: "1", status: "deleted" },
        },
        { id: "after", name: "TaskGet", input: { taskId: "1" } },
        { id: "list", name: "TaskList", input: {} },
      ],
      toolResults: [
        { toolUseId: "create", content: "{}", isError: false },
        { toolUseId: "metadata", content: "{}", isError: false },
        {
          toolUseId: "before",
          content: JSON.stringify({
            metadata: {
              keep: "yes",
              count: 3,
              flags: ["ready"],
              details: { source: "claude-watch" },
            },
          }),
          isError: false,
        },
        {
          toolUseId: "delete",
          content: '{"status":"deleted"}',
          isError: false,
        },
        {
          toolUseId: "after",
          content: "Task not found",
          isError: true,
        },
        { toolUseId: "list", content: '{"tasks":[]}', isError: false },
      ],
    });
    expect(evaluation).toEqual({
      complete: true,
      assertions: {
        metadata_arbitrary_values_accepted: true,
        metadata_null_update_accepted: true,
        deleted_task_get_errors: true,
        deleted_task_absent: true,
      },
    });
  });

  test("rejects malformed and empty streams without including raw data", () => {
    expect(() => parseClaudeStream('{"type":"system"}\n{secret')).toThrow(
      "line 2",
    );
    expect(() => parseClaudeStream(" \n")).toThrow("no events");
    try {
      parseClaudeStream("not-json-containing-sk-ant-supersecret");
    } catch (error) {
      expect(String(error)).not.toContain("supersecret");
    }
  });

  test("removes volatile fields, paths, identifiers, timestamps, and secrets", () => {
    expect(
      normalizeVolatile({
        session_id: "drop",
        timestamp: "drop",
        stable: "at /tmp/random-123/file",
        nested: { request_id: "drop", token: "sk-ant-abcdefghijk" },
      }),
    ).toEqual({ nested: {}, stable: "at <tmp>" });
  });
});

describe("runtime diff", () => {
  test("reports tool/event changes and normalized probe differences", () => {
    const before = snapshot({
      probes: [
        {
          name: "read-lines-9-10-tab-prefix",
          status: "passed",
          attempts: 1,
          assertions: { exact: false },
          tool_calls: [{ name: "Read", input: { offset: 9, limit: 2 } }],
          tool_results: ["old"],
          filesystem_changes: [],
          error: null,
        },
      ],
    });
    const after = snapshot({
      init: {
        tools: ["Read", "TaskCreate"],
        model: "claude-test",
        capabilities: null,
        stable_fields: {},
      },
      event_inventory: ["assistant", "result", "system/init"],
      probes: [
        {
          name: "read-lines-9-10-tab-prefix",
          status: "passed",
          attempts: 1,
          assertions: { exact: true },
          tool_calls: [{ name: "Read", input: { offset: 9, limit: 2 } }],
          tool_results: ["new"],
          filesystem_changes: [],
          error: null,
        },
      ],
    });

    expect(diffClaudeRuntime(before, after)).toEqual({
      tools_added: ["TaskCreate"],
      tools_removed: [],
      help_changed: false,
      help_lines_added: [],
      help_lines_removed: [],
      doctor_changed: false,
      init_changed: true,
      auto_mode_defaults_changed: false,
      event_types_added: ["result"],
      event_types_removed: [],
      changed_probes: ["read-lines-9-10-tab-prefix"],
    });
  });
});

describe("capture orchestration", () => {
  function successfulRunner(
    version = "1.2.3",
    calls: CommandSpec[] = [],
  ): CommandRunner {
    return async (spec) => {
      calls.push(spec);
      switch (spec.label) {
        case "verify-package":
          return result(version);
        case "version":
          return result(`${version} (Claude Code)`);
        case "help":
          return result("--permission-mode auto (default: auto)");
        case "auto-mode-defaults":
          return result('{"allow":["Read"],"soft_deny":[]}');
        case "doctor":
          return result("Doctor OK");
        default:
          return result();
      }
    };
  }

  test("fails package version mismatch before invoking the binary", async () => {
    const root = await temporaryRoot();
    const calls: CommandSpec[] = [];
    await expect(
      captureClaudeRuntime({
        version: "1.2.3",
        tempDir: root,
        runner: successfulRunner("1.2.4", calls),
      }),
    ).rejects.toThrow("package version mismatch");
    expect(calls.some((call) => call.label === "version")).toBe(false);
  });

  test("fails claude --version mismatch", async () => {
    const root = await temporaryRoot();
    const runner: CommandRunner = async (spec) => {
      if (spec.label === "verify-package") return result("1.2.3");
      if (spec.label === "version") return result("1.2.4 (Claude Code)");
      return result();
    };
    await expect(
      captureClaudeRuntime({ version: "1.2.3", tempDir: root, runner }),
    ).rejects.toThrow("--version mismatch");
  });

  test("missing auth captures public surfaces and skips authenticated probes", async () => {
    const root = await temporaryRoot();
    const calls: CommandSpec[] = [];
    const captured = await captureClaudeRuntime({
      version: "1.2.3",
      tempDir: root,
      env: { PATH: process.env.PATH },
      runner: successfulRunner("1.2.3", calls),
      requireAuth: false,
    });
    expect(captured?.init).toBeNull();
    expect(captured?.probes.map((probe) => probe.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(
      calls.some(
        (call) =>
          call.label === "init-stream" || call.label.startsWith("probe:"),
      ),
    ).toBe(false);
  });

  test("captures optional diagnostic timeouts without losing runtime evidence", async () => {
    const root = await temporaryRoot();
    const base = successfulRunner();
    const runner: CommandRunner = async (spec) =>
      spec.label === "doctor" || spec.label === "auto-mode-defaults"
        ? result("", { exitCode: null, timedOut: true, signal: "SIGTERM" })
        : base(spec);
    const captured = await captureClaudeRuntime({
      version: "1.2.3",
      tempDir: root,
      env: { PATH: process.env.PATH },
      runner,
      requireAuth: false,
    });

    expect(captured?.doctor).toEqual({ exit_code: -1, summary: "timed_out" });
    expect(captured?.auto_mode_defaults).toBeNull();
  });

  test("nonzero authenticated stream fails safely", async () => {
    const root = await temporaryRoot();
    const base = successfulRunner();
    const runner: CommandRunner = async (spec) =>
      spec.label === "init-stream"
        ? result("", {
            exitCode: 2,
            stderr: "internal failure: sk-ant-do-not-print",
          })
        : base(spec);
    await expect(
      captureClaudeRuntime({
        version: "1.2.3",
        tempDir: root,
        env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "secret" },
        runner,
      }),
    ).rejects.toThrow("exited nonzero");
  });

  test("dry-run creates nothing and runs no commands", async () => {
    const root = await temporaryRoot();
    let called = false;
    const captured = await captureClaudeRuntime({
      version: "1.2.3",
      tempDir: root,
      dryRun: true,
      runner: async () => {
        called = true;
        return result();
      },
    });
    expect(captured).toBeNull();
    expect(called).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("bounded process runner", () => {
  test("marks a command timed out and terminates it", async () => {
    const root = await temporaryRoot();
    const commandResult = await runBoundedCommand({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: root,
      env: process.env,
      timeoutMs: 30,
      outputCapBytes: 1024,
      label: "timeout-test",
    });
    expect(commandResult.timedOut).toBe(true);
    expect(commandResult.exitCode).not.toBe(0);
  });
});
