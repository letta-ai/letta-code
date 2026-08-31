import { describe, expect, test } from "bun:test";
import { createToolLoopGuard } from "@/agent/tool-loop-guard";
import { classifyApprovals } from "@/cli/helpers/approval-classification";

const workingDirectory = "/workspace/project";

function approval(command: string) {
  return {
    toolCallId: crypto.randomUUID(),
    toolName: "Bash",
    toolArgs: JSON.stringify({ command }),
  };
}

describe("classifyApprovals tool loop guard", () => {
  test("requires user input before a fifth unrestricted execution", async () => {
    const guard = createToolLoopGuard();
    const repeatedApproval = approval("git status");
    const call = {
      toolName: repeatedApproval.toolName,
      toolArgs: repeatedApproval.toolArgs,
      workingDirectory,
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      guard.observeResult(call, {
        status: "success",
        toolReturn: "fatal: not a git repository",
      });
    }

    const blocked = await classifyApprovals([repeatedApproval], {
      permissionModeState: { mode: "unrestricted" },
      toolLoopGuard: guard,
      workingDirectory,
    });

    expect(blocked.autoAllowed).toHaveLength(0);
    expect(blocked.needsUserInput).toHaveLength(1);
    expect(blocked.needsUserInput[0]?.toolLoopReason).toContain(
      "stopped after 4 consecutive identical",
    );

    const changed = await classifyApprovals([approval("git status --short")], {
      permissionModeState: { mode: "unrestricted" },
      toolLoopGuard: guard,
      workingDirectory,
    });
    expect(changed.autoAllowed).toHaveLength(1);
    expect(changed.needsUserInput).toHaveLength(0);
  });
});
