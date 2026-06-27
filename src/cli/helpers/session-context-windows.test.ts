import { describe, expect, test } from "bun:test";

import { buildWindowsShellNotes } from "@/cli/helpers/session-context";

describe("Session Context Windows Notes", () => {
  test("Windows shell notes contain heredoc warning", () => {
    const windowsShellNotes = buildWindowsShellNotes({
      family: "powershell",
      displayName: "PowerShell 7",
    });

    expect(windowsShellNotes).toContain("HEREDOC");
    expect(windowsShellNotes).toContain("does NOT work on Windows");
  });

  test("Windows shell notes mention the detected shell", () => {
    const windowsShellNotes = buildWindowsShellNotes({
      family: "powershell",
      displayName: "PowerShell 7",
    });

    expect(windowsShellNotes).toContain("Detected shell: PowerShell 7");
    expect(windowsShellNotes).toContain("PowerShell-safe commands");
  });

  test("Windows shell notes provide alternative for multiline strings", () => {
    const windowsShellNotes = buildWindowsShellNotes({
      family: "cmd",
      displayName: "Command Prompt",
    });

    expect(windowsShellNotes).toContain("simple quoted strings");
  });
});
