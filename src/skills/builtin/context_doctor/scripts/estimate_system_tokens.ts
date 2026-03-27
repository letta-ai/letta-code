#!/usr/bin/env npx tsx
/**
 * Estimate token usage of system prompt memory files.
 *
 * Self-contained — no imports from the letta-code source tree.
 *
 * Usage:
 *   npx tsx estimate_system_tokens.ts --memory-dir "$MEMORY_DIR"
 *   npx tsx estimate_system_tokens.ts --memory-dir ~/.letta/agents/<id>/memory
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Codex heuristic: ~4 bytes per token (codex-rs/core/src/truncate.rs APPROX_BYTES_PER_TOKEN = 4)
const BYTES_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

type FileEstimate = {
  path: string;
  tokens: number;
};

type ParsedArgs = {
  memoryDir?: string;
  top: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { top: 20 };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--memory-dir") {
      parsed.memoryDir = argv[i + 1];
      i++;
      continue;
    }
    if (arg === "--top") {
      const raw = argv[i + 1];
      const value = Number.parseInt(raw ?? "", 10);
      if (!Number.isNaN(value) && value >= 0) {
        parsed.top = value;
      }
      i++;
    }
  }

  return parsed;
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

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const memoryDir = args.memoryDir || process.env.MEMORY_DIR;

  if (!memoryDir) {
    console.error("Missing memory dir. Pass --memory-dir or set MEMORY_DIR.");
    return 1;
  }

  const systemDir = join(memoryDir, "system");
  if (!existsSync(systemDir)) {
    console.error(`Missing system directory: ${systemDir}`);
    return 1;
  }

  const files = walkMarkdownFiles(systemDir).sort();
  const rows: FileEstimate[] = [];

  for (const filePath of files) {
    const text = readFileSync(filePath, "utf8");
    const rel = normalizePath(filePath.slice(memoryDir.length + 1));
    rows.push({ path: rel, tokens: estimateTokens(text) });
  }

  const estimatedTotalTokens = rows.reduce((sum, row) => sum + row.tokens, 0);

  console.log("Estimated total tokens");
  console.log(`  ${formatNumber(estimatedTotalTokens)}`);

  console.log("\nPer-file token estimates");
  console.log(`  ${"tokens".padStart(8)}  path`);

  const sortedRows = [...rows].sort((a, b) => b.tokens - a.tokens);
  for (const row of sortedRows.slice(0, Math.max(0, args.top))) {
    console.log(`  ${formatNumber(row.tokens).padStart(8)}  ${row.path}`);
  }

  return 0;
}

process.exit(main());
