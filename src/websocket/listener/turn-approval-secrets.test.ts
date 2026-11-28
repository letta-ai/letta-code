import { expect, test } from "bun:test";
import {
  prepareCurrentToolExecutionContext,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { registerRuntimeExternalTools } from "./external-tools";
import { createRuntime } from "./lifecycle";
import { handleApprovalStop } from "./turn-approval";

test.each([
  { batch: "external", tools: ["publish_update"], order: ["execute"] },
  { batch: "local", tools: ["Bash"], order: ["hydrate", "execute"] },
  {
    batch: "mixed",
    tools: ["publish_update", "Bash"],
    order: ["hydrate", "execute"],
  },
])(
  "$batch approvals respect the secrets hydration boundary",
  async ({ tools, order }) => {
    const listener = createRuntime();
    const scope = { agent_id: "agent-1", conversation_id: "conv-1" };
    const runtime = getOrCreateScopedRuntime(
      listener,
      scope.agent_id,
      scope.conversation_id,
    );
    registerRuntimeExternalTools(listener, "connection-1", scope, [
      {
        tools: [
          {
            name: "publish_update",
            description: "Publish an update",
            parameters: {},
          },
        ],
      },
    ]);
    const { contextId } = await prepareCurrentToolExecutionContext({
      runtimeContext: {
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
      },
    });
    try {
      const approvals = tools.map((toolName) => ({
        toolCallId: `call-${toolName}`,
        toolName,
        toolArgs: "{}",
      }));
      const stages: string[] = [];
      const turnLease = runtime.turnLifecycle.begin({
        origin: "message",
        workingDirectory: process.cwd(),
        initialStatus: "PROCESSING_API_RESPONSE",
      });
      const stopped = new Error("Stopped at the execution boundary");
      const result = handleApprovalStop({
        approvals,
        runtime,
        socket: {
          kind: "runtime",
          bufferedAmount: 0,
          isOpen: () => true,
          send: () => {},
        },
        agentId: scope.agent_id,
        conversationId: scope.conversation_id,
        turnWorkingDirectory: process.cwd(),
        turnPermissionModeState: { mode: "strict" },
        dequeuedBatchId: "batch-1",
        msgRunIds: [],
        turnInput: { messages: [] },
        pendingNormalizationInterruptedToolCallIds: [],
        turnToolContextId: contextId,
        turnLease,
        buildSendOptions: () => ({ streamTokens: true, background: true }),
        dependencies: {
          classifyApprovals: async () => ({
            autoAllowed: approvals.map((approval) => ({
              approval,
              parsedArgs: {},
              context: null,
              permission: { decision: "allow" },
            })),
            autoDenied: [],
            needsUserInput: [],
          }),
          ensureSecretsHydrated: async () => {
            await Promise.resolve();
            stages.push("hydrate");
          },
          executeApprovalBatch: async () => {
            stages.push("execute");
            throw stopped;
          },
          recordListenerWork: () => {},
        },
      });
      await expect(result).rejects.toBe(stopped);
      expect(stages).toEqual([...order]);
    } finally {
      releaseToolExecutionContext(contextId);
      registerRuntimeExternalTools(listener, "connection-1", scope);
    }
  },
);
