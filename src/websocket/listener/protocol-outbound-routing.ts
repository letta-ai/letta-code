import type { OutboundFrameClass } from "./outbound-wire";

type RoutableMessage = {
  type: string;
  removed?: readonly unknown[];
};

/** High-frequency runtime emissions routed separately from control traffic. */
const STREAM_CHANNEL_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "stream_delta",
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
]);

export function isStreamChannelMessage(type: string): boolean {
  return STREAM_CHANNEL_MESSAGE_TYPES.has(type);
}

/** Snapshot frames where a newer value supersedes an unsent value. */
const COALESCABLE_STATUS_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "update_device_status",
  "update_loop_status",
  "update_queue",
  "update_subagent_state",
]);

export function classifyOutboundFrame(
  message: RoutableMessage,
): OutboundFrameClass {
  if (message.type === "update_queue" && (message.removed?.length ?? 0) > 0) {
    return "critical";
  }
  return COALESCABLE_STATUS_MESSAGE_TYPES.has(message.type)
    ? "status"
    : "critical";
}
