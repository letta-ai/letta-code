import { hostname } from "node:os";
import type { QueueRuntime } from "@/queue/queue-runtime";
import { settingsManager } from "@/settings-manager";
import { startListenerClient, stopListenerRuntime } from "./listen-client";
import { registerWithCloudRetry } from "./listen-register";
import { resolveListenerRegistrationOptions } from "./listener/auth";
import { isListenerTransportOpen } from "./listener/transport";
import type { IncomingMessage, ListenerRuntime } from "./listener/types";

export interface StartLocalSessionOwnerOptions {
  agentId: string;
  conversationId: string;
  queueRuntime: QueueRuntime;
  surfaceName: "TUI" | "headless";
  onQueueChanged: () => void;
  onAbort: () => boolean | Promise<boolean>;
  /** Resolves only after every input accepted before admission stopped is safe. */
  waitForAcceptedInputs?: () => Promise<void>;
  onError?: (error: Error) => void;
}

export interface LocalSessionOwnerHandle {
  /** Close the ACK boundary before testing whether accepted work is drained. */
  stopAdmission(): void;
  /** Reopen admission when an accepted batch starts another local turn. */
  resumeAdmission(): void;
  /** Drain accepted work and disconnect only after positive release acknowledgement. */
  release(): Promise<boolean>;
}

export interface LocalSessionOwnerDependencies {
  getDeviceId: () => string;
  resolveRegistration: typeof resolveListenerRegistrationOptions;
  register: typeof registerWithCloudRetry;
  startListener: typeof startListenerClient;
  stopListener: typeof stopListenerRuntime;
}

const DEFAULT_DEPENDENCIES: LocalSessionOwnerDependencies = {
  getDeviceId: () => settingsManager.getOrCreateDeviceId(),
  resolveRegistration: resolveListenerRegistrationOptions,
  register: registerWithCloudRetry,
  startListener: startListenerClient,
  stopListener: stopListenerRuntime,
};

function parseReleaseAck(
  event: unknown,
): { requestId: string; released: boolean } | null {
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    event.type !== "_ws_unparseable" ||
    !("raw" in event) ||
    typeof event.raw !== "string"
  ) {
    return null;
  }
  try {
    const parsed = JSON.parse(event.raw) as {
      type?: string;
      request_id?: string;
      released?: boolean;
    };
    return parsed.type === "session_owner_released" && parsed.request_id
      ? { requestId: parsed.request_id, released: parsed.released === true }
      : null;
  } catch {
    return null;
  }
}

/**
 * Register a local Cloud-backed process as the scoped owner of its current
 * conversation. The production listener owns transport, reconnect,
 * serialization, dedupe, and receipts; the caller's QueueRuntime remains the
 * sole turn executor.
 */
export async function startLocalSessionOwner(
  options: StartLocalSessionOwnerOptions,
  dependencies: LocalSessionOwnerDependencies = DEFAULT_DEPENDENCIES,
): Promise<LocalSessionOwnerHandle> {
  const deviceId = dependencies.getDeviceId();
  const connectionName = `Letta Code ${options.surfaceName} (${hostname()})`;
  // Stable for reconnects in this process, unique across concurrent local
  // owners so registration cannot rotate another process's lease.
  const listenerInstanceId = `local-session-${crypto.randomUUID()}`;
  let stopped = false;
  let accepting = true;
  let ownedRuntime: ListenerRuntime | null = null;
  const releaseWaiters = new Map<
    string,
    (result: { released: boolean }) => void
  >();

  const acceptInput = (incoming: IncomingMessage): boolean => {
    if (!accepting) return false;
    const userPayload = incoming.messages.find(
      (payload) => "content" in payload,
    );
    if (!userPayload) return false;

    options.queueRuntime.resume();
    const item = options.queueRuntime.enqueue({
      kind: "message",
      source: "user",
      content: userPayload.content,
      clientMessageId:
        userPayload.client_message_id ?? `cm-local-${crypto.randomUUID()}`,
      agentId: options.agentId,
      conversationId: options.conversationId,
      actingUserId: incoming.actingUserId,
      noCoalesce: true,
    } as Parameters<QueueRuntime["enqueue"]>[0]);
    if (!item) return false;
    options.onQueueChanged();
    return true;
  };

  const release = async (): Promise<boolean> => {
    if (stopped) return true;
    accepting = false;
    await options.waitForAcceptedInputs?.();
    const runtime = ownedRuntime;
    const transport = runtime?.transport ?? runtime?.socket;
    if (!runtime || !transport || !isListenerTransportOpen(transport)) {
      options.onError?.(
        new Error("Session owner release requires a connected listener"),
      );
      return false;
    }
    const requestId = `release-${crypto.randomUUID()}`;
    const ack = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        releaseWaiters.delete(requestId);
        resolve(false);
      }, 2_000);
      timer.unref?.();
      releaseWaiters.set(requestId, ({ released }) => {
        clearTimeout(timer);
        resolve(released);
      });
    });
    transport.send(
      JSON.stringify({
        type: "release_session_owner",
        request_id: requestId,
        runtime: {
          agent_id: options.agentId,
          conversation_id: options.conversationId,
        },
      }),
    );
    if (!(await ack)) {
      options.onError?.(
        new Error("Session owner release was not acknowledged"),
      );
      return false;
    }
    stopped = true;
    dependencies.stopListener(runtime);
    return true;
  };

  const connect = async (): Promise<void> => {
    const registrationOptions = await dependencies.resolveRegistration(
      deviceId,
      connectionName,
      { allowInteractiveOAuth: false, surface: "local-session" },
    );
    const registration = await dependencies.register({
      ...registrationOptions,
      listenerInstanceId,
    });
    if (stopped) return;

    ownedRuntime = await dependencies.startListener({
      connectionId: registration.connectionId,
      wsUrl: registration.wsUrl,
      supportsSplitStatusChannels: registration.supportsSplitStatusChannels,
      supportsPairedListenerGenerations:
        registration.supportsPairedListenerGenerations,
      deviceId,
      connectionName,
      localSessionOwner: {
        agentId: options.agentId,
        conversationId: options.conversationId,
        queueRuntime: options.queueRuntime,
        acceptInput,
        abort: options.onAbort,
        onRelinquished: () => void release(),
      },
      onConnected: () => {},
      onDisconnected: () => {},
      onWsEvent: (_direction, _label, event) => {
        const ack = parseReleaseAck(event);
        if (!ack) return;
        const resolve = releaseWaiters.get(ack.requestId);
        releaseWaiters.delete(ack.requestId);
        resolve?.({ released: ack.released });
      },
      onError: (error) => options.onError?.(error),
      onNeedsReregister: () => {
        if (stopped) return;
        void connect().catch((error: unknown) => {
          options.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
      },
    });
  };

  await connect();
  return {
    stopAdmission: () => {
      accepting = false;
    },
    resumeAdmission: () => {
      if (!stopped) accepting = true;
    },
    release,
  };
}
