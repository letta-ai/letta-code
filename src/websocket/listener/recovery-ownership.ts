import { getAgentRuntimeStatus } from "@/backend/api/agents";
import { apiRequest } from "@/backend/api/request";
import { debugWarn } from "@/utils/debug";
import {
  isInboundTeleportExpected,
  isRuntimeTeleportPending,
} from "./teleport";
import type { ConversationRuntime } from "./types";

const RECOVERY_CLAIM_TTL_MS = 15_000;
const RECOVERY_CLAIM_RENEW_MS = 5_000;
const RECOVERY_CLAIM_EXPIRY_MARGIN_MS = 500;

type RecoveryClaimResponse = {
  token?: string;
  fence?: number;
  expires_at?: string | number;
  released?: boolean;
  completed?: boolean;
};

type RecoveryClaimAction = "acquire" | "renew" | "release" | "complete";

type RecoveryClaimRequest = (
  agentId: string,
  body: {
    action: RecoveryClaimAction;
    conversation_id: string;
    connection_id: string;
    connection_generation: string;
    token?: string;
    ttl_seconds?: number;
  },
) => Promise<RecoveryClaimResponse>;

export type RecoveryClaimDependencies = {
  request?: RecoveryClaimRequest;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancel?: (timer: unknown) => void;
  now?: () => number;
};

const defaultRecoveryClaimRequest: RecoveryClaimRequest = (agentId, body) =>
  apiRequest(
    "POST",
    `/v1/agents/${encodeURIComponent(agentId)}/recovery-claims`,
    body,
    { signal: AbortSignal.timeout(5_000) },
  );

/** A token-exact, connection-bound Cloud recovery claim. */
export class RecoveryClaim {
  private timer: unknown;
  private renewalInFlight = false;
  private stopped = false;
  private ownershipLost = false;
  private localExpiresAt: number;

  constructor(
    readonly runtime: ConversationRuntime,
    readonly agentId: string,
    readonly conversationId: string,
    readonly connectionId: string,
    readonly connectionGeneration: string,
    readonly token: string,
    readonly fence: number,
    private readonly request: RecoveryClaimRequest,
    private readonly schedule: (
      callback: () => void,
      delayMs: number,
    ) => unknown,
    private readonly cancel: (timer: unknown) => void,
    private readonly onLost: () => void,
    private readonly now: () => number,
    localExpiresAt: number,
  ) {
    this.localExpiresAt = localExpiresAt;
    this.scheduleRenewal();
  }

  get owned(): boolean {
    return (
      !this.ownershipLost &&
      !this.stopped &&
      this.now() < this.localExpiresAt &&
      this.runtime.listener.connectionId === this.connectionId &&
      this.runtime.listener.connectionGeneration === this.connectionGeneration
    );
  }

  private lose(): void {
    if (this.ownershipLost) return;
    this.ownershipLost = true;
    this.stopTimer();
    this.onLost();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      this.cancel(this.timer);
      this.timer = undefined;
    }
  }

  private scheduleRenewal(): void {
    if (this.stopped || this.ownershipLost) return;
    this.timer = this.schedule(() => {
      void this.renew();
    }, RECOVERY_CLAIM_RENEW_MS);
  }

  async renew(): Promise<boolean> {
    if (!this.owned || this.renewalInFlight) {
      if (!this.owned) this.lose();
      return false;
    }
    this.stopTimer();
    this.renewalInFlight = true;
    const requestedAt = this.now();
    try {
      const response = await this.request(this.agentId, {
        action: "renew",
        conversation_id: this.conversationId,
        connection_id: this.connectionId,
        connection_generation: this.connectionGeneration,
        token: this.token,
        ttl_seconds: RECOVERY_CLAIM_TTL_MS / 1_000,
      });
      if (
        response.token !== this.token ||
        response.fence !== this.fence ||
        typeof response.expires_at !== "number" ||
        this.runtime.listener.connectionId !== this.connectionId ||
        this.runtime.listener.connectionGeneration !== this.connectionGeneration
      ) {
        this.lose();
        return false;
      }
      this.localExpiresAt =
        requestedAt + RECOVERY_CLAIM_TTL_MS - RECOVERY_CLAIM_EXPIRY_MARGIN_MS;
      return true;
    } catch (error) {
      debugWarn("recovery", "Recovery claim renewal failed", error);
      this.lose();
      return false;
    } finally {
      this.renewalInFlight = false;
      this.scheduleRenewal();
    }
  }

  async complete(): Promise<boolean> {
    if (!this.owned) {
      this.lose();
      return false;
    }
    this.stopped = true;
    this.stopTimer();
    try {
      const response = await this.request(this.agentId, {
        action: "complete",
        conversation_id: this.conversationId,
        connection_id: this.connectionId,
        connection_generation: this.connectionGeneration,
        token: this.token,
      });
      return response.completed === true;
    } catch (error) {
      debugWarn("recovery", "Recovery claim completion failed", error);
      this.lose();
      return false;
    }
  }

  async release(): Promise<void> {
    if (!this.owned) {
      this.abandon();
      return;
    }
    this.stopped = true;
    this.stopTimer();
    try {
      await this.request(this.agentId, {
        action: "release",
        conversation_id: this.conversationId,
        connection_id: this.connectionId,
        connection_generation: this.connectionGeneration,
        token: this.token,
      });
    } catch (error) {
      debugWarn("recovery", "Recovery claim release failed", error);
    }
  }

  abandon(): void {
    this.stopped = true;
    this.stopTimer();
  }
}

export async function acquireRecoveryClaim(
  runtime: ConversationRuntime,
  onLost: () => void = () => {},
  dependencies: RecoveryClaimDependencies = {},
): Promise<RecoveryClaim | null> {
  const connectionId = runtime.listener.connectionId;
  const connectionGeneration = runtime.listener.connectionGeneration;
  // Embedded/local listeners do not have Cloud claim identities.
  if (!connectionId?.startsWith("conn-")) return null;
  if (!connectionGeneration) return null;
  if (!runtime.agentId) return null;
  const request = dependencies.request ?? defaultRecoveryClaimRequest;
  const now = dependencies.now ?? Date.now;
  try {
    const requestedAt = now();
    const response = await request(runtime.agentId, {
      action: "acquire",
      conversation_id: runtime.conversationId,
      connection_id: connectionId,
      connection_generation: connectionGeneration,
      ttl_seconds: RECOVERY_CLAIM_TTL_MS / 1_000,
    });
    if (
      typeof response.token !== "string" ||
      typeof response.fence !== "number" ||
      typeof response.expires_at !== "number"
    ) {
      return null;
    }
    if (
      runtime.listener.connectionId !== connectionId ||
      runtime.listener.connectionGeneration !== connectionGeneration ||
      hasRecoveryHandoff(runtime)
    ) {
      try {
        await request(runtime.agentId, {
          action: "release",
          conversation_id: runtime.conversationId,
          connection_id: connectionId,
          connection_generation: connectionGeneration,
          token: response.token,
        });
      } catch (error) {
        debugWarn("recovery", "Stale recovery claim release failed", error);
      }
      return null;
    }
    return new RecoveryClaim(
      runtime,
      runtime.agentId,
      runtime.conversationId,
      connectionId,
      connectionGeneration,
      response.token,
      response.fence,
      request,
      dependencies.schedule ??
        ((callback, delay) => setTimeout(callback, delay)),
      dependencies.cancel ??
        ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>)),
      onLost,
      now,
      requestedAt + RECOVERY_CLAIM_TTL_MS - RECOVERY_CLAIM_EXPIRY_MARGIN_MS,
    );
  } catch (error) {
    debugWarn("recovery", "Recovery claim acquisition failed", error);
    return null;
  }
}

function hasRecoveryHandoff(runtime: ConversationRuntime): boolean {
  return (
    isInboundTeleportExpected(runtime) ||
    isRuntimeTeleportPending(
      runtime.listener,
      runtime.agentId,
      runtime.conversationId,
    )
  );
}

/** Recovery observes pending work; it must not take it from another listener. */
export async function canRecoverConversation(
  runtime: ConversationRuntime,
  readStatus = getAgentRuntimeStatus,
): Promise<boolean> {
  if (hasRecoveryHandoff(runtime)) return false;
  // Cloud relay registration assigns conn-* IDs. Embedded App Servers have
  // only local connection IDs, with no server-side ownership record.
  // Do not infer this from the API hostname: CI runs Cloud on a local URL.
  const connectionId = runtime.listener.connectionId;
  if (!connectionId?.startsWith("conn-")) {
    return true;
  }
  if (!runtime.agentId) return true;
  try {
    const snapshot = await readStatus(
      runtime.agentId,
      [runtime.conversationId],
      AbortSignal.timeout(5_000),
    );
    if (
      hasRecoveryHandoff(runtime) ||
      runtime.listener.connectionId !== connectionId
    )
      return false;
    const status = snapshot.statuses.find(
      (entry) => entry.conversation_id === runtime.conversationId,
    );
    if (!status || status.has_conflicting_listeners) return false;
    if (status.active_harness)
      return status.active_harness.connection_id === connectionId;
    // A delivery or unclaimed live run is not an ownerless crashed turn.
    return status.state === "IDLE";
  } catch (error) {
    debugWarn(
      "recovery",
      "Could not verify conversation recovery ownership",
      error,
    );
    return false;
  }
}
