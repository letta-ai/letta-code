import { createHash } from "node:crypto";
import type {
  InputCreateMessagePayload,
  RuntimeInputStateMessage,
  RuntimeInputStatus,
} from "@/types/protocol_v2";
import { TO_SUBSCRIBERS } from "./connection";
import { emitProtocolV2Message } from "./protocol-outbound";
import { isListenerTransportOpen } from "./transport";
import type { TurnLease } from "./turn-lifecycle";
import type {
  ConversationRuntime,
  IncomingMessage,
  RuntimeInputStateRecord,
} from "./types";

const MAX_RUNTIME_INPUT_STATES = 4096;

export function getRuntimeInputRunId(
  chunk: unknown,
  errorInfo?: unknown,
): string | undefined {
  const chunkRunId = (chunk as { run_id?: unknown } | null)?.run_id;
  if (typeof chunkRunId === "string") return chunkRunId;
  const errorRunId = (errorInfo as { run_id?: unknown } | null)?.run_id;
  return typeof errorRunId === "string" ? errorRunId : undefined;
}

function stateKey(runtime: ConversationRuntime, clientMessageId: string) {
  return `${runtime.key}::${clientMessageId}`;
}

function stateMap(
  runtime: ConversationRuntime,
): Map<string, RuntimeInputStateRecord> {
  if (!runtime.listener.runtimeInputStates) {
    runtime.listener.runtimeInputStates = new Map();
  }
  return runtime.listener.runtimeInputStates;
}

function emitState(
  runtime: ConversationRuntime,
  clientMessageId: string,
  state: RuntimeInputStateRecord,
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
  details: Partial<RuntimeInputStateRecord> = {},
): void {
  const states = runtime.listener.runtimeInputStates;
  if (!states) return;
  for (const clientMessageId of clientMessageIds) {
    const state = states.get(stateKey(runtime, clientMessageId));
    if (!state || state.status === "core_owned") continue;
    if (
      state.status === status &&
      state.admission === details.admission &&
      state.runId === details.runId &&
      state.error === details.error
    ) {
      continue;
    }
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

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function payloadFingerprint(payload: InputCreateMessagePayload): string {
  return createHash("sha256")
    .update(canonicalJson(payload))
    .digest("base64url");
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
  const fingerprint = payloadFingerprint(payload);
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
    if (!existing.every((state) => state?.status === "dropped")) {
      for (const [index, id] of ids.entries()) {
        const state = existing[index] as RuntimeInputStateRecord;
        state.requestId = requestId;
        states.delete(stateKey(runtime, id));
        states.set(stateKey(runtime, id), state);
        emitState(runtime, id, state);
      }
      return null;
    }
    for (const id of ids) states.delete(stateKey(runtime, id));
  }

  for (const [key, state] of states) {
    if (states.size + ids.length <= MAX_RUNTIME_INPUT_STATES) break;
    if (state.status === "core_owned" || state.status === "dropped") {
      states.delete(key);
    }
  }
  if (states.size + ids.length > MAX_RUNTIME_INPUT_STATES) {
    reject(runtime, requestId, ids, "Listener input dedupe capacity reached");
    return null;
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

export function createTurnInputOwnership(
  runtime: ConversationRuntime,
  incoming: IncomingMessage,
  turnLease: TurnLease,
) {
  const clientMessageIds = new Set(incoming.clientMessageIds ?? []);
  return {
    track(ids: string[]): void {
      for (const id of ids) clientMessageIds.add(id);
    },
    recordRunId(runId: string, coreOwnsInput: boolean): void {
      runtime.turnLifecycle.setRunId(turnLease, runId);
      if (coreOwnsInput) markCoreOwned(runtime, [...clientMessageIds], runId);
    },
    dropUnowned(): void {
      markRuntimeInputsDropped(
        runtime,
        [...clientMessageIds],
        "Listener turn ended before Core ownership",
      );
    },
  };
}
