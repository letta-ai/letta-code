/**
 * Startup system prompt warning
 * Uses same heuristic as context_doctor to estimate system prompt token count on startup
 */
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { settingsManager } from "../../settings-manager";
import { debugWarn } from "../../utils/debug";
import {
  estimateSystemPromptTokensFromMemoryDir,
  estimateSystemTokens,
} from "../../utils/systemPromptSize";

export { estimateSystemPromptTokensFromMemoryDir, estimateSystemTokens };

const STARTUP_SYSTEM_PROMPT_WARNING_THRESHOLD_TOKENS = 30000;

export interface SystemPromptDoctorState {
  estimated_tokens: number;
  should_doctor: boolean;
  updated_at_ms: number;
}

const systemPromptDoctorStateByAgent = new Map<
  string,
  SystemPromptDoctorState
>();

export function setSystemPromptDoctorState(
  agentId: string,
  estimatedTokens: number,
): SystemPromptDoctorState {
  const nextState: SystemPromptDoctorState = {
    estimated_tokens: estimatedTokens,
    should_doctor:
      estimatedTokens >= STARTUP_SYSTEM_PROMPT_WARNING_THRESHOLD_TOKENS,
    updated_at_ms: Date.now(),
  };
  systemPromptDoctorStateByAgent.set(agentId, nextState);
  return nextState;
}

export function getSystemPromptDoctorState(
  agentId: string,
): SystemPromptDoctorState | null {
  return systemPromptDoctorStateByAgent.get(agentId) ?? null;
}

export function refreshSystemPromptDoctorState(
  agentId: string,
  agentState: AgentState | null | undefined,
): SystemPromptDoctorState | null {
  try {
    let estimatedSystemPromptTokens = 0;

    if (settingsManager.isMemfsEnabled(agentId)) {
      const memoryDir = getMemoryFilesystemRoot(agentId);
      estimatedSystemPromptTokens =
        estimateSystemPromptTokensFromMemoryDir(memoryDir);
    } else {
      // non-memfs
      const systemPrompt = (
        agentState as { system?: string | null } | null | undefined
      )?.system;
      if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
        estimatedSystemPromptTokens = estimateSystemTokens(systemPrompt);
      }
    }

    return setSystemPromptDoctorState(agentId, estimatedSystemPromptTokens);
  } catch (error) {
    debugWarn(
      "startup",
      `Failed to estimate system prompt tokens for startup warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}

/** On LC CLI startup, display a warning if the system prompt is large. */
export function buildStartupSystemPromptWarning(
  agentState: AgentState | null | undefined,
): string | null {
  const startupAgentId = agentState?.id;
  if (!startupAgentId) {
    return null;
  }

  const state = refreshSystemPromptDoctorState(startupAgentId, agentState);
  if (state?.should_doctor) {
    return "⚠ **Warning:** System prompt is large. Consider running **/doctor** to clean up memory.\n";
  }

  return null;
}
