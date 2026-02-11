import { getVersion } from "../../version";

export interface StatusLinePayloadBuildInput {
  modelId?: string | null;
  modelDisplayName?: string | null;
  currentDirectory: string;
  projectDirectory: string;
  sessionId?: string;
  agentName?: string | null;
  totalDurationMs?: number;
  totalApiDurationMs?: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  contextWindowSize?: number;
  usedContextTokens?: number;
  permissionMode?: string;
  networkPhase?: "upload" | "download" | "error" | null;
  terminalWidth?: number;
}

/**
 * Claude-compatible status line payload with Letta extensions under `letta`.
 *
 * Unsupported Claude fields are set to null (or omitted if optional object absent)
 * so users can understand compatibility while keeping JSON stable for scripts.
 */
export interface StatusLinePayload {
  cwd: string;
  workspace: {
    current_dir: string;
    project_dir: string;
  };
  session_id?: string;
  transcript_path: string | null;
  version: string;
  model: {
    id: string | null;
    display_name: string | null;
  };
  output_style: {
    name: string | null;
  };
  cost: {
    total_cost_usd: number | null;
    total_duration_ms: number;
    total_api_duration_ms: number;
    total_lines_added: number | null;
    total_lines_removed: number | null;
  };
  context_window: {
    total_input_tokens: number;
    total_output_tokens: number;
    context_window_size: number;
    used_percentage: number | null;
    remaining_percentage: number | null;
    current_usage: {
      input_tokens: number | null;
      output_tokens: number | null;
      cache_creation_input_tokens: number | null;
      cache_read_input_tokens: number | null;
    } | null;
  };
  exceeds_200k_tokens: boolean;
  vim: {
    mode: string | null;
  } | null;
  agent: {
    name: string | null;
  };
  letta: {
    permission_mode: string | null;
    network_phase: "upload" | "download" | "error" | null;
    terminal_width: number | null;
  };
}

export function calculateContextPercentages(
  usedTokens: number,
  contextWindowSize: number,
): { used: number; remaining: number } {
  if (contextWindowSize <= 0) {
    return { used: 0, remaining: 100 };
  }

  const used = Math.max(
    0,
    Math.min(100, Math.round((usedTokens / contextWindowSize) * 100)),
  );
  return { used, remaining: Math.max(0, 100 - used) };
}

export function buildStatusLinePayload(
  input: StatusLinePayloadBuildInput,
): StatusLinePayload {
  const totalDurationMs = Math.max(0, Math.floor(input.totalDurationMs ?? 0));
  const totalApiDurationMs = Math.max(
    0,
    Math.floor(input.totalApiDurationMs ?? 0),
  );
  const totalInputTokens = Math.max(0, Math.floor(input.totalInputTokens ?? 0));
  const totalOutputTokens = Math.max(
    0,
    Math.floor(input.totalOutputTokens ?? 0),
  );
  const contextWindowSize = Math.max(
    0,
    Math.floor(input.contextWindowSize ?? 0),
  );
  const usedContextTokens = Math.max(
    0,
    Math.floor(input.usedContextTokens ?? 0),
  );

  const percentages =
    contextWindowSize > 0
      ? calculateContextPercentages(usedContextTokens, contextWindowSize)
      : null;

  return {
    cwd: input.currentDirectory,
    workspace: {
      current_dir: input.currentDirectory,
      project_dir: input.projectDirectory,
    },
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    transcript_path: null,
    version: getVersion(),
    model: {
      id: input.modelId ?? null,
      display_name: input.modelDisplayName ?? null,
    },
    output_style: {
      name: null,
    },
    cost: {
      total_cost_usd: null,
      total_duration_ms: totalDurationMs,
      total_api_duration_ms: totalApiDurationMs,
      total_lines_added: null,
      total_lines_removed: null,
    },
    context_window: {
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      context_window_size: contextWindowSize,
      used_percentage: percentages?.used ?? null,
      remaining_percentage: percentages?.remaining ?? null,
      current_usage: null,
    },
    exceeds_200k_tokens: usedContextTokens > 200_000,
    vim: null,
    agent: {
      name: input.agentName ?? null,
    },
    letta: {
      permission_mode: input.permissionMode ?? null,
      network_phase: input.networkPhase ?? null,
      terminal_width: input.terminalWidth ?? null,
    },
  };
}
