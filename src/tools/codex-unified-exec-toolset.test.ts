import { describe, expect, test } from "bun:test";
import { OPENAI_DEFAULT_TOOLS, OPENAI_PASCAL_TOOLS } from "@/tools/manager";

describe("Codex unified exec toolset", () => {
  test("uses Codex exec_command/write_stdin instead of shell_command", () => {
    expect(OPENAI_DEFAULT_TOOLS).toContain("exec_command");
    expect(OPENAI_DEFAULT_TOOLS).toContain("write_stdin");
    expect(OPENAI_DEFAULT_TOOLS).not.toContain("shell_command");

    expect(OPENAI_PASCAL_TOOLS).toContain("exec_command");
    expect(OPENAI_PASCAL_TOOLS).toContain("write_stdin");
    expect(OPENAI_PASCAL_TOOLS).not.toContain("ShellCommand");
  });
});
