import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT = 20_000;
export const MEMORY_TOKEN_LIMIT_POLICY_PATH = "system/.letta-policy.yml";
export const MEMORY_TOKEN_LIMIT_UPDATE_ENV = "LETTA_MEMORY_TOKEN_LIMIT_UPDATE";

const POLICY_KEY = "system_prompt_token_limit";
const POLICY_LINE = /^[ \t]*system_prompt_token_limit:[ \t]*([0-9]+)[ \t]*$/;

function parseTokenLimit(content: string): number {
  const value = content.trim().match(POLICY_LINE)?.[1];
  const limit = value ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(
      `Memory policy must contain '${POLICY_KEY}: <positive integer>'.`,
    );
  }
  return limit;
}

export function formatMemoryTokenLimit(limit: number): string {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error("System prompt token limit must be a positive integer.");
  }
  return `${POLICY_KEY}: ${limit}\n`;
}

export function readMemoryTokenLimit(memoryDir: string): {
  limit: number;
  source: "default" | typeof MEMORY_TOKEN_LIMIT_POLICY_PATH;
} {
  const policyPath = join(memoryDir, MEMORY_TOKEN_LIMIT_POLICY_PATH);
  if (!existsSync(policyPath)) {
    return { limit: DEFAULT_SYSTEM_PROMPT_TOKEN_LIMIT, source: "default" };
  }
  return {
    limit: parseTokenLimit(readFileSync(policyPath, "utf8")),
    source: MEMORY_TOKEN_LIMIT_POLICY_PATH,
  };
}
