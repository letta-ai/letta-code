import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

describe("init background subagent wiring", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("App.tsx checks pending approvals before either branch", () => {
    const appSource = readSource("../../cli/App.tsx");

    // The approval check must appear before the MemFS branch
    const approvalIdx = appSource.indexOf(
      "checkPendingApprovalsForSlashCommand",
      appSource.indexOf('trimmed === "/init"'),
    );
    const memfsBranchIdx = appSource.indexOf(
      "isMemfsEnabled",
      appSource.indexOf('trimmed === "/init"'),
    );
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(memfsBranchIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeLessThan(memfsBranchIdx);
  });

  test("App.tsx branches on MemFS: background subagent vs legacy processConversation", () => {
    const appSource = readSource("../../cli/App.tsx");

    // MemFS path — background subagent
    expect(appSource).toContain("hasActiveInitSubagent(agentId)");
    expect(appSource).toContain("buildMemoryInitRuntimePrompt({");
    expect(appSource).toContain("spawnBackgroundSubagentTask({");
    expect(appSource).toContain('subagentType: "init"');
    expect(appSource).toContain("initSubagentDescription(agentId)");
    expect(appSource).toContain(
      "Memory initialization started in background.",
    );

    // Legacy non-MemFS path — primary agent
    expect(appSource).toContain("buildLegacyInitMessage({");
    expect(appSource).toContain("processConversation(");
  });

  test("initCommand.ts exports all helpers", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");

    expect(helperSource).toContain(
      "export function hasActiveInitSubagent(",
    );
    expect(helperSource).toContain(
      "export function initSubagentDescription(",
    );
    expect(helperSource).toContain("export function gatherGitContext()");
    expect(helperSource).toContain(
      "export function buildMemoryInitRuntimePrompt(",
    );
    expect(helperSource).toContain(
      "export function buildLegacyInitMessage(",
    );
  });

  test("hasActiveInitSubagent scopes by agentId via description tag", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");

    // Guard filters on agentId tag in description
    expect(helperSource).toContain("agentId: string");
    expect(helperSource).toContain("agent.description.includes(tag)");
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
});
