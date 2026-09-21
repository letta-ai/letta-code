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
  start(): Promise<boolean>;
  setProcessing(active: boolean): void;
  cancel(): void;
  release(): Promise<void>;
}

export function startHeadlessLocalSession(
  params: {
    enabled: boolean;
    agentId: string;
    conversationId: string;
    sigintSignal: AbortSignal;
  },
  startOwner: typeof startLocalSessionOwner = startLocalSessionOwner,
): HeadlessLocalSession {
  const queue = new QueueRuntime({ maxItems: Infinity });
  const remoteAbortController = new AbortController();
  let disposed = false;
  let startPromise: Promise<boolean> | null = null;
  let processing = false;
  const session: HeadlessLocalSession = {
    queue,
    owner: null,
    turnAbortSignal: AbortSignal.any([
      params.sigintSignal,
      remoteAbortController.signal,
    ]),
    async start() {
      if (disposed || !params.enabled) return false;
      if (startPromise) return await startPromise;
      startPromise = startOwner({
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
        isProcessing: () => processing,
        waitForAcceptedInputs: async () => {
          if (queue.length > 0) {
            throw new Error(
              "Cannot release with accepted local session inputs",
            );
          }
        },
        onError: (error) => debugWarn("local-session-owner", error.message),
      })
        .then(async (owner) => {
          if (disposed) {
            void owner.release();
            return false;
          }
          session.owner = owner;
          return await owner.ready();
        })
        .catch((error: unknown) => {
          debugWarn(
            "local-session-owner",
            error instanceof Error ? error.message : String(error),
          );
          throw error;
        });
      return await startPromise;
    },
    setProcessing(active) {
      processing = active;
    },
    cancel() {
      disposed = true;
      session.owner?.stopAdmission();
      queue.clear("cancelled");
    },
    async release() {
      disposed = true;
      await startPromise?.catch(() => false);
      await session.owner?.release();
    },
  };
  return session;
}

export interface AcceptedHeadlessInput {
  input: MessageCreate[];
  actingUserId?: string;
}

/** Close admission atomically with observing/draining accepted follow-ups. */
export function takeAcceptedHeadlessInputs(
  session: HeadlessLocalSession,
): AcceptedHeadlessInput | null {
  session.owner?.stopAdmission();
  const batch = session.queue.tryDequeue(null);
  if (!batch) return null;
  session.owner?.resumeAdmission();
  return {
    actingUserId: batch.items.find((item) => item.actingUserId)?.actingUserId,
    input: batch.items.flatMap((item) =>
      item.kind === "message"
        ? [
            {
              role: "user" as const,
              content: item.content,
              otid: item.clientMessageId ?? crypto.randomUUID(),
            },
          ]
        : [],
    ),
  };
}
