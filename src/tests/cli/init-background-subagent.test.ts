import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildInitIntakeMessage,
  buildLegacyMemoryInitRuntimePrompt,
  buildMemoryInitRuntimePrompt,
  INIT_TASK_DESCRIPTION_DEEP,
  INIT_TASK_DESCRIPTION_STANDARD,
} from "../../cli/helpers/initCommand";

describe("init background subagent wiring", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("App.tsx checks pending approvals before launching /init intake flow", () => {
    const appSource = readSource("../../cli/App.tsx");

    const initStart = appSource.indexOf('trimmed === "/init"');
    const approvalIdx = appSource.indexOf(
      "checkPendingApprovalsForSlashCommand",
      initStart,
    );
    const intakeIdx = appSource.indexOf("buildInitIntakeMessage({", initStart);
    expect(initStart).toBeGreaterThan(-1);
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(intakeIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeLessThan(intakeIdx);
  });

  test("App.tsx uses a unified /init intake path (no direct spawn in command handler)", () => {
    const appSource = readSource("../../cli/App.tsx");
    const initStart = appSource.indexOf('trimmed === "/init"');
    const initBlock = appSource.slice(initStart, initStart + 1800);

    expect(initBlock).toContain("cmd.suppressReminder = true");
    expect(initBlock).toContain("buildInitIntakeMessage({");
    expect(initBlock).toContain("processConversation([");
    expect(initBlock).toContain(
      "autoInitPendingAgentIdsRef.current.delete(agentId)",
    );
    expect(initBlock).not.toContain("buildLegacyInitMessage({");
    expect(initBlock).not.toContain("spawnBackgroundSubagentTask({");
  });

  test("initCommand.ts exports intake + runtime prompt helpers", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");

    expect(helperSource).toContain("export function hasActiveInitSubagent(");
    expect(helperSource).toContain("export function gatherGitContext()");
    expect(helperSource).toContain("export function buildInitIntakeMessage(");
    expect(helperSource).toContain(
      "export function buildMemoryInitRuntimePrompt(",
    );
    expect(helperSource).toContain(
      "export function buildLegacyMemoryInitRuntimePrompt(",
    );
  });

  test("init.md exists as a builtin subagent", () => {
    const content = readSource("../../agent/subagents/builtin/init.md");

    expect(content).toContain("name: init");
    expect(content).toContain("skills: initializing-memory");
    expect(content).toContain("permissionMode: bypassPermissions");
  });

  test("init subagent is registered in BUILTIN_SOURCES", () => {
    const indexSource = readSource("../../agent/subagents/index.ts");

    expect(indexSource).toContain(
      'import initAgentMd from "./builtin/init.md"',
    );
    expect(indexSource).toContain("initAgentMd");
  });

  const baseArgs = {
    agentId: "test-agent",
    workingDirectory: "/tmp/test",
    memoryDir: "/tmp/test/.memory",
    gitContext: "## Git context\nsome git info",
  };

  test('buildMemoryInitRuntimePrompt includes "research_depth: shallow" when depth is "shallow"', () => {
    const prompt = buildMemoryInitRuntimePrompt({
      ...baseArgs,
      depth: "shallow",
      intakeSummary: "- identity: test",
    });
    expect(prompt).toContain("research_depth: shallow");
    expect(prompt).toContain("User intake summary:");
    expect(prompt).toContain("Shallow init");
    expect(prompt).not.toContain("Deep init");
  });

  test('buildMemoryInitRuntimePrompt includes "research_depth: deep" when depth is "deep"', () => {
    const prompt = buildMemoryInitRuntimePrompt({
      ...baseArgs,
      depth: "deep",
    });
    expect(prompt).toContain("research_depth: deep");
    expect(prompt).toContain("Deep init");
    expect(prompt).not.toContain("Shallow init");
  });

  test("buildLegacyMemoryInitRuntimePrompt includes Skill invocation guidance", () => {
    const prompt = buildLegacyMemoryInitRuntimePrompt({
      agentId: "test-agent",
      workingDirectory: "/tmp/test",
      gitContext: "## Git context\nsome git info",
      depth: "shallow",
    });
    expect(prompt).toContain("memory_mode: legacy-api");
    expect(prompt).toContain('Skill({ skill: "initializing-memory" })');
    expect(prompt).toContain("Do not launch additional Task subagents");
  });

  test("buildInitIntakeMessage includes both dispatch modes and exact task descriptions", () => {
    const memfsMessage = buildInitIntakeMessage({
      agentId: "test-agent",
      workingDirectory: "/tmp/test",
      memfsEnabled: true,
      memoryDir: "/tmp/test/.memory",
      gitContext: "## Git context\nsome git info",
    });
    const legacyMessage = buildInitIntakeMessage({
      agentId: "test-agent",
      workingDirectory: "/tmp/test",
      memfsEnabled: false,
      memoryDir: "/tmp/test/.memory",
      gitContext: "## Git context\nsome git info",
    });

    expect(memfsMessage).toContain('subagent_type: "init"');
    expect(legacyMessage).toContain('subagent_type: "general-purpose"');
    expect(memfsMessage).toContain("silent_completion: true");
    expect(legacyMessage).toContain('agent_id: "test-agent"');
    expect(memfsMessage).toContain(INIT_TASK_DESCRIPTION_STANDARD);
    expect(memfsMessage).toContain(INIT_TASK_DESCRIPTION_DEEP);
  });

  test("App.tsx contains maybeLaunchDeepInitSubagent", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("maybeLaunchDeepInitSubagent");
    expect(appSource).toContain("Deep memory initialization");
    expect(appSource).toContain('depth: "deep"');
  });
});
