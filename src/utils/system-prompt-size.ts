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
import type { LocalMemoryFormat } from "@/agent/memory-format";

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
  memoryFormat: LocalMemoryFormat = "memfs-v1",
): SystemPromptSizeEstimate {
  const files =
    memoryFormat === "memfs-v2"
      ? existsSync(memoryDir)
        ? readdirSync(memoryDir, { withFileTypes: true })
            .filter(
              (entry) =>
                entry.isFile() &&
                !entry.name.startsWith(".") &&
                entry.name.endsWith(".md"),
            )
            .map((entry) => join(memoryDir, entry.name))
            .sort()
        : []
      : walkMarkdownFiles(join(memoryDir, "system")).sort();
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
  memoryFormat: LocalMemoryFormat = "memfs-v1",
): number {
  return estimateSystemPromptSize(memoryDir, memoryFormat).total;
}
