import { describe, expect, test } from "bun:test";
import { validateWindowsScenarioOutput } from "./headless-windows";

function line(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function validOutput(): string {
  return [
    line({
      type: "message",
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-echo",
        name: "Bash",
        arguments: JSON.stringify({
          command: "echo 'Hello from Windows'",
        }),
      },
    }),
    line({
      type: "message",
      message_type: "tool_return_message",
      tool_call_id: "call-echo",
      status: "success",
      tool_return: "Hello from Windows",
    }),
    line({
      type: "message",
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-multiline",
        name: "Bash",
        arguments: JSON.stringify({
          command: "echo 'Line1'; echo 'Line2'",
        }),
      },
    }),
    line({
      type: "message",
      message_type: "tool_return_message",
      tool_call_id: "call-multiline",
      status: "success",
      tool_return: [{ type: "text", text: "Line1\nLine2" }],
    }),
    line({
      type: "message",
      message_type: "tool_call_message",
      tool_call: {
        tool_call_id: "call-git",
        name: "Bash",
        arguments: JSON.stringify({ command: "git --version" }),
      },
    }),
    line({
      type: "message",
      message_type: "tool_return_message",
      tool_call_id: "call-git",
      status: "success",
      tool_return: "git version 2.51.0.windows.1",
    }),
    line({ type: "result", subtype: "success", result: "BANANA" }),
  ].join("\n");
}

describe("Windows headless scenario validation", () => {
  test("accepts executed PowerShell-compatible commands and their output", () => {
    expect(() => validateWindowsScenarioOutput(validOutput())).not.toThrow();
  });

  test("rejects a final success marker without executed command output", () => {
    const output = validOutput()
      .split("\n")
      .filter((entry) => !entry.includes("tool_return_message"))
      .join("\n");

    expect(() => validateWindowsScenarioOutput(output)).toThrow(
      "Missing tool return",
    );
  });

  test("rejects bash-only command syntax even when commands returned output", () => {
    const output = validOutput().replace(
      "echo 'Line1'; echo 'Line2'",
      "echo 'Line1' && echo 'Line2'",
    );

    expect(() => validateWindowsScenarioOutput(output)).toThrow(
      "forbidden bash syntax",
    );
  });

  test("rejects failed shell execution even when output markers are present", () => {
    const output = validOutput().replace(
      '"tool_call_id":"call-git","status":"success"',
      '"tool_call_id":"call-git","status":"error"',
    );

    expect(() => validateWindowsScenarioOutput(output)).toThrow(
      "Shell tool call failed",
    );
  });

  test("rejects output that did not come from the requested git command", () => {
    const output = validOutput().replace("git --version", "echo 'git version'");

    expect(() => validateWindowsScenarioOutput(output)).toThrow("git command");
  });
});
