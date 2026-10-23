import { afterEach, describe, expect, test } from "bun:test";
import { APIError } from "@letta-ai/letta-client/core/error";
import { AutomaticApprovalRetryChangedError } from "@/agent/automatic-approval-retry";
import { STALE_APPROVAL_RECOVERY_DENIAL_REASON } from "@/agent/turn-recovery-policy";
import { __testSetBackend, getBackend } from "@/backend";
import { FakeHeadlessBackend } from "@/backend/dev/fake-headless-backend";
import { createAssistantMessageStream } from "@/backend/dev/headless-turn-executor";
import { prepareToolExecutionContextForSpecificTools } from "@/tools/manager";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { createRuntime } from "./lifecycle";
import { clearConversationRuntimeState } from "./runtime";
import {
  sendApprovalContinuationWithRetry,
  sendMessageStreamWithRetry,
} from "./send";
import type { ListenerTransport } from "./transport";

const originalBackend = getBackend();
afterEach(() => __testSetBackend(originalBackend));
const transport: ListenerTransport = {
  kind: "local",
  bufferedAmount: 0,
  isOpen: () => true,
  send: () => {},
};

describe("listener automatic approval busy retries", () => {
  for (const surface of ["message", "continuation"] as const) {
    test.each(["changed", "stable", "reset", "unavailable"] as const)(
      `${surface} reconciles %s pending state before another POST`,
      async (mode) => {
        const runtime = getOrCreateScopedRuntime(
          createRuntime(),
          "agent-auto-retry",
          "conv-auto-retry",
        );
        const lease = runtime.turnLifecycle.begin({
          origin: "approval_recovery",
          workingDirectory: process.cwd(),
        });
        const backend = new FakeHeadlessBackend("agent-auto-retry");
        let posts = 0;
        const input: Parameters<typeof sendMessageStreamWithRetry>[1] = [
          {
            type: "approval",
            otid: "automatic-denial-identity",
            approvals: [
              {
                type: "approval",
                tool_call_id: "A3",
                approve: false,
                reason: STALE_APPROVAL_RECOVERY_DENIAL_REASON,
              },
            ],
          },
        ];
        const originalInput = structuredClone(input);
        backend.createConversationMessageStream = async () => {
          posts++;
          if (posts === 1)
            throw new APIError(
              409,
              {
                detail:
                  "Another request (run_id=run-blocker) is currently being processed for this conversation.",
              },
              "busy",
              new Headers(),
            );
          return createAssistantMessageStream();
        };
        backend.streamConversationMessages = async () => {
          throw new APIError(404, {}, "OTID not accepted", new Headers());
        };
        backend.retrieveRun = async (id) =>
          ({ id, status: "completed" }) as Awaited<
            ReturnType<typeof backend.retrieveRun>
          >;
        const retrieveAgent = backend.retrieveAgent.bind(backend);
        backend.retrieveAgent = async (id) => {
          if (mode === "unavailable")
            throw new Error("pending read unavailable");
          if (mode === "reset") clearConversationRuntimeState(runtime);
          return {
            ...(await retrieveAgent(id)),
            message_ids: ["pending-message"],
          };
        };
        backend.retrieveConversation = async () =>
          ({
            id: "conv-auto-retry",
            in_context_message_ids: ["pending-message"],
          }) as Awaited<ReturnType<typeof backend.retrieveConversation>>;
        backend.retrieveMessage = async () => [
          {
            id: "pending-message",
            date: "2026-01-01T00:00:00Z",
            message_type: "approval_request_message",
            tool_call: {
              tool_call_id: mode === "changed" ? "A1" : "A3",
              name: "UpdatePlan",
              arguments: "{}",
            },
            tool_calls: [
              {
                tool_call_id: mode === "changed" ? "A1" : "A3",
                name: "UpdatePlan",
                arguments: "{}",
              },
            ],
          },
        ];
        __testSetBackend(backend);
        const preparedToolContext =
          await prepareToolExecutionContextForSpecificTools([], {});
        const send =
          surface === "message"
            ? sendMessageStreamWithRetry
            : sendApprovalContinuationWithRetry;
        const result = send(
          "conv-auto-retry",
          input,
          {
            agentId: "agent-auto-retry",
            preparedToolContext,
            skillSources: [],
          },
          transport,
          runtime,
          lease,
        );
        if (mode === "stable") {
          await result;
          expect(posts).toBe(2);
        } else {
          if (mode === "changed")
            await expect(result).rejects.toBeInstanceOf(
              AutomaticApprovalRetryChangedError,
            );
          else
            await expect(result).rejects.toThrow(
              mode === "reset"
                ? "Cancelled by user"
                : "pending read unavailable",
            );
          expect(posts).toBe(1);
        }
        expect(input).toEqual(originalInput);
      },
    );
  }
});
