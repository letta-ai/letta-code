import { canonicalizeRoot } from "@/permissions/sandbox-policy";
import { updateRuntimeContext } from "@/runtime-context";
import { settingsManager } from "@/settings-manager";
import { getOrCreateProcessTransport } from "./connection";
import {
  getConversationWorkingDirectory,
  getWorkingDirectoryScopeKey,
  setConversationWorkingDirectory,
} from "./cwd";
import {
  emitDeviceStatusUpdate,
  refreshDeviceGitContext,
} from "./protocol-outbound";
import { getConversationRuntime } from "./runtime";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ListenerTransport } from "./transport";
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

export async function updateToolExecutionContextCwd(
  executionContextId: string | undefined,
  workingDirectory: string,
): Promise<void> {
  if (!executionContextId) {
    return;
  }
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
  statusSocket?: ListenerTransport;
  updateCurrentRuntimeContext?: boolean;
}): Promise<void> {
  const { runtime, workingDirectory } = params;
  const agentId = normalizeCwdAgentId(params.agentId);
  const conversationId = normalizeConversationId(params.conversationId);
  const currentWorkingDirectory = getConversationWorkingDirectory(
    runtime,
    agentId,
    conversationId,
  );
  const workingDirectoryChanged =
    canonicalizeRoot(currentWorkingDirectory) !==
    canonicalizeRoot(workingDirectory);

  await loadSettingsForWorkingDirectory(workingDirectory);

  if (workingDirectoryChanged) {
    setConversationWorkingDirectory(
      runtime,
      agentId,
      conversationId,
      workingDirectory,
    );
  }

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
  if (workingDirectoryChanged && reminderState) {
    reminderState.hasSentSessionContext = false;
    reminderState.pendingSessionContextReason = "cwd_changed";
  }

  if (params.emitStatus !== false) {
    const statusTransport =
      params.statusSocket ?? getOrCreateProcessTransport(runtime);
    const statusRuntime =
      params.statusRuntime ?? conversationRuntime ?? runtime;
    const statusScope = {
      agent_id: agentId,
      conversation_id: conversationId,
    };
    await refreshDeviceGitContext(statusRuntime, statusScope);
    emitDeviceStatusUpdate(statusTransport, statusRuntime, statusScope);
  }
}
