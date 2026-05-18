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
import { isGitWorktreeRoot } from "./file-commands";
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

async function refreshIndexForWorkingDirectory(
  workingDirectory: string,
): Promise<void> {
  const currentRoot = getIndexRoot();
  const needsReroot =
    !isWithinOrEqual(currentRoot, workingDirectory) ||
    (workingDirectory !== currentRoot &&
      (await isGitWorktreeRoot(workingDirectory)));

  if (needsReroot) {
    setIndexRoot(workingDirectory);
  }
  void ensureFileIndex();
}

export async function switchCurrentRuntimeWorkingDirectory(
  workingDirectory: string,
): Promise<void> {
  process.chdir(workingDirectory);
  process.env.USER_CWD = workingDirectory;
  updateRuntimeContext({ workingDirectory });
  await refreshIndexForWorkingDirectory(workingDirectory);
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

  await refreshIndexForWorkingDirectory(workingDirectory);

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
