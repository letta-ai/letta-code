import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import { QueueRuntime } from "@/queue/queue-runtime";
import { debugWarn } from "@/utils/debug";
import {
  type LocalSessionOwnerHandle,
  startLocalSessionOwner,
} from "@/websocket/local-session-owner";

export interface HeadlessLocalSession {
  queue: QueueRuntime;
  owner: LocalSessionOwnerHandle | null;
  turnAbortSignal: AbortSignal;
  cancel(): void;
}

export async function startHeadlessLocalSession(params: {
  enabled: boolean;
  agentId: string;
  conversationId: string;
  sigintSignal: AbortSignal;
}): Promise<HeadlessLocalSession> {
  const queue = new QueueRuntime({ maxItems: Infinity });
  const remoteAbortController = new AbortController();
  const turnAbortSignal = AbortSignal.any([
    params.sigintSignal,
    remoteAbortController.signal,
  ]);
  const owner = params.enabled
    ? await startLocalSessionOwner({
        agentId: params.agentId,
        conversationId: params.conversationId,
        queueRuntime: queue,
        surfaceName: "headless",
        onQueueChanged: () => {},
        onAbort: () => {
          if (remoteAbortController.signal.aborted) return false;
          remoteAbortController.abort();
          return true;
        },
        waitForAcceptedInputs: async () => {
          if (queue.length > 0) {
            throw new Error(
              "Cannot release with accepted local session inputs",
            );
          }
        },
        onError: (error) => debugWarn("local-session-owner", error.message),
      })
    : null;
  return {
    queue,
    owner,
    turnAbortSignal,
    cancel() {
      owner?.stopAdmission();
      queue.clear("cancelled");
    },
  };
}

/** Close admission atomically with observing/draining accepted follow-ups. */
export function takeAcceptedHeadlessInputs(
  session: HeadlessLocalSession,
): MessageCreate[] | null {
  session.owner?.stopAdmission();
  const batch = session.queue.consumeItems(session.queue.readyLength);
  if (!batch) return null;
  session.owner?.resumeAdmission();
  return batch.items.flatMap((item) =>
    item.kind === "message"
      ? [
          {
            role: "user" as const,
            content: item.content,
            otid: item.clientMessageId ?? crypto.randomUUID(),
          },
        ]
      : [],
  );
}
