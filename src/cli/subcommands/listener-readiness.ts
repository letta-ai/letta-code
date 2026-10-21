export type ListenerStatus = "idle" | "receiving" | "processing";

export interface ListenerReadinessState {
  cloudReady: boolean;
  gatewayReady: boolean;
  ready: boolean;
}

export interface ListenerReadinessController {
  captureCloudEpoch(): number;
  completeCloudStartup(epoch: number): void;
  setCloudReconnecting(): void;
  setGatewayReady(ready: boolean): void;
  setStatus(status: ListenerStatus): void;
  getState(): ListenerReadinessState;
}

export async function completeListenerConnectionStartup(
  expectedConnection: import("@/websocket/listener/types").ListenerConnectionState,
  readiness: ListenerReadinessController,
  startGateway: () => Promise<void> = async () => {},
): Promise<boolean> {
  const { getActiveRuntime } = await import("@/websocket/listener/runtime");
  const runtime = getActiveRuntime();
  const connection = runtime?.connections.get(expectedConnection.id);
  const epoch = readiness.captureCloudEpoch();
  if (
    !runtime ||
    connection !== expectedConnection ||
    !connection.initialized ||
    !connection.ingressReady ||
    connection.cancellation.signal.aborted
  )
    return false;
  const { isListenerTransportOpen } = await import(
    "@/websocket/listener/transport"
  );
  if (!isListenerTransportOpen(connection.writer)) return false;
  await startGateway();
  if (getActiveRuntime()?.connections.get(connection.id) !== connection)
    return false;
  if (
    !connection.initialized ||
    !connection.ingressReady ||
    connection.cancellation.signal.aborted ||
    !isListenerTransportOpen(connection.writer)
  )
    return false;
  readiness.completeCloudStartup(epoch);
  return true;
}

export function applyGatewayLifecycleReadiness(
  readiness: ListenerReadinessController,
  event: { kind: string },
): void {
  if (event.kind === "restart_ready") {
    readiness.setGatewayReady(true);
    return;
  }
  if (
    event.kind === "exit" ||
    event.kind === "process_error" ||
    event.kind === "restart_scheduled" ||
    event.kind === "restart_exhausted"
  ) {
    readiness.setGatewayReady(false);
  }
}

/** Compose independently changing Cloud and gateway readiness into one lifecycle. */
export function createListenerReadinessController(
  requiresGateway: boolean,
  emitState: (ready: boolean) => void,
  emitStatus: (status: ListenerStatus) => void,
): ListenerReadinessController {
  let cloudReady = false;
  let gatewayReady = !requiresGateway;
  let ready = false;
  let cloudEpoch = 0;
  let status: ListenerStatus = "idle";

  const reconcile = (): void => {
    const nextReady = cloudReady && gatewayReady;
    if (nextReady === ready) return;
    ready = nextReady;
    emitState(ready);
    if (ready) emitStatus(status);
  };

  return {
    captureCloudEpoch: () => cloudEpoch,
    completeCloudStartup(epoch) {
      if (epoch !== cloudEpoch) return;
      cloudReady = true;
      reconcile();
    },
    setCloudReconnecting() {
      cloudEpoch += 1;
      cloudReady = false;
      reconcile();
    },
    setGatewayReady(nextReady) {
      gatewayReady = nextReady;
      reconcile();
    },
    setStatus(nextStatus) {
      status = nextStatus;
      if (ready) emitStatus(status);
    },
    getState: () => ({ cloudReady, gatewayReady, ready }),
  };
}

/**
 * Memoize a gateway start per listener runtime. Re-registration replaces the
 * active runtime and stops the old one, so a gateway bound to the old runtime
 * can never become ready again; close it and start fresh on the new runtime.
 */
export function createRuntimeBoundGatewayStarter<R extends object>(options: {
  getRuntime: () => R | null;
  start: (runtime: R) => Promise<void>;
  close: () => Promise<void>;
}): () => Promise<void> {
  let current: { runtime: R; promise: Promise<void> } | null = null;
  return () => {
    const runtime = options.getRuntime();
    if (!runtime) {
      return Promise.reject(
        new Error("Listener runtime is not active for ChannelGateway"),
      );
    }
    if (current?.runtime === runtime) return current.promise;
    const previous = current;
    const promise = (async () => {
      if (previous) {
        await previous.promise.catch(() => {});
        await options.close();
      }
      await options.start(runtime);
    })();
    const entry = { runtime, promise };
    current = entry;
    void promise.catch(async () => {
      if (current !== entry) return;
      try {
        await options.close();
      } catch {
        // Preserve the startup error; cleanup is best effort.
      } finally {
        if (current === entry) current = null;
      }
    });
    return promise;
  };
}
