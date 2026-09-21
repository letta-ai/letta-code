import { describe, expect, test } from "bun:test";
import ExecCommandSchema from "@/tools/schemas/ExecCommand.json";
import { TOOL_DEFINITIONS } from "@/tools/tool-definitions";
import { TOOLSET_CATALOG } from "@/tools/toolset-catalog";

describe("Codex unified exec toolset", () => {
  test("uses Codex exec_command/write_stdin", () => {
    expect(TOOLSET_CATALOG.codex.tools).toContain("exec_command");
    expect(TOOLSET_CATALOG.codex.tools).toContain("write_stdin");
    expect(TOOLSET_CATALOG.codex.tools).toContain("Monitor");
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
      "If a command is still running when this tool yields, you will receive a notification when it completes. Do not poll the session just to check whether it has finished. Use `write_stdin` only when you need to send input, interrupt the process, or obtain output before you can continue.",
      "",
      "Provide the required `description` field as a clear, concise user-facing status label for what the command does. It may be shown directly in chat with no prefix, so make it grammatical by itself and avoid tense-dependent wording. Use an imperative or purpose phrase like `Find debug log entries` or `Search recent logs for errors`. Describe the command's purpose, not its shell syntax. Keep it brief for simple commands; add only enough context to clarify commands that are hard to parse at a glance.",
      "",
      "# Committing changes with git",
    ].join("\n");
    const description = TOOL_DEFINITIONS.exec_command.description;

    // The Codex intro is pinned verbatim; the LC commit guidance follows it.
    expect(description.startsWith(execCommandDescription)).toBe(true);
    expect(description).not.toContain("# Creating pull requests");

    const windowsRules = [
      "",
      "",
      "Windows safety rules:",
      "- Do not compose destructive filesystem commands across shells. Do not enumerate paths in PowerShell and then pass them to `cmd /c`, batch builtins, or another shell for deletion or moving. Use one shell end-to-end, prefer native PowerShell cmdlets such as `Remove-Item` / `Move-Item` with `-LiteralPath`, and avoid string-built shell commands for file operations.",
      "- Before any recursive delete or move on Windows, verify the resolved absolute target paths stay within the intended workspace or explicitly named target directory. Never issue a recursive delete or move against a computed path if the final target has not been checked.",
      "- When using `Start-Process` to launch a background helper or service, pass `-WindowStyle Hidden` unless the user explicitly asked for a visible interactive window. Use visible windows only for interactive tools the user needs to see or control.",
    ].join("\n");
    expect(description.endsWith(windowsRules)).toBe(
      process.platform === "win32",
    );
    expect(TOOL_DEFINITIONS.write_stdin.description).toContain(
      "create a one-shot scheduled check instead of blocking or polling",
    );
  });
});
