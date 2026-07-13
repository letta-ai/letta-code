import type WebSocket from "ws";
import { updateRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import {
  getWorkingDirectoryScopeKey,
  setConversationWorkingDirectory,
} from "./cwd";
import { emitDeviceStatusUpdate } from "./protocol-outbound";
import { getConversationRuntime } from "./runtime";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ConversationRuntime, ListenerRuntime } from "./types";

async function loadSettingsForWorkingDirectory(
  workingDirectory: string,
): Promise<void> {
  await Promise.all([
    settingsManager.loadProjectSettings(workingDirectory),
    settingsManager.loadLocalProjectSettings(workingDirectory),
  ]);
}

export async function switchCurrentRuntimeWorkingDirectory(
  workingDirectory: string,
): Promise<void> {
  await loadSettingsForWorkingDirectory(workingDirectory);
  process.chdir(workingDirectory);
  process.env.USER_CWD = workingDirectory;
  updateRuntimeContext({ workingDirectory });
}

/**
 * Updates a captured tool execution context so tool calls later in the SAME
 * turn resolve the new working directory. Turns bake their cwd into the
 * prepared execution context at turn start; without this, an in-flight turn
 * keeps running tools in the previous directory after a cwd switch.
 */
export async function updateToolExecutionContextCwd(
  executionContextId: string | undefined,
  workingDirectory: string,
): Promise<void> {
  if (!executionContextId) {
    return;
  }
  // Imported lazily so `@/tools/manager` does not become a static dependency
  // of the listener cwd module.
  const { updateToolExecutionContextWorkingDirectory } = await import(
    "@/tools/manager"
  );
  updateToolExecutionContextWorkingDirectory(
    executionContextId,
    workingDirectory,
  );
}

export async function switchConversationWorkingDirectory(params: {
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
  workingDirectory: string;
  emitStatus?: boolean;
  statusRuntime?: ConversationRuntime | ListenerRuntime;
  statusSocket?: WebSocket;
  updateCurrentRuntimeContext?: boolean;
}): Promise<void> {
  const { runtime, workingDirectory } = params;
  const agentId = normalizeCwdAgentId(params.agentId);
  const conversationId = normalizeConversationId(params.conversationId);

  await loadSettingsForWorkingDirectory(workingDirectory);

  setConversationWorkingDirectory(
    runtime,
    agentId,
    conversationId,
    workingDirectory,
  );

  if (params.updateCurrentRuntimeContext !== false) {
    updateRuntimeContext({ workingDirectory });
  }

  const conversationRuntime = getConversationRuntime(
    runtime,
    agentId,
    conversationId,
  );

  const scopeKey = getWorkingDirectoryScopeKey(agentId, conversationId);
  const reminderState =
    conversationRuntime?.reminderState ??
    runtime.reminderStateByConversation.get(scopeKey);
  if (reminderState) {
    reminderState.hasSentSessionContext = false;
    reminderState.pendingSessionContextReason = "cwd_changed";
  }

  const statusSocket = params.statusSocket ?? runtime.socket;
  if (params.emitStatus !== false && statusSocket) {
    emitDeviceStatusUpdate(
      statusSocket,
      params.statusRuntime ?? conversationRuntime ?? runtime,
      {
        agent_id: agentId,
        conversation_id: conversationId,
      },
    );
  }
}
