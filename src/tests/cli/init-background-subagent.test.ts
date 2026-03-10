import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildInitIntakeMessage,
  buildLegacyMemoryInitRuntimePrompt,
  buildMemoryInitRuntimePrompt,
  INIT_TASK_DESCRIPTION,
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

    expect(initBlock).toContain("suppressReminder: true");
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

  test("init intake reminder is split into dedicated helper file", () => {
    const reminderSource = readSource(
      "../../cli/helpers/initIntakeReminder.ts",
    );
    expect(reminderSource).toContain("INIT_INTAKE_QUESTION_GUIDANCE");
    expect(reminderSource).toContain("buildInitIntakeReminder");
    expect(reminderSource).toContain("Which contributor are you?");
    expect(reminderSource).toContain(
      "Are there other repositories I should know about",
    );
  });

  test("init task descriptions are centralized in shared helper", () => {
    const identitySource = readSource("../../cli/helpers/initTaskIdentity.ts");
    expect(identitySource).toContain("export const INIT_TASK_DESCRIPTION");
    expect(identitySource).toContain(
      "export function isKnownActiveInitTaskDescription",
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

  test("buildInitIntakeMessage includes both dispatch modes and one stable task description", () => {
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
    expect(memfsMessage).not.toContain("silent_completion");
    expect(legacyMessage).not.toContain("silent_completion");
    expect(legacyMessage).toContain('agent_id: "test-agent"');
    expect(memfsMessage).toContain(INIT_TASK_DESCRIPTION);
    expect(legacyMessage).toContain(INIT_TASK_DESCRIPTION);
    expect(memfsMessage).toContain("Research depth (required)");
    expect(memfsMessage).toContain("How proactive should I be?");
  });

  test("Task schema does not expose silent_completion", () => {
    const schemaSource = readSource("../../tools/schemas/Task.json");
    const schema = JSON.parse(schemaSource) as {
      properties?: Record<string, unknown>;
    };
    expect(schema.properties?.silent_completion).toBeUndefined();
  });

  test("Task.ts defaults silent completion for init/reflection background workflows", () => {
    const taskSource = readSource("../../tools/impl/Task.ts");
    expect(taskSource).toContain("SILENT_COMPLETION_SUBAGENT_TYPES");
    expect(taskSource).toContain('"init", "reflection"');
    expect(taskSource).toContain("shouldDefaultSilentCompletion");
    expect(taskSource).toContain("isKnownActiveInitTaskDescription");
    expect(taskSource).toContain("BACKGROUND_LINK_TIMEOUT_MS = 5_000");
    expect(taskSource).toContain(
      "waitForBackgroundSubagentLink(\n      subagentId,\n      BACKGROUND_LINK_TIMEOUT_MS,\n      signal,\n    )",
    );
  });

  test("App.tsx contains maybeLaunchDeepInitSubagent", () => {
    const appSource = readSource("../../cli/App.tsx");
    expect(appSource).toContain("maybeLaunchDeepInitSubagent");
    expect(appSource).toContain("Deep memory initialization");
    expect(appSource).toContain('depth: "deep"');
  });
});
