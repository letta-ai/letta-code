import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  createServerLifecycleOutput,
  resolveServerLifecycleOutput,
} from "@/cli/subcommands/lifecycle-output";

async function runLifecycleCli(
  extraEnv: Record<string, string | undefined> = {},
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const bundle = process.env.LETTA_TEST_CLI_BUNDLE;
  const child = Bun.spawn(
    [
      bundle ? "node" : process.execPath,
      bundle || "src/index.ts",
      "server",
      "--lifecycle-output",
      "jsonl",
      ...extraArgs,
      "--help",
    ],
    {
      cwd: resolve(import.meta.dir, "../../.."),
      env: {
        ...process.env,
        LETTA_DEBUG: "0",
        DEBUG: undefined,
        LETTA_STARTUP_LOG_MARKER: "cfa52d2e-c4bd-41ee-84b5-fb346258a9c3",
        LETTA_STARTUP_LOG_OWNER_PID: undefined,
        ...extraEnv,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe("server lifecycle output", () => {
  test("emits protocol-versioned JSON lines without runtime payloads", () => {
    const lines: string[] = [];
    const output = createServerLifecycleOutput((line) => lines.push(line));

    output.emit("reconnecting");
    output.emit("connected");
    output.emitListenerStatus("idle");
    output.emitListenerStatus("receiving");
    output.emitListenerStatus("processing");
    output.emit("reconnecting");
    output.emit("error");

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { lettaLifecycleProtocol: 1, state: "reconnecting" },
      { lettaLifecycleProtocol: 1, state: "connected" },
      { lettaLifecycleProtocol: 1, state: "idle" },
      { lettaLifecycleProtocol: 1, state: "working" },
      { lettaLifecycleProtocol: 1, state: "reconnecting" },
      { lettaLifecycleProtocol: 1, state: "error" },
    ]);
    expect(lines.join("\n")).not.toContain("connectionId");
    expect(lines.join("\n")).not.toContain("message");
  });

  test("deduplicates repeated state transitions", () => {
    const lines: string[] = [];
    const output = createServerLifecycleOutput((line) => lines.push(line));

    output.emit("idle");
    output.emit("idle");
    output.emitListenerStatus("idle");

    expect(lines).toHaveLength(1);
  });

  test("validates supervisor output mode without enabling debug payloads", () => {
    expect(resolveServerLifecycleOutput("yaml", false)).toMatchObject({
      output: null,
      error: expect.stringContaining('expected "jsonl"'),
    });
    expect(resolveServerLifecycleOutput("jsonl", true)).toMatchObject({
      output: null,
      error: expect.stringContaining("debug output is enabled"),
    });
    expect(resolveServerLifecycleOutput("jsonl", false)).toMatchObject({
      error: null,
    });
  });
});

describe("server lifecycle CLI output", () => {
  test("keeps stdout JSONL-only without usage or startup markers", async () => {
    const result = await runLifecycleCli();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stdout).toBe(
      '{"lettaLifecycleProtocol":1,"state":"error"}\n',
    );
    expect(result.stdout).not.toContain("Usage:");
    expect(result.stdout).not.toContain("letta-startup-end");
  });

  test.each([
    ["LETTA_DEBUG", "1"],
    ["DEBUG", "1"],
  ])(
    "rejects lifecycle mode when %s=%s can enable debug output",
    async (variable, value) => {
      const result = await runLifecycleCli({ [variable]: value });
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("debug output is enabled");
    },
  );

  test.each(["0", "false", "letta:*"])(
    "keeps lifecycle stdout machine-only when DEBUG=%s is disabled",
    async (value) => {
      const result = await runLifecycleCli({ DEBUG: value });
      expect(result.code, result.stderr).toBe(1);
      expect(result.stdout).toBe(
        '{"lettaLifecycleProtocol":1,"state":"error"}\n',
      );
    },
  );

  test("keeps parse-error usage off lifecycle stdout", async () => {
    const result = await runLifecycleCli({}, ["--not-a-listener-option"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      '{"lettaLifecycleProtocol":1,"state":"error"}\n',
    );
    expect(result.stdout).not.toContain("Usage:");
    expect(result.stdout).not.toContain("letta-startup-end");
    expect(result.stderr).toContain("not-a-listener-option");
  });
});
