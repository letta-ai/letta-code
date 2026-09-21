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
  isProcessing: () => boolean;
  /** Resolves only after every input accepted before admission stopped is safe. */
  waitForAcceptedInputs?: () => Promise<void>;
  onError?: (error: Error) => void;
  /** Override only for deterministic retry tests. */
  releaseRetryMs?: number;
}

export interface LocalSessionOwnerHandle {
  /** Resolves true only after Cloud positively acknowledges this scope claim. */
  ready(): Promise<boolean>;
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

function parseOwnerAck(
  event: unknown,
):
  | { type: "claimed"; requestId: string; accepted: boolean }
  | { type: "released"; requestId: string; accepted: boolean }
  | null {
  if (typeof event !== "object" || event === null || !("type" in event))
    return null;
  try {
    const parsed = (
      event.type === "_ws_unparseable" &&
      "raw" in event &&
      typeof event.raw === "string"
        ? JSON.parse(event.raw)
        : event
    ) as {
      type?: string;
      request_id?: string;
      released?: boolean;
    };
    if (!parsed.request_id) return null;
    if (parsed.type === "session_owner_claimed") {
      return {
        type: "claimed",
        requestId: parsed.request_id,
        accepted: (parsed as { claimed?: boolean }).claimed === true,
      };
    }
    return parsed.type === "session_owner_released"
      ? {
          type: "released",
          requestId: parsed.request_id,
          accepted: parsed.released === true,
        }
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
  const claimWaiters = new Map<string, (claimed: boolean) => void>();
  let resolveReady!: (supportedAndClaimed: boolean) => void;
  const readyPromise = new Promise<boolean>((resolve) => {
    resolveReady = resolve;
  });
  let readySettled = false;
  let connected = false;
  let claimInFlight = false;
  const settleReady = (supportedAndClaimed: boolean): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(supportedAndClaimed);
  };

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

  let releasePromise: Promise<boolean> | null = null;
  const release = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(true);
    if (releasePromise) return releasePromise;
    accepting = false;
    releasePromise = (async () => {
      await readyPromise;
      if (stopped) return true;
      await options.waitForAcceptedInputs?.();
      while (!stopped) {
        const runtime = ownedRuntime;
        const transport = runtime?.transport ?? runtime?.socket;
        if (!runtime || !transport || !isListenerTransportOpen(transport)) {
          options.onError?.(
            new Error("Session owner release requires a connected listener"),
          );
        } else {
          const requestId = `release-${crypto.randomUUID()}`;
          const ack = new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => {
              releaseWaiters.delete(requestId);
              resolve(false);
            }, 2_000);
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
          if (await ack) {
            stopped = true;
            dependencies.stopListener(runtime);
            return true;
          }
          options.onError?.(
            new Error("Session owner release was not acknowledged; retrying"),
          );
        }
        await new Promise((resolve) =>
          setTimeout(resolve, options.releaseRetryMs ?? 1_000),
        );
      }
      return true;
    })();
    return releasePromise;
  };

  const claim = async (): Promise<void> => {
    if (stopped || readySettled || claimInFlight || !connected) return;
    const runtime = ownedRuntime;
    const transport = runtime?.transport ?? runtime?.socket;
    if (!transport || !isListenerTransportOpen(transport)) return;
    claimInFlight = true;
    const requestId = `claim-${crypto.randomUUID()}`;
    const claimed = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        claimWaiters.delete(requestId);
        resolve(false);
      }, 2_000);
      claimWaiters.set(requestId, (accepted) => {
        clearTimeout(timer);
        resolve(accepted);
      });
    });
    transport.send(
      JSON.stringify({
        type: "claim_session_owner",
        request_id: requestId,
        runtime: {
          agent_id: options.agentId,
          conversation_id: options.conversationId,
        },
      }),
    );
    const accepted = await claimed;
    claimInFlight = false;
    if (accepted) {
      settleReady(true);
      return;
    }
    options.onError?.(
      new Error("Session owner claim was not acknowledged; retrying"),
    );
    if (!stopped && !readySettled) {
      setTimeout(() => void claim(), options.releaseRetryMs ?? 1_000);
    }
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
    // Older Cloud deployments ignore owner status and cannot acknowledge a
    // generation-guarded release. Treat registration as a no-op there so a
    // normal one-shot process never waits forever for an unsupported ACK.
    if (!registration.supportsLocalSessionOwnership) {
      stopped = true;
      settleReady(false);
      return;
    }

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
        isProcessing: options.isProcessing,
        onRelinquished: () => void release(),
      },
      onConnected: () => {
        connected = true;
        void claim();
      },
      onDisconnected: () => {
        connected = false;
      },
      onWsEvent: (_direction, _label, event) => {
        const ack = parseOwnerAck(event);
        if (!ack) return;
        if (ack.type === "claimed") {
          const resolve = claimWaiters.get(ack.requestId);
          claimWaiters.delete(ack.requestId);
          resolve?.(ack.accepted);
          return;
        }
        const resolve = releaseWaiters.get(ack.requestId);
        releaseWaiters.delete(ack.requestId);
        resolve?.({ released: ack.accepted });
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
    if (connected) void claim();
  };

  await connect();
  return {
    ready: () => readyPromise,
    stopAdmission: () => {
      accepting = false;
    },
    resumeAdmission: () => {
      if (!stopped) accepting = true;
    },
    release,
  };
}
