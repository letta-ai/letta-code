import { emitLoopStatusIfOpen } from "./protocol-outbound";
import type { ActiveTurnLoopStatus, TurnLease } from "./turn-lifecycle";
import type { ConversationRuntime } from "./types";

type RuntimeScope = {
  agent_id?: string | null;
  conversation_id?: string | null;
};

export function setTurnLoopStatus(
  runtime: ConversationRuntime,
  lease: TurnLease,
  status: ActiveTurnLoopStatus,
  scope?: RuntimeScope,
): void {
  if (runtime.turnLifecycle.setStatus(lease, status)) {
    emitLoopStatusIfOpen(runtime, scope);
  }
}

export function setCommandLoopStatus(
  runtime: ConversationRuntime,
  status: "EXECUTING_COMMAND" | "WAITING_ON_INPUT",
  scope?: RuntimeScope,
): void {
  const changed =
    status === "EXECUTING_COMMAND"
      ? runtime.turnLifecycle.startCommand()
      : runtime.turnLifecycle.finishCommand();
  if (changed) {
    emitLoopStatusIfOpen(runtime, scope);
  }
}
