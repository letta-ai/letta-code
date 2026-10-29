import { afterEach, describe, expect, test } from "bun:test";
import { resetMcpOriginatorAuthority } from "@/agent/mcp-originator-authority";
import {
  clearMcpOriginatorTokens,
  setMcpOriginatorToken,
} from "@/agent/mcp-originator-tokens";
import type { UnifiedMcpClient } from "@/backend/api/unified-mcp";
import {
  callAgentMcpTool,
  type McpSubcommandDependencies,
} from "@/cli/subcommands/mcp";
import { runWithRuntimeContext } from "@/runtime-context";
import { updateToolExecutionContextMcpOriginator } from "@/tools/execution-context-mcp-originator";
import {
  captureToolExecutionContext,
  getExecutionContextById,
  releaseToolExecutionContext,
} from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import { createRuntime } from "./lifecycle";
import { getEffectiveMcpOriginatorId } from "./mcp-originator-scope";
import { handleApprovalStop } from "./turn-approval";
import { createTurnDurabilityOwnership } from "./turn-durability-ownership";
import { createQueuedTurnConsumer } from "./turn-finalizer";
import type { IncomingMessage } from "./types";

/**
 * Steering: when a running turn sends its next request to the model (here,
 * the continuation after a tool returns), every input queued meanwhile goes
 * with it. Senders' Super Runs and MCP originator tokens must not hold an
 * input back; MCP access is enforced per call instead, and a turn that mixes
 * Super Runs makes its MCP calls without an originator token.
 *
 * Only the tool executor, the model send, and the Cloud MCP endpoint are
 * stubbed. The queue, the drain, the origin swap, the token store, the tool
 * execution context, and the MCP call path are the real implementations.
 */

const TOKENS: Record<string, string> = {
  "run-A": "mst_a.secret-a",
  "run-B": "mst_b.secret-b",
  "run-C": "mst_c.secret-c",
};

const contextIds: string[] = [];
afterEach(() => {
  clearMcpOriginatorTokens();
  resetMcpOriginatorAuthority();
  for (const id of contextIds.splice(0)) releaseToolExecutionContext(id);
});

function input(content: string, superRunId?: string): IncomingMessage {
  return {
    type: "message",
    agentId: "agent-1",
    conversationId: "conv-1",
    ...(superRunId
      ? { mcpOriginatorSuperRunId: superRunId, mcpOriginatorTokenPresent: true }
      : {}),
    messages: [{ role: "user", content }],
  };
}

/** Runs one tool call of a turn started by `original`; `queued` arrives mid-tool. */
async function runToolReturnContinuation(
  original: IncomingMessage,
  queued: IncomingMessage[],
) {
  for (const [runId, token] of Object.entries(TOKENS)) {
    setMcpOriginatorToken(runId, token);
  }
  const runtime = getOrCreateScopedRuntime(
    createRuntime(),
    "agent-1",
    "conv-1",
  );
  const lease = runtime.turnLifecycle.begin({
    origin: "message",
    workingDirectory: process.cwd(),
  });
  // Bind the turn's tool context to the original input, as turn setup does.
  const { contextId } = captureToolExecutionContext(process.cwd());
  contextIds.push(contextId);
  updateToolExecutionContextMcpOriginator(
    contextId,
    getEffectiveMcpOriginatorId(original) ?? null,
  );
  const ownership = createTurnDurabilityOwnership();
  ownership.recordInput(original);
  const modelRequests: unknown[] = [];
  const approval = { toolCallId: "call-1", toolName: "Bash", toolArgs: "{}" };

  const result = await handleApprovalStop({
    approvals: [approval],
    runtime,
    socket: {
      kind: "local",
      bufferedAmount: 0,
      isOpen: () => true,
      send: () => {},
    },
    agentId: "agent-1",
    conversationId: "conv-1",
    turnWorkingDirectory: process.cwd(),
    turnPermissionModeState: { mode: "strict" },
    dequeuedBatchId: "original-batch",
    msgRunIds: [],
    turnInput: { messages: [] },
    pendingNormalizationInterruptedToolCallIds: [],
    turnToolContextId: contextId,
    turnLease: lease,
    ...createQueuedTurnConsumer({
      parkedInput: original,
      turnToolContextId: contextId,
      runtime,
      ownership,
      interruptedRevisionRef: { current: undefined },
      recoveryEvidenceWriter: () => "revision",
    }),
    processOwnedTurn: true,
    buildSendOptions: () => ({}) as never,
    dependencies: {
      classifyApprovals: async () => ({
        autoAllowed: [{ approval, parsedArgs: {}, context: null }],
        autoDenied: [],
        needsUserInput: [],
      }),
      executeApprovalBatch: async () => {
        // The other senders' inputs arrive while the tool is running.
        for (const message of queued) {
          enqueueInboundUserMessage(runtime, message, undefined);
        }
        return [
          {
            type: "tool" as const,
            tool_call_id: "call-1",
            status: "success" as const,
            tool_return: "tool-result",
          },
        ];
      },
      ensureSecretsHydrated: async () => {},
      sendApprovalContinuation: async (_id: string, messages: unknown) => {
        modelRequests.push(messages);
        return {
          kind: "terminal",
          drainResult: { stopReason: "end_turn", apiDurationMs: 0 },
        };
      },
    } as never,
  });
  expect(result.kind).toBe("terminal");
  return { runtime, contextId, modelRequests };
}

/** Makes one MCP call from the turn's tool context; returns the headers sent. */
async function nextMcpCallHeaders(contextId: string) {
  const context = getExecutionContextById(contextId);
  if (!context) throw new Error("tool context was released");
  const sentHeaders: Array<Record<string, string> | undefined> = [];
  const client: UnifiedMcpClient = {
    get: async (path) =>
      path.endsWith("/mcp-servers")
        ? [
            {
              id: "mcp-1",
              server_name: "github",
              mcp_server_type: "streamable_http",
              server_url: "https://mcp.example.com/mcp",
            },
          ]
        : [
            {
              id: "tool-1",
              name: "mcp__github__create_issue",
              json_schema: { parameters: { type: "object" } },
            },
          ],
    post: async (_path, options) => {
      sentHeaders.push(options?.headers);
      return { status: "success", func_return: "ok" };
    },
  };
  const deps: McpSubcommandDependencies = {
    env: { LETTA_AGENT_ID: "agent-1" },
    initializeSettings: async () => {},
    isServerMcpAvailable: () => true,
    getLocalServers: () => [],
    getClient: async () => client,
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await runWithRuntimeContext(context.runtimeContext, () =>
      callAgentMcpTool("agent-1", "mcp__github__create_issue", {}, deps),
    );
  } finally {
    console.warn = originalWarn;
  }
  expect(sentHeaders).toHaveLength(1);
  return sentHeaders[0];
}

describe("steering drains queued inputs into the next model request", () => {
  for (const originalRun of [undefined, "run-A"] as const) {
    for (const queuedRun of [undefined, "run-A", "run-B"] as const) {
      test(`turn from ${originalRun ?? "no originator"}, queued input from ${queuedRun ?? "no originator"}`, async () => {
        const { runtime, contextId, modelRequests } =
          await runToolReturnContinuation(input("original", originalRun), [
            input("steer", queuedRun),
          ]);

        // The queued input rides the continuation right after the tool return.
        expect(modelRequests).toHaveLength(1);
        const request = JSON.stringify(modelRequests[0]);
        expect(request).toContain("tool-result");
        expect(request).toContain('"steer"');
        expect(runtime.queueRuntime.length).toBe(0);
        expect(runtime.queuedMessagesByItemId.size).toBe(0);

        // Only a turn whose inputs all come from one Super Run keeps its token.
        const headers = await nextMcpCallHeaders(contextId);
        if (originalRun && originalRun === queuedRun) {
          expect(headers?.["x-letta-mcp-originator-token"]).toBe(
            TOKENS[originalRun],
          );
        } else {
          expect(headers).toBeUndefined();
        }
      });
    }
  }

  test("inputs from several Super Runs all drain and the turn sends no token", async () => {
    const { runtime, contextId, modelRequests } =
      await runToolReturnContinuation(input("original", "run-A"), [
        input("steer-B", "run-B"),
        input("steer-none"),
        input("steer-C", "run-C"),
      ]);

    expect(modelRequests).toHaveLength(1);
    const request = JSON.stringify(modelRequests[0]);
    for (const content of ["steer-B", "steer-none", "steer-C"]) {
      expect(request).toContain(`"${content}"`);
    }
    expect(runtime.queueRuntime.length).toBe(0);
    expect(await nextMcpCallHeaders(contextId)).toBeUndefined();
  });
});
