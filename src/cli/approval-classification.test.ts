import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyApprovals } from "@/cli/helpers/approval-classification";
import {
  clearModPermissions,
  registerModPermission,
} from "@/mods/permission-registry";
import { clearModTools, registerModTool } from "@/mods/tool-registry";
import type { ToolApprovalPolicy } from "@/mods/types";
import {
  resetPermissionLoaderCacheForTests,
  savePermissionRule,
} from "@/permissions/loader";
import { permissionMode } from "@/permissions/mode";
import {
  loadSpecificTools,
  loadTools,
  prepareCurrentToolExecutionContext,
  prepareToolExecutionContextForSpecificTools,
} from "@/tools/manager";

describe("classifyApprovals", () => {
  const originalMemoryDir = process.env.MEMORY_DIR;
  const tempDirs: string[] = [];

  async function createTempProjectWithAlwaysAskRule(): Promise<string> {
    const projectDir = await mkdtemp(join(tmpdir(), "letta-always-ask-"));
    tempDirs.push(projectDir);
    await savePermissionRule(
      "Bash(git push:*)",
      "alwaysAsk",
      "local",
      projectDir,
    );
    return projectDir;
  }

  function registerTestModTool(
    name: string,
    options: {
      approvalPolicy?: ToolApprovalPolicy;
      requiresApproval?: boolean;
    } = {},
  ) {
    registerModTool({
      name,
      description: `${name} test tool`,
      parameters: { type: "object", properties: {} },
      owner: {
        id: `global:/tmp/${name}.ts`,
        path: `/tmp/${name}.ts`,
        scope: "global",
        generation: 1,
      },
      path: `/tmp/${name}.ts`,
      requiresApproval: options.requiresApproval ?? true,
      approvalPolicy:
        options.approvalPolicy ??
        (options.requiresApproval === false ? "auto" : "ask"),
      parallelSafe: false,
      activationSignal: new AbortController().signal,
      run: () => "ok",
    });
  }

  afterEach(async () => {
    clearModPermissions();
    clearModTools();
    resetPermissionLoaderCacheForTests();
    permissionMode.reset();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
    if (originalMemoryDir === undefined) {
      delete process.env.MEMORY_DIR;
    } else {
      process.env.MEMORY_DIR = originalMemoryDir;
    }
  });

  test("reports missing Bash command as validation error before auto-allow", async () => {
    await loadTools();
    permissionMode.setMode("unrestricted");
    process.env.MEMORY_DIR = "/Users/test/.letta/agents/agent-1/memory";

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call_missing_command",
          toolName: "Bash",
          toolArgs: JSON.stringify({
            description: "Push git changes to remote",
          }),
        },
      ],
      {
        requireArgsForAutoApprove: true,
        workingDirectory: "/Users/test/.letta/agents/agent-1/memory",
      },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(1);

    const [denied] = result.autoDenied;
    expect(denied?.missingRequiredArgs).toEqual(["command"]);
    expect(denied?.denyReason).toBe(
      "Bash tool missing required parameter: command. Received parameters: description",
    );
    expect(denied?.permission.reason).toBe(denied?.denyReason);
  });

  test("reports missing exec_command cmd as validation error before auto-allow", async () => {
    await loadSpecificTools(["exec_command"]);
    permissionMode.setMode("unrestricted");

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call_missing_cmd",
          toolName: "exec_command",
          toolArgs: JSON.stringify({
            description: "Wait for command output",
          }),
        },
      ],
      {
        requireArgsForAutoApprove: true,
        workingDirectory: "/tmp/project",
      },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(1);

    const [denied] = result.autoDenied;
    expect(denied?.missingRequiredArgs).toEqual(["cmd"]);
    expect(denied?.denyReason).toBe(
      "exec_command tool missing required parameter: cmd. Received parameters: description",
    );
  });

  test("validates required args against the turn-scoped tool context", async () => {
    await loadTools();
    const { contextId } = await prepareToolExecutionContextForSpecificTools([
      "exec_command",
    ]);
    permissionMode.setMode("unrestricted");

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call_context_missing_cmd",
          toolName: "exec_command",
          toolArgs: JSON.stringify({
            description: "Check diagnostics for broken test mod",
          }),
        },
      ],
      {
        requireArgsForAutoApprove: true,
        toolContextId: contextId,
        workingDirectory: "/tmp/project",
      },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(1);

    const [denied] = result.autoDenied;
    expect(denied?.missingRequiredArgs).toEqual(["cmd"]);
    expect(denied?.denyReason).toBe(
      "exec_command tool missing required parameter: cmd. Received parameters: description",
    );
  });

  test("mod permission overlays deny before unrestricted auto-allow", async () => {
    permissionMode.setMode("unrestricted");
    registerModPermission({
      id: "block-dangerous-shell",
      description: "Block dangerous shell commands",
      path: "/tmp/block-dangerous-shell.ts",
      owner: {
        id: "global:/tmp/block-dangerous-shell.ts",
        path: "/tmp/block-dangerous-shell.ts",
        scope: "global",
        generation: 1,
      },
      activationSignal: new AbortController().signal,
      check(event) {
        if (
          event.toolName === "Bash" &&
          typeof event.args.command === "string" &&
          event.args.command.includes("rm -rf")
        ) {
          return { decision: "deny", reason: "rm is blocked" };
        }
        return undefined;
      },
    });

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-dangerous",
          toolName: "Bash",
          toolArgs: JSON.stringify({ command: "rm -rf /tmp/nope" }),
        },
      ],
      { workingDirectory: "/tmp/project" },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(1);
    expect(result.autoDenied[0]?.permission).toMatchObject({
      decision: "deny",
      matchedRule: "mod permission:block-dangerous-shell",
      reason: "rm is blocked",
    });
  });

  test("mod permission overlays allow scoped tools before default ask", async () => {
    registerModPermission({
      id: "allow-plan-file",
      description: "Allow writes to the active plan file",
      path: "/tmp/allow-plan-file.ts",
      owner: {
        id: "global:/tmp/allow-plan-file.ts",
        path: "/tmp/allow-plan-file.ts",
        scope: "global",
        generation: 1,
      },
      activationSignal: new AbortController().signal,
      check(event) {
        if (
          event.toolName === "Write" &&
          event.args.file_path === "/tmp/plan.md"
        ) {
          return { decision: "allow", reason: "active plan file" };
        }
        return undefined;
      },
    });

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-plan-file",
          toolName: "Write",
          toolArgs: JSON.stringify({
            file_path: "/tmp/plan.md",
            content: "# Plan",
          }),
        },
      ],
      { workingDirectory: "/tmp/project" },
    );

    expect(result.autoDenied).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoAllowed).toHaveLength(1);
    expect(result.autoAllowed[0]?.permission).toMatchObject({
      decision: "allow",
      matchedRule: "mod permission:allow-plan-file",
      reason: "active plan file",
    });
  });

  test("alwaysAsk rules require user input in unrestricted mode", async () => {
    permissionMode.setMode("unrestricted");
    const projectDir = await createTempProjectWithAlwaysAskRule();

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-git-push",
          toolName: "Bash",
          toolArgs: JSON.stringify({ command: "git push origin main" }),
        },
      ],
      { workingDirectory: projectDir },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(1);
    expect(result.needsUserInput[0]?.permission).toMatchObject({
      decision: "alwaysAsk",
      matchedRule: "Bash(git push:*)",
      reason: "Matched alwaysAsk rule",
    });
  });

  test("alwaysRequiresUserInput sees parsed tool args", async () => {
    await loadTools();
    permissionMode.setMode("unrestricted");

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-message-channel-ask",
          toolName: "MessageChannel",
          toolArgs: JSON.stringify({
            action: "ask",
            channel: "slack",
            chat_id: "C123",
            questions: [
              {
                question: "Which branch should I use?",
                header: "Branch",
                options: [
                  { label: "main", description: "Use main" },
                  { label: "feature", description: "Use feature" },
                ],
                multiSelect: false,
              },
            ],
          }),
        },
      ],
      {
        workingDirectory: "/tmp/project",
        alwaysRequiresUserInput: (toolName, parsedArgs) =>
          toolName === "MessageChannel" && parsedArgs.action === "ask",
      },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(1);
    expect(result.needsUserInput[0]?.parsedArgs.action).toBe("ask");
  });

  test("treatAskAsDeny also denies alwaysAsk rules", async () => {
    permissionMode.setMode("unrestricted");
    const projectDir = await createTempProjectWithAlwaysAskRule();

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-git-push",
          toolName: "Bash",
          toolArgs: JSON.stringify({ command: "git push origin main" }),
        },
      ],
      { workingDirectory: projectDir, treatAskAsDeny: true },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(1);
    expect(result.autoDenied[0]?.permission.decision).toBe("alwaysAsk");
    expect(result.autoDenied[0]?.denyReason).toBe(
      "Tool requires approval (headless mode)",
    );
  });

  test("mod tool alwaysAsk policy requires user input in unrestricted mode", async () => {
    permissionMode.setMode("unrestricted");
    registerTestModTool("exit_plan_mode", { approvalPolicy: "alwaysAsk" });

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-exit-plan-mode",
          toolName: "exit_plan_mode",
          toolArgs: JSON.stringify({}),
        },
      ],
      { workingDirectory: "/tmp/project" },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(1);
    expect(result.needsUserInput[0]?.permission).toMatchObject({
      decision: "alwaysAsk",
      matchedRule: "mod tool:exit_plan_mode",
      reason: "Mod tool requires explicit approval",
    });
  });

  test("mod tool alwaysAsk policy uses captured tool context", async () => {
    permissionMode.setMode("unrestricted");
    registerTestModTool("exit_plan_mode", { approvalPolicy: "alwaysAsk" });
    const prepared = await prepareCurrentToolExecutionContext({
      workingDirectory: "/tmp/project",
    });
    clearModTools();

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-exit-plan-mode",
          toolName: "exit_plan_mode",
          toolArgs: JSON.stringify({}),
        },
      ],
      {
        workingDirectory: "/tmp/project",
        toolContextId: prepared.contextId,
      },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(1);
  });

  test("mod tool default ask policy still allows unrestricted auto-approval", async () => {
    permissionMode.setMode("unrestricted");
    registerTestModTool("format_file", { approvalPolicy: "ask" });

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-format-file",
          toolName: "format_file",
          toolArgs: JSON.stringify({}),
        },
      ],
      { workingDirectory: "/tmp/project" },
    );

    expect(result.autoAllowed).toHaveLength(1);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(0);
  });

  test("deny overrides mod tool alwaysAsk policy", async () => {
    permissionMode.setMode("unrestricted");
    registerTestModTool("exit_plan_mode", { approvalPolicy: "alwaysAsk" });
    registerModPermission({
      id: "deny-exit-plan-mode",
      path: "/tmp/deny-exit-plan-mode.ts",
      owner: {
        id: "global:/tmp/deny-exit-plan-mode.ts",
        path: "/tmp/deny-exit-plan-mode.ts",
        scope: "global",
        generation: 1,
      },
      activationSignal: new AbortController().signal,
      check(event) {
        if (event.toolName === "exit_plan_mode") {
          return { decision: "deny", reason: "still planning" };
        }
        return undefined;
      },
    });

    const result = await classifyApprovals(
      [
        {
          toolCallId: "call-exit-plan-mode",
          toolName: "exit_plan_mode",
          toolArgs: JSON.stringify({}),
        },
      ],
      { workingDirectory: "/tmp/project" },
    );

    expect(result.autoAllowed).toHaveLength(0);
    expect(result.needsUserInput).toHaveLength(0);
    expect(result.autoDenied).toHaveLength(1);
    expect(result.autoDenied[0]?.permission).toMatchObject({
      decision: "deny",
      matchedRule: "mod permission:deny-exit-plan-mode",
      reason: "still planning",
    });
  });
});
