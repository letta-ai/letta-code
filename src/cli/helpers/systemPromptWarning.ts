/**
 * Startup system prompt warning
 * Uses same heuristic as context_doctor to estimate system prompt token count on startup
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentState } from "@letta-ai/letta-client/resources/agents/agents";
import { getMemoryFilesystemRoot } from "../../agent/memoryFilesystem";
import { settingsManager } from "../../settings-manager";
import { debugWarn } from "../../utils/debug";

const STARTUP_SYSTEM_PROMPT_WARNING_THRESHOLD_TOKENS = 30000;
const STARTUP_SYSTEM_PROMPT_ESTIMATED_BYTES_PER_TOKEN = 4;

export interface SystemPromptDoctorState {
  estimated_tokens: number;
  should_doctor: boolean;
  updated_at_ms: number;
}

const systemPromptDoctorStateByAgent = new Map<
  string,
  SystemPromptDoctorState
>();

export function estimateSystemTokens(text: string): number {
  return Math.ceil(
    Buffer.byteLength(text, "utf8") /
      STARTUP_SYSTEM_PROMPT_ESTIMATED_BYTES_PER_TOKEN,
  );
}

/**
 * MemFS-based estimate of system prompt tokens (aggregate of all system/ files)
 */
export function estimateSystemPromptTokensFromMemoryDir(
  memoryDir: string,
): number {
  const systemDir = join(memoryDir, "system");
  if (!existsSync(systemDir)) {
    return 0;
  }

  const walkMarkdownFiles = (dir: string): string[] => {
    if (!existsSync(dir)) {
      return [];
    }

    const out: string[] = [];
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git") {
          continue;
        }
        out.push(...walkMarkdownFiles(full));
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(full);
      }
    }

    return out;
  };

  return walkMarkdownFiles(systemDir)
    .sort()
    .reduce((sum, filePath) => {
      const text = readFileSync(filePath, "utf8");
      return sum + estimateSystemTokens(text);
    }, 0);
}

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

/**
 * I think the issue is here where the initially cached value keeps getting returned bc LCD doesn't
 * access the CLI's local map that's updated for the agent ID upon /recompile,
 * and LCD currently has no /recompile path to update its own cache
 * bc I think the caches are in separate CLI/LCD Node.js processes.
 */
export function getOrRefreshSystemPromptDoctorState(
  agentId: string,
): SystemPromptDoctorState | null {
  // check if we have a cached state for this agent
  const existing = systemPromptDoctorStateByAgent.get(agentId);
  if (existing) {
    return existing;
  }

  try {
    const memoryDir = getMemoryFilesystemRoot(agentId);
    const systemDir = join(memoryDir, "system");
    if (existsSync(systemDir)) {
      const tokens = estimateSystemPromptTokensFromMemoryDir(memoryDir);
      return setSystemPromptDoctorState(agentId, tokens);
    }
  } catch {
    // fall through (no agent state to access non-memfs system prompt)
  }

  return null;
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
