import type {
  InputCreateMessagePayload,
  RuntimeInputStateMessage,
  RuntimeInputStatus,
} from "@/types/protocol_v2";
import { TO_SUBSCRIBERS } from "./connection";
import { emitProtocolV2Message } from "./protocol-outbound";
import { isListenerTransportOpen } from "./transport";
import type { ConversationRuntime, IncomingMessage } from "./types";

const MAX_RUNTIME_INPUT_STATES = 4096;

type InputState = {
  requestId: string;
  payloadFingerprint: string;
  status: "pending" | RuntimeInputStatus;
  admission?: "direct" | "queued";
  runId?: string;
  error?: string;
};

const inputStateMaps = new WeakMap<object, Map<string, InputState>>();

function stateKey(runtime: ConversationRuntime, clientMessageId: string) {
  return `${runtime.key}::${clientMessageId}`;
}

function stateMap(runtime: ConversationRuntime): Map<string, InputState> {
  let states = inputStateMaps.get(runtime.listener);
  if (!states) {
    states = new Map();
    inputStateMaps.set(runtime.listener, states);
  }
  return states;
}

function emitState(
  runtime: ConversationRuntime,
  clientMessageId: string,
  state: InputState,
): void {
  if (state.status === "pending") return;
  const transport = runtime.listener.transport ?? runtime.listener.socket;
  if (!transport || !isListenerTransportOpen(transport)) return;
  const message: Omit<
    RuntimeInputStateMessage,
    "runtime" | "event_seq" | "emitted_at" | "idempotency_key"
  > = {
    type: "runtime_input_state",
    request_id: state.requestId,
    client_message_id: clientMessageId,
    status: state.status,
    ...(state.admission ? { admission: state.admission } : {}),
    ...(state.runId ? { run_id: state.runId } : {}),
    ...(state.error ? { error: state.error } : {}),
  };
  emitProtocolV2Message(
    transport,
    runtime,
    message,
    { agent_id: runtime.agentId, conversation_id: runtime.conversationId },
    TO_SUBSCRIBERS,
  );
}

function transition(
  runtime: ConversationRuntime,
  clientMessageIds: string[],
  status: RuntimeInputStatus,
  details: Partial<InputState> = {},
): void {
  const states = stateMap(runtime);
  for (const clientMessageId of clientMessageIds) {
    const state = states.get(stateKey(runtime, clientMessageId));
    if (!state || state.status === "core_owned") continue;
    Object.assign(state, details, { status });
    emitState(runtime, clientMessageId, state);
  }
}

function reject(
  runtime: ConversationRuntime,
  requestId: string,
  clientMessageIds: string[],
  error: string,
): void {
  for (const clientMessageId of clientMessageIds) {
    emitState(runtime, clientMessageId, {
      requestId,
      payloadFingerprint: "",
      status: "rejected",
      error,
    });
  }
}

function clientMessageIds(payload: InputCreateMessagePayload): string[] {
  return [
    ...new Set(
      payload.messages.flatMap((message) =>
        "content" in message &&
        typeof message.client_message_id === "string" &&
        message.client_message_id.length > 0
          ? [message.client_message_id]
          : [],
      ),
    ),
  ];
}

export function prepareRuntimeInputCommand(
  runtime: ConversationRuntime,
  payload: InputCreateMessagePayload,
  requestId: string | undefined,
  incoming: IncomingMessage,
) {
  const ids = clientMessageIds(payload);
  incoming.clientMessageIds = ids;
  if (!requestId) return inputCallbacks(runtime, ids);
  if (ids.length === 0) return null;

  const states = stateMap(runtime);
  const fingerprint = JSON.stringify(payload);
  const existing = ids.map((id) => states.get(stateKey(runtime, id)));
  if (
    existing.some((state) => state && state.payloadFingerprint !== fingerprint)
  ) {
    reject(runtime, requestId, ids, "client_message_id payload conflict");
    return null;
  }
  if (existing.some(Boolean) && !existing.every(Boolean)) {
    reject(runtime, requestId, ids, "client_message_id set changed on retry");
    return null;
  }
  if (existing.every(Boolean)) {
    if (
      !existing.every(
        (state) => state?.status === "dropped" || state?.status === "rejected",
      )
    ) {
      for (const [index, id] of ids.entries()) {
        const state = existing[index] as InputState;
        state.requestId = requestId;
        emitState(runtime, id, state);
      }
      return null;
    }
    for (const id of ids) states.delete(stateKey(runtime, id));
  }

  while (states.size + ids.length > MAX_RUNTIME_INPUT_STATES) {
    const oldest = states.keys().next().value;
    if (typeof oldest !== "string") break;
    states.delete(oldest);
  }
  for (const id of ids) {
    states.set(stateKey(runtime, id), {
      requestId,
      payloadFingerprint: fingerprint,
      status: "pending",
    });
  }
  return inputCallbacks(runtime, ids);
}

function inputCallbacks(runtime: ConversationRuntime, ids: string[]) {
  return {
    onAdmitted: (admission: "direct" | "queued") =>
      transition(runtime, ids, "admitted", { admission, error: undefined }),
    onDropped: (error: string) =>
      transition(runtime, ids, "dropped", { error }),
  };
}

export function markCoreOwned(
  runtime: ConversationRuntime,
  clientMessageIds: string[],
  runId: string,
): void {
  transition(runtime, clientMessageIds, "core_owned", { runId });
}

export function markRuntimeInputsDropped(
  runtime: ConversationRuntime,
  clientMessageIds: string[],
  error: string,
): void {
  transition(runtime, clientMessageIds, "dropped", { error });
}
