import { afterEach, describe, expect, test } from "bun:test";
import { classifyApprovals } from "@/cli/helpers/approval-classification";
import {
  clearExtensionPermissions,
  registerExtensionPermission,
} from "@/extensions/permission-registry";
import { permissionMode } from "@/permissions/mode";
import { loadTools } from "@/tools/manager";

describe("classifyApprovals", () => {
  const originalMemoryDir = process.env.MEMORY_DIR;

  afterEach(() => {
    clearExtensionPermissions();
    permissionMode.reset();
    if (originalMemoryDir === undefined) {
      delete process.env.MEMORY_DIR;
    } else {
      process.env.MEMORY_DIR = originalMemoryDir;
    }
  });

  test("reports missing Bash command as validation error before memory-mode denial", async () => {
    await loadTools();
    permissionMode.setMode("memory");
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

  test("extension permission overlays deny before unrestricted auto-allow", async () => {
    permissionMode.setMode("unrestricted");
    registerExtensionPermission({
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
      getContext: () => {
        throw new Error("unused");
      },
      isAvailable: () => true,
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
      matchedRule: "extension permission:block-dangerous-shell",
      reason: "rm is blocked",
    });
  });

  test("extension permission overlays allow scoped tools before default ask", async () => {
    registerExtensionPermission({
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
      getContext: () => {
        throw new Error("unused");
      },
      isAvailable: () => true,
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
      matchedRule: "extension permission:allow-plan-file",
      reason: "active plan file",
    });
  });
});
