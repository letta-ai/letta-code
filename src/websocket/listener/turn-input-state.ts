import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import {
  type PendingApprovalInfo,
  rebuildInputWithFreshDenials,
  refreshInputOtidsForNewRequest,
} from "@/agent/turn-recovery-policy";
import type { ImageFailureModesByMessageOtid } from "@/utils/message-image-normalization";

export type TurnInputState = {
  messages: Array<MessageCreate | ApprovalCreate>;
  imageFailureModesByMessageOtid?: ImageFailureModesByMessageOtid;
};

export function ensureTurnInputMessageOtids(
  messages: Array<MessageCreate | ApprovalCreate>,
): Array<MessageCreate | ApprovalCreate> {
  let didChange = false;
  const messagesWithOtids = messages.map((message) => {
    if (!("content" in message) || message.otid) {
      return message;
    }

    didChange = true;
    return {
      ...message,
      // Reconcile optimistic transcript rows with the canonical echo.
      otid:
        "client_message_id" in message &&
        typeof message.client_message_id === "string"
          ? message.client_message_id
          : crypto.randomUUID(),
    };
  });

  return didChange ? messagesWithOtids : messages;
}

export function createTurnInputState(
  messages: Array<MessageCreate | ApprovalCreate>,
  imageFailureModesByMessageOtid?: ImageFailureModesByMessageOtid,
): TurnInputState {
  return {
    messages,
    ...(imageFailureModesByMessageOtid
      ? { imageFailureModesByMessageOtid }
      : {}),
  };
}

export function updateTurnInputMessagesPreservingOtids(
  state: TurnInputState,
  messages: Array<MessageCreate | ApprovalCreate>,
): TurnInputState {
  if (state.imageFailureModesByMessageOtid) {
    const nextOtids = new Set(messages.map((message) => message.otid));
    for (const otid of Object.keys(state.imageFailureModesByMessageOtid)) {
      if (!nextOtids.has(otid)) {
        throw new Error(
          `Cannot preserve image failure policy for missing message OTID: ${otid}`,
        );
      }
    }
  }
  return createTurnInputState(messages, state.imageFailureModesByMessageOtid);
}

export function refreshTurnInputOtidsForNewRequest(
  state: TurnInputState,
): TurnInputState {
  const refreshedMessages = refreshInputOtidsForNewRequest(state.messages);
  return createTurnInputState(
    refreshedMessages,
    remapImageFailureModesByPosition(
      state.messages,
      refreshedMessages,
      state.imageFailureModesByMessageOtid,
    ),
  );
}

export function rebuildTurnInputWithFreshDenials(
  state: TurnInputState,
  serverApprovals: PendingApprovalInfo[],
  denialReason: string,
): TurnInputState {
  const rebuiltMessages = rebuildInputWithFreshDenials(
    state.messages,
    serverApprovals,
    denialReason,
  );
  return createTurnInputState(
    rebuiltMessages,
    remapImageFailureModesByPosition(
      getContentMessages(state.messages),
      getContentMessages(rebuiltMessages),
      state.imageFailureModesByMessageOtid,
    ),
  );
}

function getContentMessages(
  messages: Array<MessageCreate | ApprovalCreate>,
): MessageCreate[] {
  return messages.filter(
    (message): message is MessageCreate => "content" in message,
  );
}

function remapImageFailureModesByPosition(
  previousMessages: Array<MessageCreate | ApprovalCreate>,
  nextMessages: Array<MessageCreate | ApprovalCreate>,
  previousModes?: ImageFailureModesByMessageOtid,
): ImageFailureModesByMessageOtid | undefined {
  if (!previousModes) {
    return undefined;
  }
  if (previousMessages.length !== nextMessages.length) {
    throw new Error(
      "Cannot remap image failure policy across non-corresponding message lists",
    );
  }

  const remappedEntries: Array<
    [string, ImageFailureModesByMessageOtid[string]]
  > = [];
  for (const [index, previousMessage] of previousMessages.entries()) {
    const nextMessage = nextMessages[index];
    const previousOtid = previousMessage?.otid;
    const nextOtid = nextMessage?.otid;
    if (typeof previousOtid !== "string" || typeof nextOtid !== "string") {
      continue;
    }
    const previousMode = previousModes[previousOtid];
    if (previousMode) {
      remappedEntries.push([nextOtid, previousMode]);
    }
  }

  return remappedEntries.length > 0
    ? Object.fromEntries(remappedEntries)
    : undefined;
}
