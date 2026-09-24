import {
  runOutsideRuntimeContext,
  runWithRuntimeContext,
} from "@/runtime-context";
import { launchSubagent } from "@/tools/impl/task";
import type {
  LaunchSubagentCommand,
  LaunchSubagentResponse,
} from "@/types/subagent-protocol";
import { getConversationWorkingDirectory } from "@/websocket/listener/cwd";
import type { ConversationRuntime } from "@/websocket/listener/types";

/** A sideband launch never acquires or changes the parent's turn lease. */
export async function handleLaunchSubagentCommand(
  command: LaunchSubagentCommand,
  parent: ConversationRuntime,
  connectionId?: string,
  launch = launchSubagent,
  startupTimeoutMs = 25_000,
): Promise<LaunchSubagentResponse> {
  const response = {
    type: "launch_subagent_response" as const,
    request_id: command.request_id,
  };
  const controller = new AbortController();
  const connectionSignal = connectionId
    ? parent.listener.connections.get(connectionId)?.cancellation.signal
    : undefined;
  const signal = connectionSignal
    ? AbortSignal.any([controller.signal, connectionSignal])
    : controller.signal;
  const aborted = Promise.withResolvers<never>();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  // Finish startup before the client's default 30-second request deadline.
  const timeout = setTimeout(() => {
    controller.abort(new Error("Subagent launch timed out"));
  }, startupTimeoutMs);
  try {
    signal.throwIfAborted();
    if (parent.listener.intentionallyClosed)
      throw new Error("Runtime is no longer active");
    if (
      parent.agentId !== command.runtime.agent_id ||
      parent.conversationId !== command.runtime.conversation_id
    ) {
      throw new Error("Parent runtime does not match the launch request");
    }
    const result = await Promise.race([
      aborted.promise,
      runOutsideRuntimeContext(() =>
        runWithRuntimeContext(
          {
            connectionId,
            environmentDeviceId: connectionId
              ? parent.listener.connections.get(connectionId)?.options.deviceId
              : undefined,
            agentId: parent.agentId,
            conversationId: parent.conversationId,
            actingUserId: command.runtime.acting_user_id,
            actingUserAssertion: command.runtime.acting_user_assertion,
            workingDirectory: getConversationWorkingDirectory(
              parent.listener,
              parent.agentId,
              parent.conversationId,
            ),
            skillSources: parent.skillSources,
            workspaceSandbox: parent.workspaceSandbox,
            executionSettings: parent.executionSettings,
          },
          () =>
            launch({
              ...command.args,
              signal,
              toolCallId: command.tool_call_id,
              parentScope: {
                agentId: command.runtime.agent_id,
                conversationId: command.runtime.conversation_id,
              },
            }),
        ),
      ),
    ]);
    return { ...response, ...result };
  } catch (error) {
    return {
      ...response,
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }
}
