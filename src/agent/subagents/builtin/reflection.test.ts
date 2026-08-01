import { describe, expect, test } from "bun:test";
import reflectionPrompt from "./reflection.md";

describe("reflection prompt shell guidance", () => {
  test("gives native Windows alternatives for terminal operations", () => {
    expect(reflectionPrompt).toContain(
      "the tool runs native PowerShell or cmd.exe on Windows",
    );
    expect(reflectionPrompt).toContain(
      "(Get-Item -LiteralPath $env:TRANSCRIPT_PATH).Length",
    );
    expect(reflectionPrompt).toContain("Join-Path $env:MEMORY_DIR");
    expect(reflectionPrompt).toContain("Get-Content");
    expect(reflectionPrompt).toContain("single-quoted here-string");
    expect(reflectionPrompt).toContain(
      "Set-Content -LiteralPath <path> -Encoding utf8",
    );
    expect(reflectionPrompt).toContain("check `$LASTEXITCODE` explicitly");
  });
});
