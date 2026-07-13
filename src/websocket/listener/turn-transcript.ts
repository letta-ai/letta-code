import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";
import type { ApprovalCreate } from "@letta-ai/letta-client/resources/agents/messages";
import type { Buffers, Line } from "@/cli/helpers/accumulator";
import { telemetry } from "@/telemetry";
import { extractTelemetryInputText } from "@/telemetry/input";
import type { InboundMessagePayload } from "./types";

export function trackListenerUserInput(
  messages: InboundMessagePayload[],
  modelId: string,
): void {
  for (const message of messages) {
    if (!("role" in message) || message.role !== "user") {
      continue;
    }
    const inputText = extractTelemetryInputText(message.content);
    if (inputText.length > 0) {
      telemetry.trackUserInput(inputText, "user", modelId);
    }
  }
}

export function buildInboundUserTranscriptLines(
  messages: Array<MessageCreate | ApprovalCreate>,
): Line[] {
  const lines: Line[] = [];
  for (const message of messages) {
    if (
      !("role" in message) ||
      message.role !== "user" ||
      !("content" in message)
    ) {
      continue;
    }
    const text = extractTelemetryInputText(message.content);
    if (text.length === 0) {
      continue;
    }
    const otid =
      "otid" in message && typeof message.otid === "string"
        ? message.otid
        : undefined;
    lines.push({
      kind: "user",
      id: otid ? `user-${otid}` : `user-${crypto.randomUUID()}`,
      text,
      otid,
    });
  }
  return lines;
}

export function seedInboundUserTranscriptLines(
  buffers: Buffers,
  lines: Line[],
): void {
  for (const line of lines) {
    if (line.kind !== "user" || buffers.byId.has(line.id)) {
      continue;
    }
    buffers.byId.set(line.id, line);
    buffers.order.push(line.id);
    if (line.otid) {
      buffers.userLineIdByOtid.set(line.otid, line.id);
    }
  }
}

export const __listenerTurnTestUtils = {
  trackListenerUserInput,
  buildInboundUserTranscriptLines,
  seedInboundUserTranscriptLines,
};
