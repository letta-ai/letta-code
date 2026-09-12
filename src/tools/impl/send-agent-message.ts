import { randomUUID } from "node:crypto";
import { type Backend, getBackend } from "@/backend";
import {
  buildAgentSendReminder,
  resolveAgentMessageDestination,
  validateAddress,
} from "@/backend/api/agent-message";
import { enqueueConversationMessage } from "@/backend/api/conversation-enqueue";
import { ApiRequestError } from "@/backend/api/request";
import { getRuntimeContext } from "@/runtime-context";

interface SendAgentMessageArgs {
  message: string;
  agent_id?: string;
  conversation_id?: string;
  computer?: string;
  signal?: AbortSignal;
}

interface SendAgentMessageDeps {
  backend?: Pick<
    Backend,
    "capabilities" | "retrieveConversation" | "createConversation"
  >;
  enqueue?: typeof enqueueConversationMessage;
}

export async function send_agent_message(
  args: SendAgentMessageArgs,
  deps: SendAgentMessageDeps = {},
): Promise<{ content: string; status: "success" | "error" }> {
  const clientMessageId = randomUUID();
  let submissionAttempted = false;
  let destination: { agentId: string; conversationId: string } | undefined;
  try {
    const backend = deps.backend ?? getBackend();
    if (!backend.capabilities.environmentRouting) {
      throw new Error("SendAgentMessage requires a Cloud backend.");
    }
    if (!args.message?.trim()) throw new Error("Message must not be empty.");
    if (args.computer !== undefined && !args.computer.trim()) {
      throw new Error("Computer selector must not be empty.");
    }
    const context = getRuntimeContext();
    const sender = {
      agentId: validateAddress(context?.agentId ?? undefined, "agent"),
      conversationId: validateAddress(
        context?.conversationId ?? undefined,
        "conversation",
      ),
    };
    if (!sender.agentId || !sender.conversationId) {
      throw new Error(
        "SendAgentMessage requires the calling agent and conversation.",
      );
    }
    const actingUserId = context?.actingUserId;
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
      },
      backend,
      signal,
    );
    signal.throwIfAborted();
    submissionAttempted = true;
    const computer = args.computer;
    const receipt = await (deps.enqueue ?? enqueueConversationMessage)(
      {
        ...destination,
        clientMessageId,
        content: `${buildAgentSendReminder(sender, true)}${args.message}`,
        computer:
          computer &&
          ["cloud", "cloud-sandbox"].includes(computer.trim().toLowerCase())
            ? "cloud"
            : computer,
        actingUserId,
      },
      signal,
    );
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
      );
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
