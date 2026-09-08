import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getBackend,
  getLocalBackendStorageDir,
  isLocalBackendEnabled,
} from "@/backend";
import { settingsManager } from "@/settings-manager";
import {
  type MonitorCancellationReceipt,
  MonitorCancellationStore,
} from "@/tools/impl/monitor-cancellation-store";
import { backgroundProcesses } from "@/tools/impl/process_manager";
import { UserMonitorStopper } from "@/tools/impl/stop-monitor";
import { formatMonitorEventNotification } from "@/utils/task-notifications";
import { getOrCreateScopedRuntime } from "./conversation-runtime";
import { enqueueInboundUserMessage } from "./inbound-queue";
import {
  acquireMonitorCancellationOwner,
  isCancellationOwnerAlive,
  type MonitorCancellationOwner,
} from "./monitor-cancellation-lock";
import { scheduleQueuePump } from "./queue";
import type { ListenerTransport } from "./transport";
import type {
  ListenerRuntime,
  ProcessQueuedTurn,
  StartListenerOptions,
} from "./types";

export interface CancellationDeliveryDependencies {
  wasPersisted: (receipt: MonitorCancellationReceipt) => Promise<boolean>;
  isPending: (receipt: MonitorCancellationReceipt) => boolean;
  enqueue: (receipt: MonitorCancellationReceipt, text: string) => boolean;
  isRunning: (processId: string) => boolean;
  onError: (error: unknown) => void;
}

/** A cancellation receipt is retired only after its identified input is visible. */
export class MonitorCancellationDelivery {
  private pumping: Promise<void> | undefined;
  private disposed = false;
  constructor(
    private readonly store: MonitorCancellationStore,
    private readonly deps: CancellationDeliveryDependencies,
    private readonly owners = new Map<string, MonitorCancellationOwner>(),
  ) {}
  dispose(): void {
    this.disposed = true;
  }

  pump(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.pumping ??= this.deliver().finally(() => {
      this.pumping = undefined;
    });
    return this.pumping;
  }

  private async deliver(): Promise<void> {
    try {
      for (const stored of this.store.list()) {
        if (this.disposed) break;
        try {
          if (!["intent", "stopped", "uncertain"].includes(stored.state))
            continue;
          if (
            stored.state === "intent" &&
            this.deps.isRunning(stored.processId)
          )
            continue;
          if (
            stored.state === "intent" &&
            stored.creatorPid !== undefined &&
            stored.creatorPid !== process.pid &&
            isCancellationOwnerAlive(stored.creatorPid)
          )
            continue;
          let owner = this.owners.get(stored.processId);
          if (!owner) {
            owner =
              (await acquireMonitorCancellationOwner(
                this.store.directory,
                stored,
              )) ?? undefined;
            if (!owner) continue;
            if (this.disposed) {
              await owner.release();
              break;
            }
            this.owners.set(stored.processId, owner);
          }
          // Another holder may have completed delivery while we were acquiring.
          let receipt = this.store.read(stored.processId);
          if (
            !receipt ||
            receipt.state === "delivered" ||
            receipt.state === "failed"
          ) {
            await owner.release();
            this.owners.delete(stored.processId);
            continue;
          }
          if (receipt.state === "intent") {
            if (this.deps.isRunning(receipt.processId)) continue;
            // We may have restarted before OR after the stop. Never invent confirmation.
            receipt = { ...receipt, state: "uncertain" };
            this.store.write(receipt);
          }
          if (receipt.state !== "stopped" && receipt.state !== "uncertain")
            continue;
          if (await this.deps.wasPersisted(receipt)) {
            if (!this.disposed) {
              this.store.write({ ...receipt, state: "delivered" });
              await owner.release();
              this.owners.delete(receipt.processId);
            }
            continue;
          }
          if (this.disposed || this.deps.isPending(receipt)) continue;
          const event =
            receipt.state === "stopped"
              ? `The user cancelled this Monitor. Do not restart it unless the user asks. Notice ID: ${receipt.noticeId}.`
              : `The user requested cancellation of this Monitor, but the listener ended before cancellation was confirmed. The original Monitor is no longer running here. Do not restart it unless the user asks. Notice ID: ${receipt.noticeId}.`;
          this.deps.enqueue(
            receipt,
            formatMonitorEventNotification({
              taskId: receipt.processId,
              description: receipt.description,
              event,
            }),
          );
          // Queue rejection/drop and delivery failure leave the receipt pending.
        } catch (error) {
          this.deps.onError(error);
        }
      }
    } catch (error) {
      this.deps.onError(error);
    }
  }
}

let cachedStore:
  | {
      path: string;
      store: MonitorCancellationStore;
      stopper: UserMonitorStopper;
    }
  | undefined;
export function getMonitorCancellationServices() {
  const env = settingsManager.getSettings().env;
  const server = isLocalBackendEnabled()
    ? `local:${getLocalBackendStorageDir()}`
    : process.env.LETTA_SETTINGS_BASE_URL ||
      env?.LETTA_SETTINGS_BASE_URL ||
      process.env.LETTA_BASE_URL ||
      env?.LETTA_BASE_URL ||
      "https://api.letta.com";
  const namespace = createHash("sha256")
    .update(server.replace(/\/$/, ""))
    .digest("hex");
  const path = join(
    process.env.LETTA_HOME || join(homedir(), ".letta"),
    "monitor-cancellations",
    namespace,
  );
  if (!cachedStore || cachedStore.path !== path) {
    const store = new MonitorCancellationStore(path);
    cachedStore = { path, store, stopper: new UserMonitorStopper(store) };
  }
  return cachedStore;
}

export async function wasCancellationInputPersisted(
  receipt: MonitorCancellationReceipt,
): Promise<boolean> {
  let before: string | undefined;
  // Inspect at most 1,000 recent messages. A missed old/compacted receipt is
  // replayed with the same notice ID: recovery is deliberately at-least-once.
  for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
    const page = await getBackend().listConversationMessages(
      receipt.runtime.conversation_id,
      {
        agent_id: receipt.runtime.agent_id,
        before,
        order: "desc",
        limit: 100,
      },
    );
    const candidate = page as unknown as {
      getPaginatedItems?: () => unknown[];
      items?: unknown[];
    };
    const rows: unknown[] = Array.isArray(page)
      ? page
      : (candidate.getPaginatedItems?.() ?? candidate.items ?? []);
    if (
      rows.some(
        (row) =>
          row &&
          typeof row === "object" &&
          (row as { otid?: string }).otid === receipt.noticeId,
      )
    )
      return true;
    const last = rows.at(-1) as { id?: string } | undefined;
    if (rows.length < 100 || !last?.id || last.id === before) return false;
    before = last.id;
  }
  return false;
}

const deliveries = new WeakMap<ListenerRuntime, MonitorCancellationDelivery>();
const cleanups = new WeakMap<ListenerRuntime, () => void>();
const starters = new WeakMap<ListenerRuntime, () => void>();
// Keep ownership and submission identity through transport/service reinstalls.
// Pending locks are not released on disposal: queued input can still be running.
const runtimeOwners = new WeakMap<
  ListenerRuntime,
  Map<string, MonitorCancellationOwner>
>();
const runtimeSubmitted = new WeakMap<ListenerRuntime, Set<string>>();
export function clearMonitorCancellationDelivery(
  runtime: ListenerRuntime,
): void {
  cleanups.get(runtime)?.();
  cleanups.delete(runtime);
  starters.delete(runtime);
}
export function pumpMonitorCancellations(
  runtime: ListenerRuntime,
): Promise<void> {
  starters.get(runtime)?.();
  return deliveries.get(runtime)?.pump() ?? Promise.resolve();
}

type DeliveryInstallation = {
  runtime: ListenerRuntime;
  processTransport: ListenerTransport;
  opts: StartListenerOptions;
  processQueuedTurn: ProcessQueuedTurn;
};

export function installMonitorCancellationDelivery(
  params: DeliveryInstallation,
): () => void {
  clearMonitorCancellationDelivery(params.runtime);
  let stopDelivery: (() => void) | undefined;
  // Embedded listeners can attach before application settings finish loading.
  // Do not choose a receipt namespace from incomplete configuration.
  const start = () => {
    if (stopDelivery || !settingsManager.isReady) return;
    stopDelivery = startMonitorCancellationDelivery(params);
    clearInterval(timer);
  };
  const timer = setInterval(start, 30_000);
  timer.unref();
  const cleanup = () => {
    clearInterval(timer);
    stopDelivery?.();
    starters.delete(params.runtime);
  };
  starters.set(params.runtime, start);
  cleanups.set(params.runtime, cleanup);
  start();
  return cleanup;
}

function startMonitorCancellationDelivery(
  params: DeliveryInstallation,
): () => void {
  const { runtime, processTransport, opts, processQueuedTurn } = params;
  const { store } = getMonitorCancellationServices();
  const submitted = runtimeSubmitted.get(runtime) ?? new Set<string>();
  runtimeSubmitted.set(runtime, submitted);
  const owners =
    runtimeOwners.get(runtime) ?? new Map<string, MonitorCancellationOwner>();
  runtimeOwners.set(runtime, owners);
  const scoped = (receipt: MonitorCancellationReceipt) =>
    getOrCreateScopedRuntime(
      runtime,
      receipt.runtime.agent_id,
      receipt.runtime.conversation_id,
    );
  const delivery = new MonitorCancellationDelivery(
    store,
    {
      wasPersisted: wasCancellationInputPersisted,
      isRunning: (processId) =>
        backgroundProcesses.get(processId)?.status === "running",
      isPending(receipt) {
        const target = scoped(receipt);
        if (
          target.queueRuntime
            .peek()
            .some((item) => item.clientMessageId === receipt.noticeId)
        )
          return true;
        return (
          submitted.has(receipt.noticeId) &&
          (target.isProcessing ||
            target.queuePumpActive ||
            target.queuePumpScheduled)
        );
      },
      enqueue(receipt, text) {
        const target = scoped(receipt);
        const accepted = enqueueInboundUserMessage(
          target,
          {
            type: "message",
            agentId: receipt.runtime.agent_id,
            conversationId: receipt.runtime.conversation_id,
            actingUserId: receipt.runtime.acting_user_id,
            noCoalesce: true,
            messages: [
              {
                role: "user",
                content: text,
                otid: receipt.noticeId,
                client_message_id: receipt.noticeId,
              },
            ],
          },
          receipt.runtime.acting_user_id,
        );
        if (accepted) {
          submitted.add(receipt.noticeId);
          scheduleQueuePump(target, processTransport, opts, processQueuedTurn);
        }
        return accepted;
      },
      onError(error) {
        console.warn(
          "[Monitor cancellation] Delivery remains pending:",
          error instanceof Error ? error.message : String(error),
        );
      },
    },
    owners,
  );
  deliveries.set(runtime, delivery);
  const timer = setInterval(() => void delivery.pump(), 30_000);
  timer.unref();
  void delivery.pump();
  const cleanup = () => {
    clearInterval(timer);
    delivery.dispose();
    if (deliveries.get(runtime) === delivery) deliveries.delete(runtime);
  };
  return cleanup;
}
