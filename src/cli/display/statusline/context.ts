import * as DisplayComponents from "@/cli/display/DisplayComponents";
import type {
  StatuslineRenderContext,
  StatuslineUiContext,
} from "@/cli/display/statusline/types";
import type { StatusLinePayload } from "@/cli/helpers/status-line-payload";

export interface BuildStatuslineRenderContextInput {
  backgroundAgents?: StatusLinePayload["background_agents"];
  payload: StatusLinePayload;
  statuses?: Record<string, string>;
  ui: StatuslineUiContext;
}

export function buildStatuslineRenderContext({
  backgroundAgents,
  payload,
  statuses = {},
  ui,
}: BuildStatuslineRenderContextInput): StatuslineRenderContext {
  return {
    rawPayload: payload,
    components: DisplayComponents,
    statuses,
    app: {
      version: payload.version,
    },
    workspace: {
      cwd: payload.cwd,
      currentDir: payload.workspace.current_dir,
      projectDir: payload.workspace.project_dir,
    },
    cwd: payload.cwd,
    sessionId: payload.session_id ?? null,
    lastRunId: payload.last_run_id,
    agent: payload.agent,
    model: {
      id: payload.model.id,
      displayName: payload.model.display_name,
      provider: ui.currentModelProvider,
      reasoningEffort: payload.reasoning_effort,
    },
    toolset: payload.toolset,
    systemPromptId: payload.system_prompt_id,
    permissionMode: payload.permission_mode,
    networkPhase: payload.network_phase,
    terminalWidth: payload.terminal_width,
    contextWindow: {
      size: payload.context_window.context_window_size,
      totalInputTokens: payload.context_window.total_input_tokens,
      totalOutputTokens: payload.context_window.total_output_tokens,
      usedPercentage: payload.context_window.used_percentage,
      remainingPercentage: payload.context_window.remaining_percentage,
      currentUsage: payload.context_window.current_usage
        ? {
            inputTokens: payload.context_window.current_usage.input_tokens,
            outputTokens: payload.context_window.current_usage.output_tokens,
            cacheCreationInputTokens:
              payload.context_window.current_usage.cache_creation_input_tokens,
            cacheReadInputTokens:
              payload.context_window.current_usage.cache_read_input_tokens,
          }
        : null,
    },
    cost: {
      totalDurationMs: payload.cost.total_duration_ms,
      totalApiDurationMs: payload.cost.total_api_duration_ms,
      totalCostUsd: payload.cost.total_cost_usd,
      totalLinesAdded: payload.cost.total_lines_added,
      totalLinesRemoved: payload.cost.total_lines_removed,
    },
    reflection: {
      mode: payload.reflection.mode,
      stepCount: payload.reflection.step_count,
    },
    memfs: {
      enabled: payload.memfs.enabled,
      memoryDir: payload.memfs.memory_dir,
    },
    backgroundAgents: (backgroundAgents ?? payload.background_agents).map(
      (agent) => ({
        type: agent.type,
        status: agent.status,
        durationMs: agent.duration_ms,
      }),
    ),
    ui,
  };
}
