import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeApprovalBatch } from "@/agent/approval-execution";
import { __testSetBackend, type AgentCreateBody } from "@/backend";
import { LocalBackend } from "@/backend/local";
import type { RuntimeExecutionSettings } from "@/runtime-execution-settings";
import { isolateAmbientLettaTestEnv } from "@/test-utils/test-process-env";
import { getExecutionContextById } from "@/tools/manager";
import { prepareToolExecutionContextForScope } from "@/tools/toolset";
import { prepareSubagentDepth, requireSubagentLaunchSettings } from "./depth";

afterEach(() => __testSetBackend(null));

test("persisted child identity survives store/runtime reconstruction before tool and approval preparation", async () => {
  const restore = isolateAmbientLettaTestEnv();
  const storageDir = await mkdtemp(join(tmpdir(), "subagent-depth-"));
  try {
    const backend = new LocalBackend({
      storageDir,
      executionMode: "deterministic",
    });
    __testSetBackend(backend);
    const agent = await backend.createAgent({
      name: "Parent",
      model: "anthropic/claude-sonnet-4-6",
    } as AgentCreateBody);
    const child = await backend.createConversation({ agent_id: agent.id });
    const sibling = await backend.createConversation({ agent_id: agent.id });
    const settings: RuntimeExecutionSettings = {
      subagent_depth: 1,
      agent_role: "subagent",
      parent_agent_id: "explicitly-authorized-parent",
      tools: ["Agent", "Read"],
      allowed_tools: ["Read"],
      disallowed_tools: ["Write"],
      disable_memory_guard: false,
    };
    const live = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: child.id,
      executionSettings: settings,
    });
    expect(live.preparedToolContext.loadedToolNames).toContain("Agent");
    expect(live.preparedToolContext.loadedToolNames).not.toContain("Write");
    expect(
      Reflect.get(await backend.retrieveConversation(child.id), "is_subagent"),
    ).toBe(true);
    await backend.updateConversation(child.id, { summary: "Updated summary" });

    // A new backend instance reloads the marker from disk. No previous runtime,
    // numeric settings, parent authorization, or client allowlist is supplied.
    __testSetBackend(
      new LocalBackend({ storageDir, executionMode: "deterministic" }),
    );
    await expect(
      prepareToolExecutionContextForScope({
        agentId: agent.id,
        conversationId: child.id,
      }),
    ).rejects.toThrow("Subagent launch restrictions were lost");
    const coldState = await prepareSubagentDepth(
      await backend.retrieveConversation(child.id),
      undefined,
      {},
    );
    expect(coldState.settings?.subagent_depth).toBe(2);
    expect(coldState.settings?.tools).toEqual([]);
    expect(() => requireSubagentLaunchSettings(coldState)).toThrow(
      "Resume this conversation through Agent",
    );
    // Even if stale approval dispatch is attempted with the conservative state,
    // no tool can run. Production stops earlier at the useful recovery error.
    const cold = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: child.id,
      executionSettings: coldState.settings,
    });
    expect(cold.preparedToolContext.loadedToolNames).toEqual([]);
    const restored = getExecutionContextById(cold.preparedToolContext.contextId)
      ?.runtimeContext.executionSettings;
    expect(restored?.subagent_depth).toBe(2);
    expect(restored?.parent_agent_id).toBeUndefined();
    const results = await executeApprovalBatch(
      [
        {
          type: "approve",
          approval: {
            toolCallId: "stale-agent",
            toolName: "Agent",
            toolArgs: JSON.stringify({
              subagent_type: "general-purpose",
              prompt: "must not run",
              description: "blocked",
            }),
          },
        },
      ],
      undefined,
      { toolContextId: cold.preparedToolContext.contextId },
    );
    expect(JSON.stringify(results)).toContain("Tool not found");
    const resumed = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: child.id,
      executionSettings: settings,
    });
    expect(resumed.preparedToolContext.loadedToolNames).toContain("Agent");
    expect(
      getExecutionContextById(resumed.preparedToolContext.contextId)
        ?.runtimeContext.executionSettings?.parent_agent_id,
    ).toBe("explicitly-authorized-parent");

    const root = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: sibling.id,
    });
    expect(root.preparedToolContext.loadedToolNames).toContain("Agent");
    const defaultRoot = await prepareToolExecutionContextForScope({
      agentId: agent.id,
      conversationId: "default",
    });
    expect(defaultRoot.preparedToolContext.loadedToolNames).toContain("Agent");
  } finally {
    restore();
    await rm(storageDir, { recursive: true, force: true });
  }
});

test("persisted parent ancestry fails closed without granting parent memory access", async () => {
  const restored = await prepareSubagentDepth(
    {
      id: "conv-child",
      agent_id: "agent-child",
      parent_agent_id: "agent-parent",
    } as Parameters<typeof prepareSubagentDepth>[0],
    undefined,
    {},
  );
  expect(restored.settings?.subagent_depth).toBe(2);
  expect(restored.settings?.parent_agent_id).toBeUndefined();
  expect(restored.settings?.tools).toEqual([]);
});
