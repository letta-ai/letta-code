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
  /** Override only for deterministic claim acknowledgement tests. */
  claimAckTimeoutMs?: number;
}

export interface LocalSessionOwnerHandle {
  /** Resolves true only after Cloud positively acknowledges this scope claim. */
  ready(signal?: AbortSignal): Promise<boolean>;
  /** Force local shutdown; an unknown Cloud claim may remain sticky for recovery. */
  forceStop(): void;
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

function waitForReadyOrAbort(
  readiness: Promise<boolean>,
  signal?: AbortSignal,
): Promise<boolean> {
  if (!signal) return readiness;
  if (signal.aborted)
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<boolean>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    void readiness.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
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
  const claimWaiters = new Map<
    string,
    (result: { received: boolean; claimed: boolean }) => void
  >();
  const createReadiness = () => {
    let resolve!: (supportedAndClaimed: boolean) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    // Cancellation can precede a consumer attaching; keep Node/Bun from
    // reporting that intentional fail-closed rejection as unhandled.
    void promise.catch(() => {});
    return { promise, resolve, reject, settled: false };
  };
  let readiness = createReadiness();
  let connected = false;
  let connectionEpoch = 0;
  let ownershipSupported = false;
  let claimed = false;
  let claimInFlight = false;
  let lastClaimDefinitivelyDenied = false;
  let releaseRequested = false;
  let retryClaimTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveReleaseClaimDisposition:
    | ((disposition: "claimed" | "denied" | "unsupported") => void)
    | null = null;
  const settleReady = (supportedAndClaimed: boolean): void => {
    if (readiness.settled) return;
    readiness.settled = true;
    readiness.resolve(supportedAndClaimed);
  };
  const stopWithoutOwnedGeneration = (): void => {
    stopped = true;
    if (retryClaimTimer) clearTimeout(retryClaimTimer);
    if (!readiness.settled) {
      readiness.settled = true;
      readiness.reject(
        new Error("Local session owner claim was cancelled before ownership"),
      );
    }
    if (ownedRuntime) dependencies.stopListener(ownedRuntime);
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
    releaseRequested = true;
    releasePromise = (async () => {
      const disposition = claimed
        ? "claimed"
        : !ownershipSupported && stopped
          ? "unsupported"
          : lastClaimDefinitivelyDenied && !claimInFlight
            ? "denied"
            : await new Promise<"claimed" | "denied" | "unsupported">(
                (resolve) => {
                  resolveReleaseClaimDisposition = resolve;
                },
              );
      if (disposition === "denied") {
        stopWithoutOwnedGeneration();
        return true;
      }
      if (disposition === "unsupported") return true;
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
    if (stopped || claimed || claimInFlight || !connected) return;
    const runtime = ownedRuntime;
    const transport = runtime?.transport ?? runtime?.socket;
    if (!transport || !isListenerTransportOpen(transport)) return;
    claimInFlight = true;
    const attemptConnectionEpoch = connectionEpoch;
    lastClaimDefinitivelyDenied = false;
    const requestId = `claim-${crypto.randomUUID()}`;
    const claimResult = new Promise<{
      received: boolean;
      claimed: boolean;
    }>((resolve) => {
      const timer = setTimeout(() => {
        claimWaiters.delete(requestId);
        resolve({ received: false, claimed: false });
      }, options.claimAckTimeoutMs ?? 2_000);
      claimWaiters.set(requestId, (result) => {
        clearTimeout(timer);
        resolve(result);
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
    const result = await claimResult;
    claimInFlight = false;
    const appliesToCurrentConnection =
      connected && attemptConnectionEpoch === connectionEpoch;
    if (appliesToCurrentConnection && result.received && result.claimed) {
      claimed = true;
      settleReady(true);
      resolveReleaseClaimDisposition?.("claimed");
      resolveReleaseClaimDisposition = null;
      return;
    }
    lastClaimDefinitivelyDenied = appliesToCurrentConnection && result.received;
    if (releaseRequested && lastClaimDefinitivelyDenied) {
      resolveReleaseClaimDisposition?.("denied");
      resolveReleaseClaimDisposition = null;
      return;
    }
    options.onError?.(
      new Error("Session owner claim was not acknowledged; retrying"),
    );
    if (!stopped && !claimed) {
      retryClaimTimer = setTimeout(
        () => void claim(),
        options.releaseRetryMs ?? 1_000,
      );
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
      resolveReleaseClaimDisposition?.("unsupported");
      resolveReleaseClaimDisposition = null;
      return;
    }
    ownershipSupported = true;

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
        connectionEpoch += 1;
        void claim();
      },
      onDisconnected: () => {
        connected = false;
        connectionEpoch += 1;
        if (claimed && !stopped) {
          claimed = false;
          readiness = createReadiness();
        }
      },
      onWsEvent: (_direction, _label, event) => {
        const ack = parseOwnerAck(event);
        if (!ack) return;
        if (ack.type === "claimed") {
          const resolve = claimWaiters.get(ack.requestId);
          claimWaiters.delete(ack.requestId);
          resolve?.({ received: true, claimed: ack.accepted });
          return;
        }
        const resolve = releaseWaiters.get(ack.requestId);
        releaseWaiters.delete(ack.requestId);
        resolve?.({ released: ack.accepted });
      },
      onError: (error) => options.onError?.(error),
      onNeedsReregister: () => {
        if (stopped) return;
        connected = false;
        connectionEpoch += 1;
        if (claimed) {
          claimed = false;
          readiness = createReadiness();
        }
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
    ready: (signal) => waitForReadyOrAbort(readiness.promise, signal),
    forceStop: () => {
      accepting = false;
      if (!stopped) stopWithoutOwnedGeneration();
    },
    stopAdmission: () => {
      accepting = false;
    },
    resumeAdmission: () => {
      if (!stopped) accepting = true;
    },
    release,
  };
}
