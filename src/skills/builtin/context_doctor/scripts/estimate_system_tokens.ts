#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getClient } from "../../../../agent/client";
import { estimateTokens } from "../../../../cli/helpers/format";
import { settingsManager } from "../../../../settings-manager";

type FileEstimate = {
  path: string;
  tokens: number;
};

type ParsedArgs = {
  memoryDir?: string;
  agentId?: string;
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
    if (arg === "--agent-id") {
      parsed.agentId = argv[i + 1];
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
}

function inferAgentIdFromMemoryDir(memoryDir: string): string | null {
  const parts = normalizePath(memoryDir).split("/");
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === "agents" && parts[i + 1]?.startsWith("agent-")) {
      return parts[i + 1];
    }
  }

  const maybe = parts.at(-2);
  return maybe?.startsWith("agent-") ? maybe : null;
}

async function resolveAgentId(
  memoryDir: string,
  cliAgentId?: string,
): Promise<string> {
  if (cliAgentId) {
    return cliAgentId;
  }

  if (process.env.AGENT_ID) {
    return process.env.AGENT_ID;
  }

  const inferred = inferAgentIdFromMemoryDir(memoryDir);
  if (inferred) {
    return inferred;
  }

  const fromSession = settingsManager.getEffectiveLastAgentId(process.cwd());
  if (fromSession) {
    return fromSession;
  }

  throw new Error(
    "Unable to resolve agent ID. Pass --agent-id or set AGENT_ID.",
  );
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

async function main(): Promise<number> {
  await settingsManager.initialize();

  const args = parseArgs(process.argv.slice(2));
  const memoryDir = args.memoryDir || process.env.MEMORY_DIR;

  if (!memoryDir) {
    throw new Error("Missing memory dir. Pass --memory-dir or set MEMORY_DIR.");
  }

  const systemDir = join(memoryDir, "system");
  if (!existsSync(systemDir)) {
    throw new Error(`Missing system directory: ${systemDir}`);
  }

  const agentId = await resolveAgentId(memoryDir, args.agentId);

  // Use the SDK auth path used by letta-code (OAuth + API key handling via getClient).
  const client = await getClient();
  await client.agents.retrieve(agentId);

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

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
