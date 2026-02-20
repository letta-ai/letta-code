/**
 * Memory health check helpers for the /health command.
 *
 * Estimates token usage of MemFS system/ files using the 4-bytes-per-token
 * approximation (same heuristic used by Codex: codex-rs/core/src/truncate.rs).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMemorySystemDir } from "../../agent/memoryFilesystem";
import { hexToFgAnsi } from "../components/colors";
import { formatCompact } from "./format";

// 4 bytes per token (Codex heuristic: APPROX_BYTES_PER_TOKEN = 4)
const BYTES_PER_TOKEN = 4;

/** Warn when system memory exceeds this fraction of the context window. */
export const SYSTEM_MEMORY_WARNING_THRESHOLD = 0.25;

/** Estimate token count from a UTF-8 string using byte length. */
export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export interface HealthFileInfo {
  /** Absolute path to the file */
  path: string;
  /** Label relative to memory root, e.g. "system/human" */
  label: string;
  bytes: number;
  tokens: number;
}

export interface HealthReport {
  files: HealthFileInfo[];
  totalTokens: number;
  contextWindow: number;
  /** Fraction of context window used (0–1), or null if contextWindow unknown */
  fraction: number | null;
  isOverThreshold: boolean;
  memfsEnabled: boolean;
}

/**
 * Scan the agent's system/ directory and build a health report.
 * Token counts are estimated via byte length / 4.
 */
export function checkMemfsHealth(
  agentId: string,
  contextWindow: number,
): HealthReport {
  const systemDir = getMemorySystemDir(agentId);
  const files: HealthFileInfo[] = [];

  if (existsSync(systemDir)) {
    const entries = readdirSync(systemDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const filePath = join(systemDir, entry.name);
      try {
        const content = readFileSync(filePath, "utf8");
        const bytes = statSync(filePath).size;
        const tokens = estimateTokens(content);
        const label = `system/${entry.name.replace(/\.md$/, "")}`;
        files.push({ path: filePath, label, bytes, tokens });
      } catch {
        // Skip unreadable files silently
      }
    }
  }

  // Sort largest first
  files.sort((a, b) => b.tokens - a.tokens);

  const totalTokens = files.reduce((sum, f) => sum + f.tokens, 0);
  const fraction = contextWindow > 0 ? totalTokens / contextWindow : null;
  const isOverThreshold =
    fraction !== null && fraction > SYSTEM_MEMORY_WARNING_THRESHOLD;

  return {
    files,
    totalTokens,
    contextWindow,
    fraction,
    isOverThreshold,
    memfsEnabled: true,
  };
}

/** Build the system-reminder warning text (injected into the agent turn). */
export function buildHealthWarning(report: HealthReport): string {
  const pctStr =
    report.fraction !== null
      ? `${(report.fraction * 100).toFixed(1)}% of your ${formatCompact(report.contextWindow)} token context window`
      : "an unknown fraction of your context window";

  const breakdown = report.files
    .map((f) => `  ${f.label.padEnd(30)} ~${formatCompact(f.tokens)} tokens`)
    .join("\n");

  return [
    `⚠️ Memory health warning: your system/ memory is using ~${formatCompact(report.totalTokens)} tokens (${pctStr}).`,
    `The recommended limit is ${Math.round(SYSTEM_MEMORY_WARNING_THRESHOLD * 100)}% of the context window.`,
    "",
    "Current breakdown:",
    breakdown,
    "",
    "Please trim or consolidate your system/ memory files to stay within budget.",
    "You can edit files directly in $MEMORY_DIR/system/ and commit the changes.",
  ].join("\n");
}

/** Render a human-readable health report for terminal output. */
export function renderHealthReport(report: HealthReport): string {
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const dim = "\x1b[2m";

  const GREEN = hexToFgAnsi("#32B2AA");
  const YELLOW = hexToFgAnsi("#E0A040");
  const RED = hexToFgAnsi("#E07050");

  let out = `${bold}Memory Health${reset}\n\n`;

  if (report.files.length === 0) {
    out += `${dim}  No system/ memory files found.${reset}\n`;
    return out;
  }

  // Per-file table
  const maxLabelLen = Math.max(...report.files.map((f) => f.label.length));
  for (const file of report.files) {
    const pctStr =
      report.contextWindow > 0
        ? ` (${((file.tokens / report.contextWindow) * 100).toFixed(1)}%)`
        : "";
    out += `  ${file.label.padEnd(maxLabelLen)}  ${formatCompact(file.tokens).padStart(6)} tokens${pctStr}\n`;
  }

  out += "\n";

  // Total line
  const fractionPct =
    report.fraction !== null ? ` (${(report.fraction * 100).toFixed(1)}%)` : "";
  const totalColor =
    report.fraction === null
      ? dim
      : report.isOverThreshold
        ? RED
        : report.fraction > SYSTEM_MEMORY_WARNING_THRESHOLD * 0.8
          ? YELLOW
          : GREEN;

  const contextStr =
    report.contextWindow > 0 ? ` / ${formatCompact(report.contextWindow)}` : "";

  out += `  ${bold}Total${reset}  ${totalColor}${formatCompact(report.totalTokens)}${contextStr} tokens${fractionPct}${reset}`;

  if (report.isOverThreshold) {
    out += `  ${RED}⚠️  exceeds ${Math.round(SYSTEM_MEMORY_WARNING_THRESHOLD * 100)}% threshold${reset}`;
  }

  out += "\n";

  if (report.isOverThreshold) {
    out += `\n  ${YELLOW}⚠️  System memory is large — injecting a warning for your agent to trim.${reset}\n`;
  }

  return out;
}
