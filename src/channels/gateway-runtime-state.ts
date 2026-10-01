import type { RuntimeScope } from "@/types/app-server-protocol";
import type { GatewayAssistantTextAccumulator } from "./gateway-assistant-relay";
import type { GatewayToolScope } from "./gateway-runtime-tool-scopes";
import { uniqueLifecycleSources } from "./gateway-sources";
import type {
  ChannelGatewayModelStatus,
  ChannelGatewayRichDraft,
} from "./gateway-types";
import type { MessageChannelIdempotencyScope } from "./message-channel-idempotency";
import type { createChannelTurnProgressBuilder } from "./progress-builder";
import type { ChannelTurnSource } from "./types";

const MAX_ACCEPTED_CLIENT_MESSAGE_IDS = 2048;

export type ActiveGatewayTurn = {
  batchId: string;
  routingSources: ChannelTurnSource[];
  lifecycleSources: ChannelTurnSource[];
  progress: ReturnType<typeof createChannelTurnProgressBuilder>;
  richDraft: ChannelGatewayRichDraft | null;
  runId?: string;
  assistantText: GatewayAssistantTextAccumulator;
  idempotencyScope: MessageChannelIdempotencyScope;
  relayEligible: boolean;
  toolScopes: GatewayToolScope[];
};

export type GatewayRuntimeState = {
  runtime: RuntimeScope;
  pendingSourcesByClientMessageId: Map<
    string,
    {
      sources: ChannelTurnSource[];
      disposition: "submitting" | "queued";
      automaticRelay: boolean;
      toolScope?: GatewayToolScope;
      removalDisposition?: "dequeued" | "cancelled";
    }
  >;
  active: ActiveGatewayTurn | null;
  registrationSignature: string | null;
  registration: Promise<void> | null;
  routedSources: ChannelTurnSource[];
  replayedControlRequestIds: Set<string>;
  submissionQueue: Promise<void>;
  hookQueue: Promise<void> | null;
  acceptedClientMessageIds: Set<string>;
  modelStatus: ChannelGatewayModelStatus | null;
};

export function gatewayRuntimeKey(
  runtime: RuntimeScope<string | null>,
): string {
  return `${runtime.agent_id}:${runtime.conversation_id}`;
}

export function hasAgentRuntime<
  T extends { runtime?: RuntimeScope<string | null> | null },
>(value: T): value is T & { runtime: RuntimeScope } {
  return !!value.runtime?.agent_id;
}

export function hasGatewayRuntimeWork(
  state: GatewayRuntimeState | undefined,
): boolean {
  return Boolean(
    state && (state.active || state.pendingSourcesByClientMessageId.size > 0),
  );
}

export function rememberAcceptedClientMessageId(
  state: GatewayRuntimeState,
  clientMessageId: string,
): void {
  state.acceptedClientMessageIds.delete(clientMessageId);
  state.acceptedClientMessageIds.add(clientMessageId);
  if (state.acceptedClientMessageIds.size <= MAX_ACCEPTED_CLIENT_MESSAGE_IDS)
    return;
  const oldest = state.acceptedClientMessageIds.values().next().value;
  if (oldest) state.acceptedClientMessageIds.delete(oldest);
}

export function remainingGatewaySources(
  state: GatewayRuntimeState,
): ChannelTurnSource[] {
  return uniqueLifecycleSources([
    ...(state.active?.lifecycleSources ?? []),
    ...Array.from(state.pendingSourcesByClientMessageId.values()).flatMap(
      (pending) => pending.sources,
    ),
  ]);
}
