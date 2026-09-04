import type { EnvironmentConnection } from "@/backend/api/environments";
import type { ResultMessage } from "@/types/protocol";
import type { TerminalFailure } from "@/types/terminal-failure";
import { createEnvironmentTerminalFailure } from "./agent/terminal-failure";

export type ReplyEnvironmentMetadata =
  | { source: "same-environment" }
  | {
      source: "explicit" | "cloud-sandbox";
      input: string;
      id: string;
      connection_id: string;
      device_id: string;
      name: string;
    };

export function buildEnvironmentResponseMetadata(params: {
  source: Extract<
    ReplyEnvironmentMetadata,
    { source: "explicit" | "cloud-sandbox" }
  >["source"];
  input: string;
  connectionId: string;
  environment: EnvironmentConnection;
}): ReplyEnvironmentMetadata {
  return {
    source: params.source,
    input: params.input,
    id: params.environment.id,
    connection_id: params.connectionId,
    device_id: params.environment.deviceId,
    name: params.environment.connectionName,
  };
}

type EnvironmentFailureStage =
  | "sandbox_start"
  | "environment_connect"
  | "environment_dispatch"
  | "environment_turn";

export function buildEnvironmentFailureOutput(params: {
  error: unknown;
  stage: EnvironmentFailureStage;
  environment?: ReplyEnvironmentMetadata;
  agentId: string | null;
  conversationId: string;
  sessionId: string;
  durationMs: number;
  durationApiMs: number;
}): {
  failure: TerminalFailure;
  json: Record<string, unknown>;
  stream: ResultMessage & { environment?: ReplyEnvironmentMetadata };
} {
  const failure = createEnvironmentTerminalFailure(params.error, params.stage);
  const result = {
    subtype: "error" as const,
    duration_ms: Math.round(params.durationMs),
    duration_api_ms: Math.round(params.durationApiMs),
    num_turns: params.stage === "environment_turn" ? 1 : 0,
    result: failure.message,
    agent_id: params.agentId,
    conversation_id: params.conversationId,
    ...(params.environment ? { environment: params.environment } : {}),
    usage: null,
    stop_reason: "error" as const,
    failure,
  };
  return {
    failure,
    json: { type: "result", is_error: true, ...result },
    stream: {
      type: "result",
      session_id: params.sessionId,
      run_ids: [],
      uuid: `result-${params.agentId}-${Date.now()}`,
      ...result,
    },
  };
}
