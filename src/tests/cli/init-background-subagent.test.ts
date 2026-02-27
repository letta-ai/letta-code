import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("init background subagent wiring", () => {
  test("App.tsx spawns a background init subagent with guard", () => {
    const appPath = fileURLToPath(
      new URL("../../cli/App.tsx", import.meta.url),
    );
    const appSource = readFileSync(appPath, "utf-8");

    expect(appSource).toContain("hasActiveInitSubagent()");
    expect(appSource).toContain("buildMemoryInitRuntimePrompt({");
    expect(appSource).toContain("spawnBackgroundSubagentTask({");
    expect(appSource).toContain('subagentType: "init"');
    expect(appSource).toContain(
      "Memory initialization started in background.",
    );
  });

  test("init.md exists as a builtin subagent", () => {
    const initMdPath = fileURLToPath(
      new URL("../../agent/subagents/builtin/init.md", import.meta.url),
    );
    const content = readFileSync(initMdPath, "utf-8");

    expect(content).toContain("name: init");
    expect(content).toContain("skills: initializing-memory");
    expect(content).toContain("permissionMode: bypassPermissions");
  });

  test("init subagent is registered in BUILTIN_SOURCES", () => {
    const indexPath = fileURLToPath(
      new URL("../../agent/subagents/index.ts", import.meta.url),
    );
    const indexSource = readFileSync(indexPath, "utf-8");

    expect(indexSource).toContain(
      'import initAgentMd from "./builtin/init.md"',
    );
    expect(indexSource).toContain("initAgentMd");
  });
});
