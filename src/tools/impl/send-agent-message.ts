import { randomUUID } from "node:crypto";
import type { SubagentResult } from "@/agent/subagents";
import {
  resolveChildSubagent,
  trackChildSend,
} from "@/agent/subagents/child-send-tracking";
import { type Backend, getBackend } from "@/backend";
import {
  buildAgentMessageRecoveryCommands,
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
  getRuntimeActingUserAttribution,
  getRuntimeContext,
} from "@/runtime-context";
import {
  getRuntimeExecutionEnv,
  type RuntimeExecutionSettings,
} from "@/runtime-execution-settings";
import { debugLog } from "@/utils/debug";
import { readSubagentDepth } from "@/utils/subagent-depth-env";
import { sendClaudeMessage } from "./claude-stream-session";
import { sendCodexMessage } from "./codex-app-server";
import { sendCursorMessage } from "./cursor-session";
import {
  buildExternalWorkerResumeEnv,
  type ExternalWorkerResumeEnvDependencies,
  nativeSessionSourceFor,
  parseExternalCodingAgentId,
  resolveExternalCodingAgentSecretEnv,
  scrubExternalWorkerResult,
} from "./external-coding-agent";
import { trackExternalFollowupCompletion } from "./external-coding-agent-task";
import {
  type NativeSessionCaptureReservation,
  type NativeSessionSource,
  reportNativeSessionCaptureFailure,
  reserveNativeSessionCapture,
} from "./native-session-capture";
import { sendOpenCodeMessage } from "./opencode-session";
import { sendPiMessage } from "./pi-rpc-session";
import { sendRemoteExternalCodingAgentMessage } from "./remote-external-coding-agent";

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
  sendPiMessage?: typeof sendPiMessage;
  trackExternalFollowup?: typeof trackExternalFollowupCompletion;
  sendRemoteExternalMessage?: typeof sendRemoteExternalCodingAgentMessage;
  workerEnv?: ExternalWorkerResumeEnvDependencies;
}

const FULL_CONVERSATION_ID =
  /^conv-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function finishUntrackedNativeCapture(
  completion: Promise<unknown>,
  reservation: NativeSessionCaptureReservation | undefined,
  source: NativeSessionSource,
  sessionId: string,
): void {
  if (!reservation) return;
  void completion
    .then(
      () => reservation.capture(),
      () => reservation.capture(),
    )
    .catch((error) =>
      reportNativeSessionCaptureFailure(source, sessionId, error),
    );
}

async function finishFailedNativeStartCapture(
  reservation: NativeSessionCaptureReservation | undefined,
  source: NativeSessionSource,
  sessionId: string,
): Promise<void> {
  if (!reservation) return;
  try {
    await reservation.capture();
  } catch (error) {
    reportNativeSessionCaptureFailure(source, sessionId, error);
  }
}

/** Truncated or agent IDs would otherwise fail as an opaque 404. */
function checkConversationId(id: string | undefined): void {
  if (!id || id === "default" || FULL_CONVERSATION_ID.test(id)) return;
  const shown = JSON.stringify(id);
  if (id.startsWith("agent-")) {
    throw new Error(
      `conversation_id ${shown} is an agent ID; pass it as agent_id instead.`,
    );
  }
  if (id.startsWith("conv-")) {
    throw new Error(
      `conversation_id ${shown} is not a full conversation ID (conv-<uuid>); truncated IDs are rejected. Pass the full conversation ID.`,
    );
  }
}

/** A subagent's omitted destination is the conversation that launched it. */
function resolveParentAddress(
  settings: RuntimeExecutionSettings | undefined,
): { agentId: string; conversationId: string } | undefined {
  const env = getRuntimeExecutionEnv(process.env, settings);
  const agentId = env.LETTA_PARENT_AGENT_ID;
  const conversationId = env.LETTA_PARENT_CONVERSATION_ID;
  if (readSubagentDepth(env) === 0 || !agentId || !conversationId) return;
  return { agentId, conversationId };
}

export async function send_agent_message(
  args: SendAgentMessageArgs,
  deps: SendAgentMessageDeps = {},
): Promise<{ content: string; status: "success" | "error" }> {
  const clientMessageId = randomUUID();
  let submissionAttempted = false;
  let destination: { agentId?: string; conversationId: string } | undefined;
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
      if (externalTarget.computer) {
        const receipt = await (
          deps.sendRemoteExternalMessage ?? sendRemoteExternalCodingAgentMessage
        )(
          {
            agentId: args.agent_id as string,
            message: args.message,
            parentScope: {
              ...parentScope,
              actingUserId: getRuntimeActingUserAttribution(),
            },
          },
          {
            track:
              deps.trackExternalFollowup ?? trackExternalFollowupCompletion,
          },
        );
        return {
          content: JSON.stringify({
            status: "accepted",
            agent_id: args.agent_id,
            delivery:
              receipt.delivery === "steered" ? "remote/steer" : "remote/resume",
            ...(receipt.taskId ? { task_id: receipt.taskId } : {}),
            ...(receipt.outputFile ? { output_file: receipt.outputFile } : {}),
          }),
          status: "success",
        };
      }
      if (
        externalTarget.type === "opencode" ||
        externalTarget.type === "cursor"
      ) {
        const messageOptions = {
          sessionId: externalTarget.sessionId,
          prompt: args.message,
          parentAgentId: parentScope.agentId,
          cwd: getCurrentWorkingDirectory(),
          signal: args.signal,
        };
        const secrets =
          externalTarget.type === "cursor"
            ? await resolveExternalCodingAgentSecretEnv(parentScope.agentId)
            : {};
        const receipt =
          externalTarget.type === "cursor"
            ? await sendCursorMessage(
                messageOptions,
                { ...process.env, ...secrets },
                secrets,
              )
            : await sendOpenCodeMessage(messageOptions);
        if (receipt.mode === "steered") {
          return {
            content: JSON.stringify({
              status: "accepted",
              agent_id: args.agent_id,
              delivery:
                externalTarget.type === "cursor"
                  ? "run/steer"
                  : "session/abort+prompt",
            }),
            status: "success",
          };
        }
        if (!receipt.completion || !receipt.interrupt)
          throw new Error(
            "External coding agent returned an incomplete background-task receipt",
          );
        try {
          const tracked = (
            deps.trackExternalFollowup ?? trackExternalFollowupCompletion
          )({
            type: externalTarget.type,
            agentId: args.agent_id as string,
            message: args.message,
            parentScope: {
              ...parentScope,
              actingUserId: getRuntimeActingUserAttribution(),
            },
            completion: receipt.completion,
            interrupt: receipt.interrupt,
          });
          return {
            content: JSON.stringify({
              status: "accepted",
              agent_id: args.agent_id,
              delivery: "session/prompt",
              task_id: tracked.taskId,
              output_file: tracked.outputFile,
            }),
            status: "success",
          };
        } catch (error) {
          await receipt.interrupt();
          throw error;
        }
      }
      // A resumed worker process needs the same environment as a launch.
      const worker = await buildExternalWorkerResumeEnv(
        {
          parentAgentId: parentScope.agentId,
          actingUserId: getRuntimeActingUserAttribution(),
        },
        deps.workerEnv,
      );
      const source = nativeSessionSourceFor(externalTarget.type) ?? "codex";
      const sessionId = externalTarget.sessionId;
      const actingScope = {
        ...parentScope,
        actingUserId: getRuntimeActingUserAttribution(),
      };
      let captureReservation: NativeSessionCaptureReservation | undefined;
      const beforeStart = async () => {
        captureReservation = await reserveNativeSessionCapture(
          source,
          sessionId,
          actingScope,
        );
      };
      const followup = {
        prompt: args.message,
        parentAgentId: parentScope.agentId,
        cwd: getCurrentWorkingDirectory(),
        mcpReminder: worker.mcpReminder,
        signal: args.signal,
        beforeStart,
      };
      // Each worker names how it delivered a steer or a new turn.
      const deliveries =
        externalTarget.type === "codex"
          ? { steered: "turn/steer", started: "turn/start" }
          : externalTarget.type === "pi"
            ? { steered: "rpc/steer", started: "rpc/prompt" }
            : { steered: "stream/interrupt", started: "resume/start" };
      let receipt: {
        mode: "steered" | "new_turn" | "resumed";
        turnId?: string;
        completion?: Promise<SubagentResult>;
        interrupt?: () => Promise<void>;
      };
      try {
        receipt =
          externalTarget.type === "codex"
            ? await (deps.sendCodexMessage ?? sendCodexMessage)(
                { ...followup, threadId: sessionId },
                { env: worker.env },
              )
            : externalTarget.type === "pi"
              ? await (deps.sendPiMessage ?? sendPiMessage)(
                  { ...followup, sessionId },
                  worker.env,
                )
              : await (deps.sendClaudeMessage ?? sendClaudeMessage)(
                  { ...followup, sessionId },
                  { env: worker.env },
                );
      } catch (error) {
        await finishFailedNativeStartCapture(
          captureReservation,
          source,
          sessionId,
        );
        throw error;
      }
      const turnId = receipt.turnId ? { turn_id: receipt.turnId } : {};
      if (receipt.mode === "steered") {
        return {
          content: JSON.stringify({
            status: "accepted",
            agent_id: args.agent_id,
            delivery: deliveries.steered,
            ...turnId,
          }),
          status: "success",
        };
      }
      const { interrupt } = receipt;
      if (!receipt.completion || !interrupt) {
        throw new Error(
          `${externalTarget.type} returned an incomplete background-task receipt`,
        );
      }
      const completion = receipt.completion.then((result) =>
        scrubExternalWorkerResult(result, worker.secretEnv),
      );
      let taskReceipt: ReturnType<typeof trackExternalFollowupCompletion>;
      try {
        taskReceipt = (
          deps.trackExternalFollowup ?? trackExternalFollowupCompletion
        )({
          type: externalTarget.type,
          agentId: args.agent_id as string,
          message: args.message,
          parentScope: actingScope,
          completion,
          interrupt,
          captureReservation,
        });
      } catch (error) {
        await interrupt().catch(() => undefined);
        finishUntrackedNativeCapture(
          completion,
          captureReservation,
          source,
          sessionId,
        );
        throw error;
      }
      return {
        content: JSON.stringify({
          status: "accepted",
          agent_id: args.agent_id,
          delivery: deliveries.started,
          ...turnId,
          task_id: taskReceipt.taskId,
          output_file: taskReceipt.outputFile,
        }),
        status: "success",
      };
    }

    checkConversationId(args.conversation_id);
    const backend = deps.backend ?? getBackend();
    if (!backend.capabilities.environmentRouting) {
      throw new Error("SendAgentMessage requires a Cloud backend.");
    }
    const computer = normalizeAgentMessageComputer(args.computer);
    const actingUserId = getRuntimeActingUserAttribution();
    if (!actingUserId) {
      debugLog("SendAgentMessage", "Sending without X-Letta-Acting-User-Id", {
        senderAgentId: sender.agentId,
        senderConversationId: sender.conversationId,
        targetAgentId: args.agent_id,
        targetConversationId: args.conversation_id,
      });
    }
    const signal = AbortSignal.any([
      AbortSignal.timeout(30_000),
      ...(args.signal ? [args.signal] : []),
    ]);
    signal.throwIfAborted();
    const parent =
      args.agent_id || args.conversation_id
        ? undefined
        : resolveParentAddress(context?.executionSettings);
    destination = await resolveAgentMessageDestination(
      {
        agentId: parent?.agentId ?? args.agent_id,
        conversationId: parent?.conversationId ?? args.conversation_id,
        senderAgentId: sender.agentId,
        actingUserId,
        currentConversation: sender,
      },
      backend,
      signal,
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
    // A child spawned by this agent keeps doing its work; show it as running.
    // The receipt names the conversation's agent (older servers omit it, so
    // fall back to the passed agent); with neither, tracking is skipped. The
    // lookup never fails the send: it was already accepted.
    const child = receipt.agent_id
      ? await resolveChildSubagent(backend, receipt.agent_id, sender.agentId)
      : null;
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
        ...buildAgentMessageRecoveryCommands({
          agentId: receipt.agent_id,
          conversationId: receipt.conversation_id,
        }),
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
              ...(destination.agentId ? { agent_id: destination.agentId } : {}),
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
