import path from "node:path";
import type WebSocket from "ws";
import {
  ensureFileIndex,
  getIndexRoot,
  setIndexRoot,
} from "../../cli/helpers/fileIndex";
import { updateRuntimeContext } from "../../runtime-context";
import {
  getWorkingDirectoryScopeKey,
  setConversationWorkingDirectory,
} from "./cwd";
import { emitDeviceStatusUpdate } from "./protocol-outbound";
import { getConversationRuntime } from "./runtime";
import { normalizeConversationId, normalizeCwdAgentId } from "./scope";
import type { ConversationRuntime, ListenerRuntime } from "./types";

function isWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function refreshIndexForWorkingDirectory(workingDirectory: string): void {
  if (!isWithinOrEqual(getIndexRoot(), workingDirectory)) {
    setIndexRoot(workingDirectory);
  }
  void ensureFileIndex();
}

export function switchCurrentRuntimeWorkingDirectory(
  workingDirectory: string,
): void {
  updateRuntimeContext({ workingDirectory });
  refreshIndexForWorkingDirectory(workingDirectory);
}

export function switchConversationWorkingDirectory(params: {
  runtime: ListenerRuntime;
  agentId: string | null;
  conversationId: string;
  workingDirectory: string;
  emitStatus?: boolean;
  statusRuntime?: ConversationRuntime | ListenerRuntime;
  statusSocket?: WebSocket;
  updateCurrentRuntimeContext?: boolean;
}): void {
  const { runtime, workingDirectory } = params;
  const agentId = normalizeCwdAgentId(params.agentId);
  const conversationId = normalizeConversationId(params.conversationId);

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

  refreshIndexForWorkingDirectory(workingDirectory);

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
