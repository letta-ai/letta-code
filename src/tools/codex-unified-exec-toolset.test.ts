import { describe, expect, test } from "bun:test";
import ShellDescription from "@/tools/descriptions/Shell.md";
import { OPENAI_DEFAULT_TOOLS, OPENAI_PASCAL_TOOLS } from "@/tools/manager";
import ExecCommandSchema from "@/tools/schemas/ExecCommand.json";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";

function extractCommitGuidance(description: string): string {
  const start = description.indexOf("# Committing changes with git");
  const end = description.indexOf("# Creating pull requests", start);
  if (start === -1 || end === -1) {
    throw new Error("Expected shell description to include commit guidance");
  }
  return description.slice(start, end).trim();
}

describe("Codex unified exec toolset", () => {
  test("uses Codex exec_command/write_stdin instead of shell_command", () => {
    expect(OPENAI_DEFAULT_TOOLS).toContain("exec_command");
    expect(OPENAI_DEFAULT_TOOLS).toContain("write_stdin");
    expect(OPENAI_DEFAULT_TOOLS).not.toContain("shell_command");
    expect(OPENAI_DEFAULT_TOOLS).toContain("Task");
    expect(OPENAI_DEFAULT_TOOLS).toContain("TaskOutput");
    expect(OPENAI_DEFAULT_TOOLS).not.toContain("memory_apply_patch");

    expect(OPENAI_PASCAL_TOOLS).toContain("exec_command");
    expect(OPENAI_PASCAL_TOOLS).toContain("write_stdin");
    expect(OPENAI_PASCAL_TOOLS).not.toContain("ShellCommand");
    expect(OPENAI_PASCAL_TOOLS).not.toContain("memory_apply_patch");
  });

  test("documents LC-specific omission of upstream sandbox fields", () => {
    const properties = Object.keys(ExecCommandSchema.properties);

    expect(properties).toContain("description");
    expect(properties).not.toContain("sandbox_permissions");
    expect(properties).not.toContain("justification");
    expect(properties).not.toContain("prefix_rule");
    expect(properties).not.toContain("additional_permissions");
  });

  test("keeps unified exec tool descriptions aligned with Codex plus LC commit guidance", () => {
    const execCommandDescription = [
      "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
      "",
      "For ordinary one-shot commands, omit `yield_time_ms` and let the default wait for completion; set `yield_time_ms` only when intentionally returning early from a long-running or interactive command.",
      "",
      "Provide the required `description` field as a clear, concise user-facing status label for what the command does. It may be shown directly in chat with no prefix, so make it grammatical by itself and avoid tense-dependent wording. Use an imperative or purpose phrase like `Find debug log entries` or `Search recent logs for errors`. Describe the command's purpose, not its shell syntax. Keep it brief for simple commands; add only enough context to clarify commands that are hard to parse at a glance.",
      "",
      extractCommitGuidance(ShellDescription),
    ].join("\n");

    expect(TOOL_DEFINITIONS.exec_command.description).toBe(
      process.platform === "win32"
        ? [
            execCommandDescription,
            "",
            "Windows safety rules:",
            "- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to `cmd /c`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as `Remove-Item` / `Move-Item` with `-LiteralPath`, and avoid string-built shell commands for file operations.",
            "- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.",
            "- When using `Start-Process` to launch a background helper or service, pass `-WindowStyle Hidden` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.",
          ].join("\n")
        : execCommandDescription,
    );
    expect(TOOL_DEFINITIONS.write_stdin.description).toBe(
      "Writes characters to an existing unified exec session and returns recent output.",
    );
  });
});
