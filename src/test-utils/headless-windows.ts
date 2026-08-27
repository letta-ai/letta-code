#!/usr/bin/env bun
/**
 * Windows-specific headless integration test
 *
 * Tests that Letta Code works correctly on Windows by:
 * 1. Running shell commands (tests PowerShell preference)
 * 2. Creating a multiline echo (tests heredoc avoidance)
 * 3. Checking tool availability (tests PATH)
 *
 * Only runs on Windows (process.platform === 'win32')
 *
 * Usage:
 *   bun run src/test-utils/headless-windows.ts --model haiku
 */

import { createAuthenticatedCliTestEnv } from "./test-process-env";

type Args = {
  model: string;
};

type WireRecord = Record<string, unknown>;

function parseArgs(argv: string[]): Args {
  const args: { model?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--model") args.model = argv[++i];
  }
  if (!args.model) throw new Error("Missing --model");
  return args as Args;
}

async function ensurePrereqs(): Promise<"ok" | "skip"> {
  if (process.platform !== "win32") {
    console.log("SKIP: Not running on Windows");
    return "skip";
  }
  if (!process.env.LETTA_API_KEY) {
    console.log("SKIP: Missing env LETTA_API_KEY");
    return "skip";
  }
  return "ok";
}

function windowsScenarioPrompt(): string {
  return (
    "I want to test Windows shell compatibility (do not ask for any clarifications, this is an automated test on a Windows CI runner). " +
    "IMPORTANT: You are running on Windows with PowerShell. Do NOT use bash-specific syntax like heredoc ($(cat <<'EOF'...EOF)) or && for chaining. " +
    "Step 1: Run a simple shell command: echo 'Hello from Windows' " +
    "Step 2: Run a multiline echo command. Do NOT use heredoc or && syntax. Use PowerShell semicolon syntax: echo 'Line1'; echo 'Line2' " +
    "Step 3: Check if git is available by running: git --version " +
    "IMPORTANT: If all three steps completed successfully (no errors), include the word BANANA (uppercase) in your final response. " +
    "If any step failed due to shell syntax issues, do NOT include BANANA."
  );
}

function parseWireRecords(stdout: string): WireRecord[] {
  const records: WireRecord[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        records.push(value as WireRecord);
      }
    } catch {
      // Ignore output outside the stream-json protocol. Required protocol
      // records are validated below.
    }
  }
  return records;
}

function requireIncludes(
  value: string,
  expected: string,
  description: string,
): void {
  if (!value.includes(expected)) {
    throw new Error(`Missing ${description}: ${expected}`);
  }
}

export function validateWindowsScenarioOutput(stdout: string): void {
  const records = parseWireRecords(stdout);
  const shellCalls = records.flatMap((record) => {
    if (
      record.type !== "message" ||
      record.message_type !== "tool_call_message" ||
      !record.tool_call ||
      typeof record.tool_call !== "object" ||
      Array.isArray(record.tool_call)
    ) {
      return [];
    }
    const call = record.tool_call as WireRecord;
    return call.name === "Bash" ? [call] : [];
  });
  if (shellCalls.length === 0) {
    throw new Error("No Bash tool_call_message records were emitted");
  }

  const allArguments = shellCalls
    .map((call) => (typeof call.arguments === "string" ? call.arguments : ""))
    .join("\n");
  requireIncludes(allArguments, "Hello from Windows", "echo command");
  requireIncludes(allArguments, "Line1", "multiline command first line");
  requireIncludes(allArguments, "Line2", "multiline command second line");
  requireIncludes(allArguments, "git --version", "git command");
  if (allArguments.includes("<<") || allArguments.includes("&&")) {
    throw new Error("Windows shell command used forbidden bash syntax");
  }

  const toolReturns = records.filter(
    (record) =>
      record.type === "message" &&
      record.message_type === "tool_return_message",
  );
  const returnsByCallId = new Map(
    toolReturns
      .filter(
        (record) =>
          typeof record.tool_call_id === "string" &&
          record.tool_call_id.length > 0,
      )
      .map((record) => [record.tool_call_id as string, record] as const),
  );
  const shellOutput: string[] = [];
  for (const call of shellCalls) {
    if (typeof call.tool_call_id !== "string") {
      throw new Error("Bash tool call is missing its ID");
    }
    const toolReturn = returnsByCallId.get(call.tool_call_id);
    if (!toolReturn) {
      throw new Error("Missing tool return for Bash call");
    }
    if (toolReturn.status !== "success") {
      throw new Error(`Shell tool call failed: ${call.tool_call_id}`);
    }
    shellOutput.push(
      typeof toolReturn.tool_return === "string"
        ? toolReturn.tool_return
        : JSON.stringify(toolReturn.tool_return),
    );
  }

  const allToolOutput = shellOutput.join("\n");
  requireIncludes(allToolOutput, "Hello from Windows", "echo output");
  requireIncludes(allToolOutput, "Line1", "multiline output first line");
  requireIncludes(allToolOutput, "Line2", "multiline output second line");
  if (!/git version \d/i.test(allToolOutput)) {
    throw new Error("Missing successful git --version output");
  }

  const result = records.find((record) => record.type === "result");
  if (!result || result.subtype !== "success") {
    throw new Error("Missing successful result record");
  }
  const resultText = typeof result.result === "string" ? result.result : "";
  requireIncludes(resultText, "BANANA", "final success marker");
}

async function runCLI(
  model: string,
): Promise<{ stdout: string; code: number }> {
  const cmd = [
    "bun",
    "run",
    "dev",
    "-p",
    windowsScenarioPrompt(),
    "--yolo",
    "--new-agent",
    "--memfs-startup",
    "skip",
    "--output-format",
    "stream-json",
    "-m",
    model,
  ];
  // Use an isolated env so the scenario doesn't mutate the user's saved session state.
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: createAuthenticatedCliTestEnv(),
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    console.error("CLI failed:\n", err, out);
  }
  return { stdout: out, code };
}

async function main() {
  const { model } = parseArgs(process.argv.slice(2));
  const prereq = await ensurePrereqs();
  if (prereq === "skip") return;

  console.log(`Running Windows integration test with model: ${model}`);
  console.log("Platform:", process.platform);

  const { stdout, code } = await runCLI(model);

  if (code !== 0) {
    throw new Error(`CLI exited with non-zero code: ${code}`);
  }

  try {
    validateWindowsScenarioOutput(stdout);
    console.log(`PASS: Windows integration test succeeded with ${model}`);
  } catch (error) {
    console.error("FAIL: Windows integration test failed");
    console.error("\n===== BEGIN STDOUT =====");
    console.error(stdout);
    console.error("===== END STDOUT =====\n");
    throw error;
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error("Fatal error:", error);
    process.exit(1);
  });
}
