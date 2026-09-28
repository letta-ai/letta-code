import { randomUUID } from "node:crypto";
import {
  resolveChildSubagent,
  trackChildSend,
} from "@/agent/subagents/child-send-tracking";
import { type Backend, getBackend } from "@/backend";
import {
  buildAgentSendContent,
  normalizeAgentMessageComputer,
  resolveAgentMessageDestination,
  validateAddress,
} from "@/backend/api/agent-message";
import {
  enqueueConversationMessage,
  isProvenCloudApiShutdownRejection,
} from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import {
  getCurrentWorkingDirectory,
  getRuntimeContext,
} from "@/runtime-context";
import { sendClaudeMessage } from "./claude-stream-session";
import { sendCodexMessage } from "./codex-app-server";
import { parseExternalCodingAgentId } from "./external-coding-agent";
import { trackExternalFollowupCompletion } from "./external-coding-agent-task";

interface SendAgentMessageArgs {
  message: string;
  agent_id?: string;
  conversation_id?: string;
  computer?: string | null;
  signal?: AbortSignal;
}

interface SendAgentMessageDeps {
  backend?: Pick<
    Backend,
    | "capabilities"
    | "retrieveConversation"
    | "createConversation"
    | "retrieveAgent"
  >;
  enqueue?: typeof enqueueConversationMessage;
  trackChildSend?: typeof trackChildSend;
  sendClaudeMessage?: typeof sendClaudeMessage;
  sendCodexMessage?: typeof sendCodexMessage;
  trackExternalFollowup?: typeof trackExternalFollowupCompletion;
}

export async function send_agent_message(
  args: SendAgentMessageArgs,
  deps: SendAgentMessageDeps = {},
): Promise<{ content: string; status: "success" | "error" }> {
  const clientMessageId = randomUUID();
  let submissionAttempted = false;
  let destination: { agentId: string; conversationId: string } | undefined;
  try {
    if (!args.message?.trim()) throw new Error("Message must not be empty.");
    const context = getRuntimeContext();
    const senderAgentId = validateAddress(
      context?.agentId ?? undefined,
      "agent",
    );
    const senderConversationId = validateAddress(
      context?.conversationId ?? undefined,
      "conversation",
    );
    if (!senderAgentId || !senderConversationId) {
      throw new Error(
        "SendAgentMessage requires the calling agent and conversation.",
      );
    }
    const sender = {
      agentId: senderAgentId,
      conversationId: senderConversationId,
    };
    const externalTarget = parseExternalCodingAgentId(args.agent_id);
    if (externalTarget) {
      if (args.conversation_id) {
        throw new Error(
          "External coding-agent IDs cannot be combined with conversation_id.",
        );
      }
      if (normalizeAgentMessageComputer(args.computer)) {
        throw new Error(
          "External coding-agent sessions run on their original computer; omit computer.",
        );
      }
      args.signal?.throwIfAborted();
      const parentScope = sender;
      if (externalTarget.type === "codex") {
        const receipt = await (deps.sendCodexMessage ?? sendCodexMessage)({
          threadId: externalTarget.sessionId,
          prompt: args.message,
          parentAgentId: parentScope.agentId,
          cwd: getCurrentWorkingDirectory(),
          signal: args.signal,
        });
        if (receipt.mode === "steered") {
          return {
            content: JSON.stringify({
              status: "accepted",
              agent_id: args.agent_id,
              delivery: "turn/steer",
              turn_id: receipt.turnId,
            }),
            status: "success",
          };
        }
        if (!receipt.completion || !receipt.interrupt) {
          throw new Error(
            "Codex turn/start returned an incomplete background-task receipt",
          );
        }
        let taskReceipt: ReturnType<typeof trackExternalFollowupCompletion>;
        try {
          taskReceipt = (
            deps.trackExternalFollowup ?? trackExternalFollowupCompletion
          )({
            type: "codex",
            agentId: args.agent_id as string,
            message: args.message,
            parentScope,
            completion: receipt.completion,
            interrupt: receipt.interrupt,
          });
        } catch (error) {
          await receipt.interrupt().catch(() => undefined);
          throw error;
        }
        return {
          content: JSON.stringify({
            status: "accepted",
            agent_id: args.agent_id,
            delivery: "turn/start",
            turn_id: receipt.turnId,
            task_id: taskReceipt.taskId,
            output_file: taskReceipt.outputFile,
          }),
          status: "success",
        };
      }
      const receipt = await (deps.sendClaudeMessage ?? sendClaudeMessage)({
        sessionId: externalTarget.sessionId,
        prompt: args.message,
        parentAgentId: parentScope.agentId,
        cwd: getCurrentWorkingDirectory(),
        signal: args.signal,
      });
      if (receipt.mode === "steered") {
        return {
          content: JSON.stringify({
            status: "accepted",
            agent_id: args.agent_id,
            delivery: "stream/interrupt",
          }),
          status: "success",
        };
      }
      if (!receipt.completion || !receipt.interrupt) {
        throw new Error(
          "Claude resume returned an incomplete background-task receipt",
        );
      }
      let taskReceipt: ReturnType<typeof trackExternalFollowupCompletion>;
      try {
        taskReceipt = (
          deps.trackExternalFollowup ?? trackExternalFollowupCompletion
        )({
          type: "claude-code",
          agentId: args.agent_id as string,
          message: args.message,
          parentScope,
          completion: receipt.completion,
          interrupt: receipt.interrupt,
        });
      } catch (error) {
        await receipt.interrupt().catch(() => undefined);
        throw error;
      }
      return {
        content: JSON.stringify({
          status: "accepted",
          agent_id: args.agent_id,
          delivery: "resume/start",
          task_id: taskReceipt.taskId,
          output_file: taskReceipt.outputFile,
        }),
        status: "success",
      };
    }

    const backend = deps.backend ?? getBackend();
    if (!backend.capabilities.environmentRouting) {
      throw new Error("SendAgentMessage requires a Cloud backend.");
    }
    const computer = normalizeAgentMessageComputer(args.computer);
    const actingUserId = context?.actingUserId;
    if (!actingUserId) {
      console.info(
        "[SendAgentMessage] Sending without X-Letta-Acting-User-Id",
        {
          senderAgentId: sender.agentId,
          senderConversationId: sender.conversationId,
          targetAgentId: args.agent_id,
          targetConversationId: args.conversation_id,
        },
      );
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(args.signal ? [args.signal] : []),
    ]);
    signal.throwIfAborted();
    destination = await resolveAgentMessageDestination(
      {
        agentId: args.agent_id,
        conversationId: args.conversation_id,
        senderAgentId: sender.agentId,
        actingUserId,
        currentConversation: sender,
      },
      backend,
      signal,
    );
    signal.throwIfAborted();
    // A child spawned by this agent keeps doing its work; show it as running.
    const child = await resolveChildSubagent(
      backend,
      destination.agentId,
      sender.agentId,
    );
    signal.throwIfAborted();
    submissionAttempted = true;
    const receipt = await (deps.enqueue ?? enqueueConversationMessage)(
      {
        ...destination,
        clientMessageId,
        content: buildAgentSendContent(sender, true, args.message),
        computer,
        actingUserId,
      },
      signal,
    );
    if (child) {
      (deps.trackChildSend ?? trackChildSend)({
        receipt,
        child,
        prompt: args.message,
        parentScope: {
          agentId: sender.agentId,
          conversationId: sender.conversationId,
        },
      });
    }
    return {
      content: JSON.stringify({
        ...receipt,
        status_command: `letta messages status --agent ${receipt.agent_id} --conversation ${receipt.conversation_id}`,
        messages_command: `letta messages list --agent ${receipt.agent_id} --conversation ${receipt.conversation_id}`,
      }),
      status: "success",
    };
  } catch (error) {
    const unknown =
      submissionAttempted &&
      !(
        error instanceof ApiRequestError &&
        error.status >= 400 &&
        error.status < 500
      ) &&
      !isProvenCloudApiShutdownRejection(error);
    return {
      content: JSON.stringify({
        status: unknown ? "acceptance_unknown" : "submission_failed",
        error: error instanceof Error ? error.message : String(error),
        client_message_id: clientMessageId,
        ...(destination
          ? {
              agent_id: destination.agentId,
              conversation_id: destination.conversationId,
            }
          : {}),
        ...(error instanceof ApiRequestError
          ? { http_status: error.status }
          : {}),
        ...(unknown
          ? {
              guidance:
                "Inspect the conversation before resending; the message may already have been accepted.",
            }
          : {}),
      }),
      status: "error",
    };
  }
}
