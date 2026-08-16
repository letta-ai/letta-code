import type { RuntimeContextSnapshot } from "@/runtime-context";
import {
  switchConversationWorkingDirectory,
  switchCurrentRuntimeWorkingDirectory,
  updateToolExecutionContextCwd,
} from "@/websocket/listener/cwd-change";
import { getActiveRuntime } from "@/websocket/listener/runtime";
import { restartWorktreeWatcher } from "@/websocket/listener/worktree-watcher";

export async function switchRuntimeWorkingDirectory(params: {
  workingDirectory: string;
  runtimeContext?: RuntimeContextSnapshot;
}): Promise<void> {
  const listener = getActiveRuntime();
  if (listener && params.runtimeContext?.conversationId) {
    await switchConversationWorkingDirectory({
      runtime: listener,
      agentId: params.runtimeContext.agentId ?? null,
      conversationId: params.runtimeContext.conversationId,
      workingDirectory: params.workingDirectory,
      updateCurrentRuntimeContext: true,
    });
    restartWorktreeWatcher({
      runtime: listener,
      agentId: params.runtimeContext.agentId ?? null,
      conversationId: params.runtimeContext.conversationId,
    });
  } else {
    await switchCurrentRuntimeWorkingDirectory(params.workingDirectory);
  }
  await updateToolExecutionContextCwd(
    params.runtimeContext?.toolContextId ?? undefined,
    params.workingDirectory,
  );
}
