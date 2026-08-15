/**
 * Shared system-prompt size estimator.
 *
 * Used by:
 *   - The `letta memory tokens` CLI command (for subagents + scripts)
 *   - The startup system-prompt warning
 *   - The bundled `context-doctor` skill script (via CLI)
 *
 * Heuristic: ~4 bytes per token
 * (codex-rs/core/src/truncate.rs APPROX_BYTES_PER_TOKEN = 4)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isLocalAgentMemoryEnabled } from "@/utils/local-agent-memory";

export const SYSTEM_PROMPT_BYTES_PER_TOKEN = 4;

export interface FileEstimate {
  path: string;
  tokens: number;
}

export interface SystemPromptSizeEstimate {
  total: number;
  files: FileEstimate[];
}

export function estimateSystemTokens(text: string): number {
  return Math.ceil(
    Buffer.byteLength(text, "utf8") / SYSTEM_PROMPT_BYTES_PER_TOKEN,
  );
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function walkMarkdownFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }

  const out: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden entries (.git, .DS_Store, etc.)
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkMarkdownFiles(full));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(full);
    }
  }

  return out;
}

/**
 * Estimate total token usage of files under `<memoryDir>/system/`, with a per-file breakdown.
 *
 * Returns { total: 0, files: [] } when `system/` does not exist (instead of throwing).
 */
export function estimateSystemPromptSize(
  memoryDir: string,
): SystemPromptSizeEstimate {
  if (isLocalAgentMemoryEnabled()) {
    if (!existsSync(memoryDir)) return { total: 0, files: [] };
    const rows = readdirSync(memoryDir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isFile() &&
          !entry.name.startsWith(".") &&
          entry.name.endsWith(".md"),
      )
      .map((entry) => {
        const text = readFileSync(join(memoryDir, entry.name), "utf8");
        return { path: entry.name, tokens: estimateSystemTokens(text) };
      })
      .sort((a, b) => a.path.localeCompare(b.path));
    return {
      total: rows.reduce((sum, row) => sum + row.tokens, 0),
      files: rows,
    };
  }
  const systemDir = join(memoryDir, "system");
  if (!existsSync(systemDir)) {
    return { total: 0, files: [] };
  }

  const files = walkMarkdownFiles(systemDir).sort();
  const rows: FileEstimate[] = [];

  for (const filePath of files) {
    const text = readFileSync(filePath, "utf8");
    const rel = normalizePath(filePath.slice(memoryDir.length + 1));
    rows.push({ path: rel, tokens: estimateSystemTokens(text) });
  }

  const total = rows.reduce((sum, row) => sum + row.tokens, 0);
  return { total, files: rows };
}

/**
 * Backward-compatible helper returning just the total.
 */
export function estimateSystemPromptTokensFromMemoryDir(
  memoryDir: string,
): number {
  return estimateSystemPromptSize(memoryDir).total;
}
