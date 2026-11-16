import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { runWithRuntimeContext } from "@/runtime-context";
import { autoBackgroundExternalTool } from "@/tools/external-tool-background";
import { listenerExternalToolBackgroundOptions } from "@/tools/external-tool-background-eligibility";
import type { ExternalToolDefinition } from "@/tools/external-tool-types";
import {
  backgroundProcesses,
  clearBackgroundProcessCleanup,
} from "@/tools/impl/process_manager";
import {
  clearExternalTools,
  executeTool,
  prepareToolExecutionContextForModel,
  setExternalToolExecutor,
} from "@/tools/manager";
import type { ExternalToolDefinitionPayload } from "@/types/protocol_v2";
import { isRuntimeStartExternalToolsGroup } from "@/websocket/listener/external-tool-protocol";
import { registerRuntimeExternalTools } from "@/websocket/listener/external-tools";
import type { ListenerRuntime } from "@/websocket/listener/types";

const runtimeScope = { agent_id: "agent-1", conversation_id: "conv-1" };
const scope = {
  agentId: "agent-1",
  conversationId: "conv-1",
  actingUserId: "user-1",
};
const baseTool = {
  name: "slow_lookup",
  description: "Look something up",
  parameters: { type: "object", properties: {} },
};

const existingEntries = new Set<string>();
beforeEach(() => {
  clearExternalTools();
  existingEntries.clear();
  for (const id of backgroundProcesses.keys()) existingEntries.add(id);
});
afterEach(() => {
  clearExternalTools();
  for (const [id, entry] of backgroundProcesses) {
    if (existingEntries.has(id)) continue;
    clearBackgroundProcessCleanup(id);
    if (entry.outputFile) rmSync(entry.outputFile, { force: true });
    backgroundProcesses.delete(id);
  }
});

/** Register one tool over the listener and return the definition a call sees. */
async function registerAndCapture(
  tool: ExternalToolDefinitionPayload,
): Promise<ExternalToolDefinition> {
  const runtime = {
    intentionallyClosed: false,
    pendingExternalToolCalls: new Map(),
    connections: new Map(),
  } as unknown as ListenerRuntime;
  registerRuntimeExternalTools(runtime, "client-1", runtimeScope, [
    { tools: [tool] },
  ]);
  let captured: ExternalToolDefinition | undefined;
  setExternalToolExecutor(async (_id, _name, _input, context) => {
    captured = context?.tool;
    return { content: [{ type: "text", text: "ok" }], isError: false };
  });
  const prepared = await prepareToolExecutionContextForModel(
    "anthropic/claude-sonnet-4",
    {
      clientToolAllowlist: [tool.name],
      runtimeContext: {
        connectionId: "client-1",
        agentId: "agent-1",
        conversationId: "conv-1",
      },
    },
  );
  await executeTool(
    tool.name,
    {},
    { toolContextId: prepared.contextId, toolCallId: "call-1" },
  );
  if (!captured) throw new Error("Registered tool was not executed");
  return captured;
}

function registeredYieldMs(tool: ExternalToolDefinition): number | undefined {
  return listenerExternalToolBackgroundOptions(tool, undefined, scope).yieldMs;
}

describe("per-tool foreground yield", () => {
  test("registration accepts positive finite values and rejects the rest", () => {
    for (const foreground_yield_ms of [1_000, 12_000, 500, 60_000]) {
      expect(
        isRuntimeStartExternalToolsGroup({
          tools: [{ ...baseTool, foreground_yield_ms }],
        }),
      ).toBe(true);
    }
    for (const foreground_yield_ms of [0, -1, Number.NaN, Infinity, "5000"]) {
      expect(
        isRuntimeStartExternalToolsGroup({
          tools: [{ ...baseTool, foreground_yield_ms }],
        }),
      ).toBe(false);
    }
  });

  test("a registered value is clamped to 1–30s and omitted values stay unset", async () => {
    expect(
      registeredYieldMs(
        await registerAndCapture({ ...baseTool, foreground_yield_ms: 12_000 }),
      ),
    ).toBe(12_000);
    expect(
      registeredYieldMs(
        await registerAndCapture({ ...baseTool, foreground_yield_ms: 60_000 }),
      ),
    ).toBe(30_000);
    expect(
      registeredYieldMs(
        await registerAndCapture({ ...baseTool, foreground_yield_ms: 200 }),
      ),
    ).toBe(1_000);
    expect(registeredYieldMs(await registerAndCapture(baseTool))).toBe(
      undefined,
    );
  });

  test("the tool's value wins over the conversation's tool policy", async () => {
    const tool = await registerAndCapture({
      ...baseTool,
      foreground_yield_ms: 1_000,
    });
    const startedAt = Date.now();
    const receipt = await runWithRuntimeContext(
      { foregroundYieldMs: 30_000 },
      () =>
        autoBackgroundExternalTool(
          tool.name,
          { autoBackground: true },
          new Promise<never>(() => {}),
          {
            ...listenerExternalToolBackgroundOptions(tool, undefined, scope),
            canBackground: true,
            enqueue: () => {},
          },
        ),
    );
    expect(String(receipt.toolReturn)).toContain("is still running");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });

  test("without a tool value the conversation's tool policy applies", async () => {
    const tool = await registerAndCapture(baseTool);
    const startedAt = Date.now();
    const receipt = await runWithRuntimeContext(
      { foregroundYieldMs: 1_000 },
      () =>
        autoBackgroundExternalTool(
          tool.name,
          { autoBackground: true },
          new Promise<never>(() => {}),
          {
            ...listenerExternalToolBackgroundOptions(tool, undefined, scope),
            canBackground: true,
            enqueue: () => {},
          },
        ),
    );
    expect(String(receipt.toolReturn)).toContain("is still running");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
