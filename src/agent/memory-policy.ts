import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT = 20_000;
export const MEMORY_POLICY_PATH = "system/.letta-policy.yml";
export const LEGACY_MEMORY_POLICY_PATH = "memory/system/.letta-policy.yml";
export const MEMORY_POLICY_CHANGE_APPROVAL_ENV =
  "LETTA_APPROVED_MEMORY_POLICY_CHANGE";
export const MEMORY_POLICY_CHANGE_APPROVAL_FILE =
  "letta-memory-policy-approval";

const SYSTEM_PROMPT_TOKEN_LIMIT_KEY = "system_prompt_token_limit";
const POLICY_LINE = /^system_prompt_token_limit:\s*([0-9]+)\s*$/;

export function parseMemoryPolicy(content: string): number {
  const meaningfulLines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"));

  if (meaningfulLines.length !== 1) {
    throw new Error(
      `Memory policy must contain exactly one ${SYSTEM_PROMPT_TOKEN_LIMIT_KEY} entry.`,
    );
  }

  const match = meaningfulLines[0]?.match(POLICY_LINE);
  const value = match?.[1];
  if (!value) {
    throw new Error(
      `Memory policy must use '${SYSTEM_PROMPT_TOKEN_LIMIT_KEY}: <positive integer>'.`,
    );
  }

  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("System prompt token limit must be a positive integer.");
  }
  return limit;
}

export function formatMemoryPolicy(systemPromptTokenLimit: number): string {
  if (
    !Number.isSafeInteger(systemPromptTokenLimit) ||
    systemPromptTokenLimit <= 0
  ) {
    throw new Error("System prompt token limit must be a positive integer.");
  }
  return `${SYSTEM_PROMPT_TOKEN_LIMIT_KEY}: ${systemPromptTokenLimit}\n`;
}

export function readMemoryPolicyTokenLimit(memoryDir: string): {
  limit: number;
  source: "default" | string;
} {
  for (const relativePath of [MEMORY_POLICY_PATH, LEGACY_MEMORY_POLICY_PATH]) {
    const policyPath = join(memoryDir, relativePath);
    if (existsSync(policyPath)) {
      return {
        limit: parseMemoryPolicy(readFileSync(policyPath, "utf8")),
        source: relativePath,
      };
    }
  }
  return { limit: DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT, source: "default" };
}
