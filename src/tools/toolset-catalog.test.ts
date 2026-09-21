import { afterEach, expect, test } from "bun:test";
import { checkPermission } from "@/permissions/checker";
import { permissionMode } from "@/permissions/mode";
import { sessionPermissions } from "@/permissions/session";
import {
  clearCapturedToolExecutionContexts,
  getServerToolName,
} from "./manager";
import { TOOL_DEFINITIONS } from "./tool-definitions";
import { TOOL_PERMISSIONS } from "./tool-permissions";
import { prepareToolExecutionContextForResolvedTarget } from "./toolset";
import { TOOLSET_CATALOG, TOOLSET_OPTIONS } from "./toolset-catalog";

afterEach(() => {
  clearCapturedToolExecutionContexts();
  permissionMode.reset();
  sessionPermissions.clear();
});

test("advertises the supported toolset choices", () => {
  expect(TOOLSET_OPTIONS.map(({ id }) => id)).toEqual([
    "auto",
    "letta",
    "none",
    "default",
    "codex",
  ]);
});

test("client options contain only toolset protocol metadata", () => {
  for (const option of TOOLSET_OPTIONS) {
    expect(Object.keys(option).sort()).toEqual([
      "description",
      "display_name",
      "id",
      "is_featured",
      "label",
    ]);
  }
});

test.each(Object.entries(TOOLSET_CATALOG))(
  "%s contains registered tools with unique model-facing names",
  (_id, { tools }) => {
    for (const tool of tools) {
      expect(Object.hasOwn(TOOL_DEFINITIONS, tool)).toBe(true);
    }
    expect(new Set(tools.map(getServerToolName)).size).toBe(tools.length);
  },
);

test("each nonempty preset exposes SendAgentMessage in the model's tool payload", async () => {
  for (const toolsetPreference of ["letta", "default", "codex"] as const) {
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

test.each(["letta", "default", "codex"] as const)(
  "%s delegates memory through Agent without exposing direct memory tools",
  async (toolsetPreference) => {
    const prepared = await prepareToolExecutionContextForResolvedTarget({
      toolsetPreference,
    });
    const names = prepared.preparedToolContext.clientTools.map(
      (tool) => tool.name,
    );
    expect(names).toContain("Agent");
    expect(names).not.toContain("memory");
    expect(names).not.toContain("memory_apply_patch");
  },
);
