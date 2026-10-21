import {
  ordinaryInputIdentity,
  rememberInputDisposition,
} from "./input-disposition";
import {
  prepareInputTerminal,
  quarantinePreparedTerminalAuthority,
} from "./input-terminal-journal";
import type { ConversationRuntime, ListenerRuntime } from "./types";

export function seedLegacyAuthorityQuarantine(
  listener: ListenerRuntime,
  runtime: ConversationRuntime,
): void {
  const identity = ordinaryInputIdentity("legacy-quarantine");
  if (!identity || !rememberInputDisposition(runtime, identity, "started")) {
    throw new Error("failed to seed legacy disposition");
  }
  const recoveryLineageId = "recovery-legacy-quarantine";
  const interruptedRevision = "revision-legacy-quarantine";
  if (
    !prepareInputTerminal(runtime, [identity], {
      scope: { agentId: "agent-0", conversationId: "conversation-0" },
      message: {
        type: "turn_finished",
        turn_id: "turn-legacy-quarantine",
        stop_reason: "end_turn",
      },
      owner: {
        connectionId: null,
        canRotate: false,
        lineageId: "lineage-legacy-quarantine",
        terminalIdentity: "terminal-legacy-quarantine",
        interruptedRevision,
        recoveryLineageId,
        interruptedAuthorityRevision: "authority-legacy-quarantine",
      },
    }) ||
    !quarantinePreparedTerminalAuthority(
      listener,
      { agentId: "agent-0", conversationId: "conversation-0" },
      {
        interruptedRevision,
        recoveryLineageId,
        authorityRevision: "legacy-authority-quarantine",
      },
    )
  ) {
    throw new Error("failed to seed legacy authority quarantine");
  }
  if (
    quarantinePreparedTerminalAuthority(
      listener,
      { agentId: "agent-0", conversationId: "conversation-0" },
      {
        interruptedRevision,
        recoveryLineageId,
        authorityRevision: "ordered-authority-quarantine",
        terminalIdentity: "ordered-terminal-quarantine",
        preparationSequence: 1,
      },
    )
  ) {
    throw new Error("ordered authority entered legacy quarantine");
  }
}
