import { getBackend } from "@/backend";
import { getRuntimeContext } from "@/runtime-context";
import type { ExternalToolExecutor } from "@/tools/manager";
import { task } from "./task";

const INPUT_KEYS = new Set([
  "thread_ts",
  "label",
  "instructions",
  "justification",
  "computer",
  "model",
]);

interface BindingReceipt {
  status: "bound";
  created: boolean;
  agent_id: string;
  conversation_id: string;
  initial_client_message_id: string;
  initial_input_receipt: {
    clientMessageId: string;
    superRunId: string;
    workflowId: string;
  } | null;
}

function textResult(value: unknown, isError = false) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value),
      },
    ],
    isError,
  };
}

function readReceipt(
  result: Awaited<ReturnType<ExternalToolExecutor>>,
): BindingReceipt | { status: "unbound" } {
  const text = result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n");
  if (result.isError) throw new Error(text || "Slack thread setup failed");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object")
    throw new Error("Invalid Slack thread setup receipt");
  const receipt = value as Record<string, unknown>;
  if (receipt.status === "unbound") return { status: "unbound" };
  if (
    receipt.status !== "bound" ||
    typeof receipt.created !== "boolean" ||
    typeof receipt.agent_id !== "string" ||
    !receipt.agent_id.startsWith("agent-") ||
    typeof receipt.conversation_id !== "string" ||
    !receipt.conversation_id.startsWith("conv-") ||
    typeof receipt.initial_client_message_id !== "string" ||
    !receipt.initial_client_message_id ||
    (receipt.initial_input_receipt !== null &&
      (!receipt.initial_input_receipt ||
        typeof receipt.initial_input_receipt !== "object" ||
        Reflect.get(receipt.initial_input_receipt, "clientMessageId") !==
          receipt.initial_client_message_id ||
        typeof Reflect.get(receipt.initial_input_receipt, "superRunId") !==
          "string" ||
        typeof Reflect.get(receipt.initial_input_receipt, "workflowId") !==
          "string"))
  ) {
    throw new Error("Invalid Slack thread binding receipt");
  }
  return receipt as unknown as BindingReceipt;
}

function existingResult(receipt: BindingReceipt): string {
  return JSON.stringify({
    ...receipt,
    created: false,
    message: receipt.initial_input_receipt
      ? "This thread already has a worker. New instructions were not delivered. Use SendAgentMessage to steer it."
      : "This thread has a reserved worker, but its initial input has not been accepted yet. New instructions were not delivered. Retry this tool to check startup; do not send additional work yet.",
  });
}

/** Only installed for the explicitly marked Cloud Slack tool. It shares Agent's
 * complete launch path; controller responses only authorize a thread binding.
 */
export function createSlackThreadDispatchExecutor(
  controller: ExternalToolExecutor,
  deps: { runAgent?: typeof task; cloudBackend?: () => boolean } = {},
): ExternalToolExecutor {
  return async (toolCallId, toolName, input, context) => {
    let binding: BindingReceipt | undefined;
    try {
      if (
        !(
          deps.cloudBackend ??
          (() => getBackend().capabilities.environmentRouting)
        )()
      ) {
        throw new Error(
          "Slack thread dispatch requires a Cloud-backed runtime.",
        );
      }
      for (const key of Object.keys(input)) {
        if (!INPUT_KEYS.has(key))
          throw new Error(`Unsupported dispatch argument: ${key}`);
      }
      if (
        typeof input.thread_ts !== "string" ||
        !/^\d+\.\d+$/.test(input.thread_ts)
      )
        throw new Error("thread_ts must be an exact Slack thread timestamp");
      if (typeof input.label !== "string" || !input.label.trim())
        throw new Error("label must not be empty");
      for (const field of [
        "instructions",
        "justification",
        "computer",
        "model",
      ]) {
        if (input[field] !== undefined && typeof input[field] !== "string")
          throw new Error(`${field} must be a string`);
      }
      const signal = context?.signal;
      signal?.throwIfAborted();
      const lookup = readReceipt(
        await controller(
          toolCallId,
          toolName,
          { ...input, _slack_dispatch: { operation: "lookup" } },
          context,
        ),
      );
      signal?.throwIfAborted();
      if (lookup.status === "bound") return textResult(existingResult(lookup));
      const parent = getRuntimeContext();
      const report = await (deps.runAgent ?? task)(
        {
          subagent_type: "fork",
          prompt:
            typeof input.instructions === "string" && input.instructions.trim()
              ? input.instructions
              : "Continue the requested work in the assigned Slack thread.",
          description: input.label,
          ...(typeof input.computer === "string"
            ? { computer: input.computer }
            : {}),
          ...(typeof input.model === "string" ? { model: input.model } : {}),
          toolCallId,
          signal,
          ...(parent?.agentId && parent?.conversationId
            ? {
                parentScope: {
                  agentId: parent.agentId,
                  conversationId: parent.conversationId,
                },
              }
            : {}),
        },
        {
          firstTurnReminder:
            "<system-reminder>\nYou are the persistent worker assigned to a Slack thread. Your conversation was forked from the channel coordinator. Use your thread-scoped Slack tools to reply and ask follow-up questions in that thread. Use SendAgentMessage for private coordination with the channel coordinator. The coordinator also receives the thread events.\n</system-reminder>\n\n",
          onInputAccepted: async (accepted) => {
            if (
              !binding ||
              accepted.agent_id !== binding.agent_id ||
              accepted.conversation_id !== binding.conversation_id ||
              accepted.client_message_id !== binding.initial_client_message_id
            )
              throw new Error(
                "Agent accepted input for a different Slack worker",
              );
            binding.initial_input_receipt = {
              clientMessageId: accepted.client_message_id,
              superRunId: accepted.super_run_id,
              workflowId: accepted.workflow_id,
            };
          },
          beforeStart: async (child) => {
            const receipt = readReceipt(
              await controller(
                toolCallId,
                toolName,
                {
                  ...input,
                  _slack_dispatch: {
                    operation: "bind",
                    agent_id: child.agentId,
                    conversation_id: child.conversationId,
                  },
                },
                context,
              ),
            );
            if (receipt.status !== "bound")
              throw new Error("Slack thread setup did not return a binding");
            if (receipt.agent_id !== child.agentId)
              throw new Error("Slack binding returned a different agent");
            binding = receipt;
            if (receipt.conversation_id !== child.conversationId) {
              if (receipt.created)
                throw new Error(
                  "Slack setup claimed to create a different child",
                );
              return {
                start: false,
                result: existingResult(receipt),
                discardUnstartedFork: true,
              };
            }
            return {
              start: true,
              clientMessageId: receipt.initial_client_message_id,
            };
          },
        },
      );
      return textResult(
        binding ? { ...binding, result: report } : report,
        report.startsWith("Error:"),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return textResult(
        binding
          ? {
              ...binding,
              error: message,
              message:
                "Worker startup was not confirmed. Retry lookup before sending additional work; the reserved conversation was retained.",
            }
          : `Slack dispatch failed: ${message}`,
        true,
      );
    }
  };
}
