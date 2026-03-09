import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("memory subagent recompile wiring", () => {
  test("App.tsx recompiles the parent system prompt from shared memory-subagent completion handling", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain("const handleMemorySubagentComplete = async");
    expect(source).toContain("systemPromptRecompileByAgentRef");
    expect(source).toContain("recompileAgentSystemPrompt(agentId, {");
    expect(source).toContain("updateTimestamp: true");
  });

  test("init and reflection onComplete handlers await shared completion handling before notifying", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const source = readFileSync(appPath, "utf-8");

    expect(source).toContain('subagentType: "init"');
    expect(source).toContain('subagentType: "reflection"');
    expect(source).toContain("await handleMemorySubagentComplete({");
    expect(source).toContain('initDepth: "shallow"');
    expect(source).toContain('initDepth: "deep"');
  });
});
