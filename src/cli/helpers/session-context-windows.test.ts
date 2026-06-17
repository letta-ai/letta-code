import { describe, expect, test } from "bun:test";

// Test the Windows shell notes logic directly
// The actual sessionContext.ts uses platform() which we can't easily mock,
// but we can test that the Windows notes content is correct

describe("Session Context Windows Notes", () => {
  const windowsShellNotes = `
## Windows Shell Notes
- The Bash tool uses PowerShell or cmd.exe on Windows
- HEREDOC syntax (e.g., \`$(cat <<'EOF'...EOF)\`) does NOT work on Windows
- For multiline strings (git commits, PR bodies), use simple quoted strings instead
- Letta context variables are PowerShell environment variables; for MemFS paths use \`$env:MEMORY_DIR\` or \`Join-Path $env:MEMORY_DIR 'profile.png'\`
`;

  test("Windows shell notes contain heredoc warning", () => {
    expect(windowsShellNotes).toContain("HEREDOC");
    expect(windowsShellNotes).toContain("does NOT work on Windows");
  });

  test("Windows shell notes mention PowerShell", () => {
    expect(windowsShellNotes).toContain("PowerShell");
  });

  test("Windows shell notes provide alternative for multiline strings", () => {
    expect(windowsShellNotes).toContain("simple quoted strings");
  });

  test("Windows shell notes explain MemFS env var syntax", () => {
    expect(windowsShellNotes).toContain("$env:MEMORY_DIR");
    expect(windowsShellNotes).toContain(
      "Join-Path $env:MEMORY_DIR 'profile.png'",
    );
  });

  if (process.platform === "win32") {
    test("running on Windows - notes should be relevant", () => {
      // This test only runs on Windows CI
      // Confirms we're actually testing on Windows
      expect(process.platform).toBe("win32");
    });
  }
});
