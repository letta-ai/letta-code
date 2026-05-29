import { hostname } from "node:os";
import type { Usage } from "@earendil-works/pi-ai";
import {
  type LocalAnalyticsAnthropicUsageEvent,
  localAnalyticsUrlFromEnv,
} from "./types";

const INSTANCE_ID = `${hostname()}:${process.pid}:${Date.now().toString(36)}`;
const EMIT_TIMEOUT_MS = 500;

export interface EmitAnthropicUsageInput {
  agentId: string;
  conversationId: string;
  model: string;
  responseModel?: string;
  requestId?: string;
  latencyMs: number;
  ttftMs?: number;
  streamed: boolean;
  usage: Usage | undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function buildEvent(
  input: EmitAnthropicUsageInput,
): LocalAnalyticsAnthropicUsageEvent {
  return {
    type: "anthropic_usage",
    timestamp: Date.now(),
    instanceId: INSTANCE_ID,
    processId: process.pid,
    hostname: hostname(),
    cwd: process.cwd(),
    agentId: input.agentId,
    conversationId: input.conversationId,
    model: input.model,
    provider: "anthropic",
    ...(input.responseModel ? { responseModel: input.responseModel } : {}),
    ...(input.requestId ? { requestId: input.requestId } : {}),
    latencyMs: input.latencyMs,
    ...(input.ttftMs !== undefined ? { ttftMs: input.ttftMs } : {}),
    streamed: input.streamed,
    usage: {
      ...(numberValue(input.usage?.input) !== undefined
        ? { inputTokens: numberValue(input.usage?.input) }
        : {}),
      ...(numberValue(input.usage?.output) !== undefined
        ? { outputTokens: numberValue(input.usage?.output) }
        : {}),
      ...(numberValue(input.usage?.cacheWrite) !== undefined
        ? { cacheCreationInputTokens: numberValue(input.usage?.cacheWrite) }
        : {}),
      ...(numberValue(input.usage?.cacheRead) !== undefined
        ? { cacheReadInputTokens: numberValue(input.usage?.cacheRead) }
        : {}),
      ...(numberValue(input.usage?.totalTokens) !== undefined
        ? { totalTokens: numberValue(input.usage?.totalTokens) }
        : {}),
    },
  };
}

export async function emitLocalAnalyticsAnthropicUsage(
  input: EmitAnthropicUsageInput,
): Promise<void> {
  const baseUrl = localAnalyticsUrlFromEnv();
  if (!baseUrl) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), EMIT_TIMEOUT_MS);
  try {
    await fetch(`${baseUrl}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildEvent(input)),
      signal: controller.signal,
    });
  } catch {
    // Analytics must never affect local provider turns.
  } finally {
    clearTimeout(timeout);
  }
}
