import { afterEach, describe, expect, test } from "bun:test";
import { classifyApprovals } from "@/cli/helpers/approvalClassification";
import { permissionMode } from "@/permissions/mode";
import { loadTools } from "@/tools/manager";

describe("classifyApprovals", () => {
  const originalMemoryDir = process.env.MEMORY_DIR;

  afterEach(() => {
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
});
