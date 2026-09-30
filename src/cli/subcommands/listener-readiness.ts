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
  connectionId: string,
  readiness: ListenerReadinessController,
  startGateway: () => Promise<void>,
): Promise<boolean> {
  const { getActiveRuntime } = await import("@/websocket/listener/runtime");
  const runtime = getActiveRuntime();
  const connection = runtime?.connections.get(connectionId);
  const epoch = readiness.captureCloudEpoch();
  if (!runtime || !connection) return false;
  await startGateway();
  if (getActiveRuntime()?.connections.get(connectionId) !== connection)
    return false;
  readiness.completeCloudStartup(epoch);
  return true;
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
