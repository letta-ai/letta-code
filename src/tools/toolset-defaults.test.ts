import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";
import { clearCapturedToolExecutionContexts } from "./manager";
import { TOOL_PERMISSIONS } from "./tool-permissions";
import { prepareToolExecutionContextForResolvedTarget } from "./toolset";

afterEach(() => {
  clearCapturedToolExecutionContexts();
  permissionMode.reset();
  sessionPermissions.clear();
});

test("each nonempty preset exposes SendAgentMessage in the model's tool payload", async () => {
  for (const toolsetPreference of [
    "letta",
    "default",
    "codex",
    "codex_snake",
    "gemini",
    "gemini_snake",
  ] as const) {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference,
    });
    expect(
      prepared.preparedToolContext.clientTools.filter(
        (tool) => tool.name === "SendAgentMessage",
      ),
    ).toHaveLength(1);
  }
});

test("none and explicit client allowlists still exclude the tool", async () => {
  const none = await prepareToolExecutionContextForResolvedTarget({
    toolsetPreference: "none",
  });
  expect(none.preparedToolContext.loadedToolNames).not.toContain(
    "SendAgentMessage",
  );
  const limited = await prepareToolExecutionContextForResolvedTarget({
    toolsetPreference: "letta",
    clientToolAllowlist: ["Read"],
  });
  expect(limited.preparedToolContext.loadedToolNames).toEqual(["Read"]);
});

test("standard and strict modes ask; explicit denial remains effective", () => {
  expect(TOOL_PERMISSIONS.SendAgentMessage.requiresApproval).toBe(true);
  const args = { conversation_id: "conv-target", message: "hello" };
  for (const mode of ["standard", "strict"] as const) {
    permissionMode.setMode(mode);
    expect(
      checkPermission(
        "SendAgentMessage",
        args,
        { allow: [], deny: [], ask: [] },
        process.cwd(),
      ).decision,
    ).toBe("ask");
  }
  permissionMode.setMode("standard");
  expect(
    checkPermission(
      "SendAgentMessage",
      args,
      { allow: [], deny: ["SendAgentMessage"], ask: [] },
      process.cwd(),
    ).decision,
  ).toBe("deny");
});
