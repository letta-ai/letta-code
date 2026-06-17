import { describe, expect, test } from "bun:test";
import BashDescription from "@/tools/descriptions/Bash.md";
import {
  buildBashDescriptionForPlatform,
  TOOL_DEFINITIONS,
} from "@/tools/tool-definitions";

describe("Bash Windows tool description", () => {
  test("keeps the base Bash description unchanged on non-Windows platforms", () => {
    const baseDescription = BashDescription.trim();

    expect(buildBashDescriptionForPlatform("darwin")).toBe(baseDescription);
    expect(buildBashDescriptionForPlatform("linux")).toBe(baseDescription);
  });

  test("appends Windows shell semantics and safety guidance on Windows", () => {
    const description = buildBashDescriptionForPlatform("win32");

    expect(description.startsWith(BashDescription.trim())).toBe(true);
    expect(description).toContain("Windows execution:");
    expect(description).toContain("does not run commands through bash");
    expect(description).toContain("PowerShell Core (`pwsh`)");
    expect(description).toContain("Windows PowerShell");
    expect(description).toContain("`cmd.exe` as fallback");
    expect(description).toContain("PowerShell-compatible syntax");
    expect(description).toContain("heredocs");
    expect(description).toContain("`export VAR=...`");
    expect(description).toContain("`$env:MEMORY_DIR`");
    expect(description).toContain("Join-Path $env:MEMORY_DIR 'profile.png'");
    expect(description).toContain("Windows safety rules:");
    expect(description).toContain("`Remove-Item` / `Move-Item`");
    expect(description).toContain("`Start-Process`");
  });

  test("tool definition uses the platform-aware Bash description", () => {
    expect(TOOL_DEFINITIONS.Bash.description).toBe(
      buildBashDescriptionForPlatform(process.platform),
    );
  });
});
