import { getBackend } from "@/backend";
import type { EnqueueReceipt } from "@/backend/api/conversation-enqueue";
import { getRuntimeContext } from "@/runtime-context";
import type { ExternalToolExecutor } from "@/tools/manager";
import type { PreparedSubagent } from "./subagent-setup";
import { task } from "./task";

function textResult(text: string, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

function readControl(result: Awaited<ReturnType<ExternalToolExecutor>>) {
  const text = result.content
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join("\n");
  if (result.isError) throw new Error(text || "Agent setup failed");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid Agent setup response");
  return value as Record<string, unknown>;
}

/** A controller-owned tool can prepare an Agent invocation and configure its
 * child before startup. Only the existing Agent implementation executes work;
 * controller replies contain validated data, never executable source.
 */
export function createExternalAgentExecutor(
  controller: ExternalToolExecutor,
  deps: { runAgent?: typeof task; cloudBackend?: () => boolean } = {},
): ExternalToolExecutor {
  return async (toolCallId, toolName, input, context) => {
    const parent = getRuntimeContext();
    let child: PreparedSubagent | undefined;
    let accepted: EnqueueReceipt | undefined;
    let initialInputId: string | undefined;
    const call = (phase: string, fields: Record<string, unknown> = {}) =>
      controller(
        toolCallId,
        toolName,
        { ...input, _agent: { phase, ...fields } },
        context,
      );
    try {
      if (
        !(
          deps.cloudBackend ??
          (() => getBackend().capabilities.environmentRouting)
        )()
      )
        throw new Error(
          "Controller-prepared Agent tools require a Cloud-backed runtime",
        );
      if ("_agent" in input)
        throw new Error("_agent is reserved for runtime setup");
      context?.signal?.throwIfAborted();
      const prepared = readControl(await call("prepare"));
      if (prepared.action === "return" && typeof prepared.result === "string")
        return textResult(prepared.result);
      const args = prepared.arguments;
      if (
        prepared.action !== "launch" ||
        !args ||
        typeof args !== "object" ||
        Array.isArray(args)
      )
        throw new Error("Invalid Agent launch arguments");
      const launch = args as Record<string, unknown>;
      const keys = new Set([
        "subagent_type",
        "prompt",
        "description",
        "model",
        "computer",
      ]);
      if (
        Object.keys(launch).some((key) => !keys.has(key)) ||
        launch.subagent_type !== "fork" ||
        typeof launch.prompt !== "string" ||
        !launch.prompt.trim() ||
        typeof launch.description !== "string" ||
        !launch.description.trim() ||
        (launch.model !== undefined && typeof launch.model !== "string") ||
        (launch.computer !== undefined &&
          typeof launch.computer !== "string") ||
        (prepared.first_turn_reminder !== undefined &&
          typeof prepared.first_turn_reminder !== "string")
      )
        throw new Error("Invalid Agent launch arguments");
      context?.signal?.throwIfAborted();
      let skipped = false;
      const report = await (deps.runAgent ?? task)(
        {
          subagent_type: "fork",
          prompt: launch.prompt,
          description: launch.description,
          ...(typeof launch.model === "string" ? { model: launch.model } : {}),
          ...(typeof launch.computer === "string"
            ? { computer: launch.computer }
            : {}),
          toolCallId,
          signal: context?.signal,
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
          ...(typeof prepared.first_turn_reminder === "string"
            ? { firstTurnReminder: prepared.first_turn_reminder }
            : {}),
          beforeStart: async (created) => {
            child = created;
            const setup = readControl(await call("setup", { child }));
            if (
              setup.start === false &&
              typeof setup.result === "string" &&
              typeof setup.discardUnstartedFork === "boolean"
            ) {
              skipped = true;
              return {
                start: false,
                result: setup.result,
                discardUnstartedFork: setup.discardUnstartedFork,
              };
            }
            if (
              setup.start !== true ||
              typeof setup.clientMessageId !== "string" ||
              !setup.clientMessageId
            )
              throw new Error("Invalid Agent child setup response");
            initialInputId = setup.clientMessageId;
            return { start: true, clientMessageId: initialInputId };
          },
          onInputAccepted: async (receipt) => {
            if (
              !child ||
              receipt.agent_id !== child.agentId ||
              receipt.conversation_id !== child.conversationId ||
              receipt.client_message_id !== initialInputId
            )
              throw new Error("Agent accepted input for a different child");
            accepted = receipt;
          },
        },
      );
      if (skipped) return textResult(report, report.startsWith("Error:"));
      if (!child) return textResult(report, true);
      return await call("complete", { child, accepted, report });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (child && !context?.signal?.aborted) {
        try {
          return await call("complete", { child, accepted, error: message });
        } catch {
          /* Preserve the original error when the controller is unavailable. */
        }
      }
      return textResult(
        JSON.stringify({ error: message, ...(child ? { child } : {}) }),
        true,
      );
    }
  };
}
