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

function estimateSystemTokens(text: string): number {
  return Math.ceil(
    Buffer.byteLength(text, "utf8") /
      STARTUP_SYSTEM_PROMPT_ESTIMATED_BYTES_PER_TOKEN,
  );
}

function estimateSystemPromptTokensFromMemoryDir(memoryDir: string): number {
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

export function buildStartupSystemPromptWarning(
  agentState: AgentState | null | undefined,
): string | null {
  const startupAgentId = agentState?.id;
  if (!startupAgentId) {
    return null;
  }

  try {
    let estimatedSystemPromptTokens = 0;

    if (settingsManager.isMemfsEnabled(startupAgentId)) {
      const memoryDir = getMemoryFilesystemRoot(startupAgentId);
      estimatedSystemPromptTokens =
        estimateSystemPromptTokensFromMemoryDir(memoryDir);
    } else {
      const systemPrompt = (
        agentState as { system?: string | null } | null | undefined
      )?.system;
      if (typeof systemPrompt === "string" && systemPrompt.length > 0) {
        estimatedSystemPromptTokens = estimateSystemTokens(systemPrompt);
      }
    }

    if (
      estimatedSystemPromptTokens >=
      STARTUP_SYSTEM_PROMPT_WARNING_THRESHOLD_TOKENS
    ) {
      return "⚠ **Warning:** System prompt is large. Consider running **/doctor** to clean up memory.\n";
    }
  } catch (error) {
    debugWarn(
      "startup",
      `Failed to estimate system prompt tokens for startup warning: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return null;
}
