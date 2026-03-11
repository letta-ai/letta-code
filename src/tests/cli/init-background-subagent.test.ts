import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildInitMessage,
  buildShallowInitPrompt,
} from "../../cli/helpers/initCommand";

describe("init wiring", () => {
  const readSource = (relativePath: string) =>
    readFileSync(
      fileURLToPath(new URL(relativePath, import.meta.url)),
      "utf-8",
    );

  test("App.tsx checks pending approvals before /init runs", () => {
    const appSource = readSource("../../cli/App.tsx");

    const approvalIdx = appSource.indexOf(
      "checkPendingApprovalsForSlashCommand",
      appSource.indexOf('trimmed === "/init"'),
    );
    const initMessageIdx = appSource.indexOf(
      "buildInitMessage",
      appSource.indexOf('trimmed === "/init"'),
    );
    expect(approvalIdx).toBeGreaterThan(-1);
    expect(initMessageIdx).toBeGreaterThan(-1);
    expect(approvalIdx).toBeLessThan(initMessageIdx);
  });

  test("App.tsx uses processConversation for /init", () => {
    const appSource = readSource("../../cli/App.tsx");

    expect(appSource).toContain("buildInitMessage({");
    expect(appSource).toContain("processConversation(");
  });

  test("initCommand.ts exports all helpers", () => {
    const helperSource = readSource("../../cli/helpers/initCommand.ts");

    expect(helperSource).toContain("export function hasActiveInitSubagent(");
    expect(helperSource).toContain("export function gatherGitContext()");
    expect(helperSource).toContain("export function buildShallowInitPrompt(");
    expect(helperSource).toContain("export function buildInitMessage(");
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

  test("buildShallowInitPrompt produces shallow-only prompt", () => {
    const prompt = buildShallowInitPrompt(baseArgs);
    expect(prompt).toContain("research_depth: shallow");
    expect(prompt).toContain("Shallow init");
    expect(prompt).not.toContain("Deep init");
  });

  test("buildInitMessage includes memoryDir when provided", () => {
    const msg = buildInitMessage({
      gitContext: "## Git\nsome info",
      memoryDir: "/tmp/.memory",
    });
    expect(msg).toContain("Memory filesystem is enabled");
    expect(msg).toContain("/tmp/.memory");
    expect(msg).toContain("initializing-memory");
  });

  test("buildInitMessage works without memoryDir", () => {
    const msg = buildInitMessage({
      gitContext: "## Git\nsome info",
    });
    expect(msg).not.toContain("Memory filesystem");
    expect(msg).toContain("initializing-memory");
  });
});
