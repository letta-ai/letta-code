import type { StreamDelta } from "@/types/protocol_v2";

export interface ToolCallStartEvent {
  type: "tool_call_start";
  tool_call_id: string;
  tool_name: string | null;
}

export interface ToolCallArgumentsDeltaEvent {
  type: "tool_call_arguments_delta";
  tool_call_id: string;
  arguments_delta: string;
}

export interface ToolCallCompleteEvent {
  type: "tool_call_complete";
  tool_call_id: string;
  tool_name: string | null;
  arguments: string;
  output: string;
  success: boolean;
}

export type ToolCallEvent =
  | ToolCallStartEvent
  | ToolCallArgumentsDeltaEvent
  | ToolCallCompleteEvent;

export type ToolLifecycleCallback = (event: ToolCallEvent) => void;

interface ToolCallState {
  toolCallId: string;
  name: string | null;
  arguments: string;
  started: boolean;
  completed: boolean;
  clientManaged: boolean;
  terminalStatus: "success" | "error" | null;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value !== null && typeof value === "object"
    ? (value as UnknownRecord)
    : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function extractToolCallFragments(record: UnknownRecord | null): Array<{
  toolCallId: string;
  name: string | null;
  argumentsDelta: string | null;
}> {
  if (!record) {
    return [];
  }

  const rawToolCalls = Array.isArray(record.tool_calls)
    ? record.tool_calls
    : record.tool_call
      ? [record.tool_call]
      : [];

  const fragments: Array<{
    toolCallId: string;
    name: string | null;
    argumentsDelta: string | null;
  }> = [];

  for (const rawToolCall of rawToolCalls) {
    const toolCall = asRecord(rawToolCall);
    if (!toolCall) {
      continue;
    }
    const toolCallId = stringValue(toolCall.tool_call_id);
    if (!toolCallId) {
      continue;
    }
    const name = stringValue(toolCall.name) ?? null;
    const argumentsDelta = stringValue(toolCall.arguments) ?? null;
    fragments.push({ toolCallId, name, argumentsDelta });
  }

  return fragments;
}

function normalizeToolReturnOutput(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const textParts = value
      .filter(
        (part: unknown): part is { type: string; text: string } =>
          part !== null &&
          typeof part === "object" &&
          "type" in part &&
          (part as { type: unknown }).type === "text" &&
          "text" in part &&
          typeof (part as { text: unknown }).text === "string",
      )
      .map((part) => part.text);
    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }
  if (
    value !== null &&
    typeof value === "object" &&
    "type" in value &&
    (value as { type: unknown }).type === "text" &&
    "text" in value &&
    typeof (value as { text: unknown }).text === "string"
  ) {
    return (value as { text: string }).text;
  }
  if (value === null || value === undefined) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractToolReturns(record: UnknownRecord | null): Array<{
  toolCallId: string;
  status: "success" | "error";
  output: string;
}> {
  if (!record) {
    return [];
  }

  const results: Array<{
    toolCallId: string;
    status: "success" | "error";
    output: string;
  }> = [];

  const toolReturnsValue = record.tool_returns;
  if (Array.isArray(toolReturnsValue)) {
    for (const raw of toolReturnsValue) {
      const rec = asRecord(raw);
      if (!rec) {
        continue;
      }
      const toolCallId = stringValue(rec.tool_call_id);
      const status = asToolReturnStatus(rec.status);
      if (!toolCallId || !status) {
        continue;
      }
      results.push({
        toolCallId,
        status,
        output: normalizeToolReturnOutput(rec.tool_return),
      });
    }
    if (results.length > 0) {
      return results;
    }
  }

  const topLevelToolCallId = stringValue(record.tool_call_id);
  const topLevelStatus = asToolReturnStatus(record.status);
  if (!topLevelToolCallId || !topLevelStatus) {
    return [];
  }
  return [
    {
      toolCallId: topLevelToolCallId,
      status: topLevelStatus,
      output: normalizeToolReturnOutput(record.tool_return),
    },
  ];
}

function asToolReturnStatus(value: unknown): "success" | "error" | null {
  if (value === "success" || value === "error") {
    return value;
  }
  return null;
}

export interface ToolLifecycleTracker {
  process(delta: StreamDelta): void;

  failPending(output: string): void;

  dispose(): void;
}

export function createToolLifecycleTracker(
  onEvent: ToolLifecycleCallback,
): ToolLifecycleTracker {
  const calls = new Map<string, ToolCallState>();
  const completedIds = new Set<string>();
  let disposed = false;

  function getOrCreate(toolCallId: string): ToolCallState {
    const existing = calls.get(toolCallId);
    if (existing) {
      return existing;
    }
    const state: ToolCallState = {
      toolCallId,
      name: null,
      arguments: "",
      started: false,
      completed: false,
      clientManaged: false,
      terminalStatus: null,
    };
    calls.set(toolCallId, state);
    return state;
  }

  function handleToolCallFragment(
    toolCallId: string,
    name: string | null,
    argumentsDelta: string | null,
  ): void {
    if (completedIds.has(toolCallId)) {
      return;
    }
    const state = getOrCreate(toolCallId);

    if (!state.started) {
      state.started = true;
      if (name) {
        state.name = name;
      }
      onEvent({
        type: "tool_call_start",
        tool_call_id: toolCallId,
        tool_name: state.name,
      });
    } else if (name && !state.name) {
      state.name = name;
    }

    if (argumentsDelta !== null) {
      state.arguments += argumentsDelta;
      onEvent({
        type: "tool_call_arguments_delta",
        tool_call_id: toolCallId,
        arguments_delta: argumentsDelta,
      });
    }
  }

  function handleToolReturn(
    toolCallId: string,
    status: "success" | "error",
    output: string,
  ): void {
    if (completedIds.has(toolCallId)) {
      return;
    }
    completedIds.add(toolCallId);

    const state = getOrCreate(toolCallId);
    state.completed = true;

    onEvent({
      type: "tool_call_complete",
      tool_call_id: toolCallId,
      tool_name: state.name,
      arguments: state.arguments,
      output,
      success: status === "success",
    });
  }

  function process(delta: StreamDelta): void {
    if (disposed) {
      return;
    }

    const record = delta as unknown as UnknownRecord;
    const messageType = stringValue(record.message_type);
    const toolCallId = stringValue(record.tool_call_id);

    if (messageType === "client_tool_start" && toolCallId) {
      const state = getOrCreate(toolCallId);
      state.clientManaged = true;
      if (!state.name) state.name = stringValue(record.tool_name) ?? null;
      return;
    }
    if (messageType === "client_tool_end" && toolCallId) {
      const state = getOrCreate(toolCallId);
      state.clientManaged = true;
      state.terminalStatus = asToolReturnStatus(record.status);
      return;
    }

    if ((delta as { type?: unknown }).type !== "message") {
      return;
    }

    if (
      messageType === "tool_call_message" ||
      messageType === "approval_request_message"
    ) {
      for (const fragment of extractToolCallFragments(record)) {
        handleToolCallFragment(
          fragment.toolCallId,
          fragment.name,
          fragment.argumentsDelta,
        );
      }
      return;
    }

    if (messageType === "tool_return_message") {
      for (const result of extractToolReturns(record)) {
        const state = getOrCreate(result.toolCallId);
        if (!state.clientManaged) {
          handleToolReturn(result.toolCallId, result.status, result.output);
          continue;
        }
        if (state.terminalStatus) {
          handleToolReturn(
            result.toolCallId,
            state.terminalStatus,
            result.output,
          );
        }
      }
      return;
    }
  }

  function dispose(): void {
    disposed = true;
    calls.clear();
    completedIds.clear();
  }

  function failPending(output: string): void {
    if (disposed) return;
    for (const state of calls.values()) {
      if (!state.completed) {
        handleToolReturn(state.toolCallId, "error", output);
      }
    }
  }

  return { process, failPending, dispose };
}

export function collectToolLifecycleEvents(
  deltas: Iterable<StreamDelta>,
): ToolCallEvent[] {
  const events: ToolCallEvent[] = [];
  const tracker = createToolLifecycleTracker((event) => {
    events.push(event);
  });
  for (const delta of deltas) {
    tracker.process(delta);
  }
  tracker.dispose();
  return events;
}
