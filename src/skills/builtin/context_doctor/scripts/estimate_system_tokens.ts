#!/usr/bin/env bun

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient } from "../../../../agent/client";
import { settingsManager } from "../../../../settings-manager";

const BYTES_PER_TOKEN = 4;

type FileEstimate = {
  path: string;
  tokens: number;
};

type SkillEstimate = {
  name: string;
  description: string;
  location: string;
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

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function parseFrontmatterDescription(text: string): string | null {
  if (!text.startsWith("---\n")) {
    return null;
  }

  const closing = text.indexOf("\n---\n", 4);
  if (closing === -1) {
    return null;
  }

  const frontmatter = text.slice(4, closing);
  for (const line of frontmatter.split("\n")) {
    if (!line.startsWith("description:")) {
      continue;
    }
    const value = line.slice("description:".length).trim();
    return value.replace(/^['"]|['"]$/g, "") || null;
  }

  return null;
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

function buildMemoryFilesystemSection(memoryDir: string): string {
  const lines: string[] = ["<memory_filesystem>"];
  const files = walkMarkdownFiles(memoryDir).sort();

  for (const filePath of files) {
    const rel = normalizePath(filePath.slice(memoryDir.length + 1));
    let description: string | null = null;
    try {
      const text = readFileSync(filePath, "utf8");
      description = parseFrontmatterDescription(text);
    } catch {
      description = null;
    }

    if (description) {
      lines.push(`- ${rel} (${description})`);
    } else {
      lines.push(`- ${rel}`);
    }
  }

  lines.push("</memory_filesystem>");
  return lines.join("\n");
}

function parseSkillFromSkillMd(skillMdPath: string): SkillEstimate {
  const text = readFileSync(skillMdPath, "utf8");
  const parentName =
    normalizePath(skillMdPath).split("/").slice(-2)[0] ?? "unknown";

  let name = parentName;
  let description = "";

  if (text.startsWith("---\n")) {
    const closing = text.indexOf("\n---\n", 4);
    if (closing !== -1) {
      const frontmatter = text.slice(4, closing);
      for (const line of frontmatter.split("\n")) {
        if (line.startsWith("name:")) {
          const parsed = line
            .slice("name:".length)
            .trim()
            .replace(/^['"]|['"]$/g, "");
          if (parsed) {
            name = parsed;
          }
        } else if (line.startsWith("description:")) {
          const parsed = line
            .slice("description:".length)
            .trim()
            .replace(/^['"]|['"]$/g, "");
          if (parsed) {
            description = parsed;
          }
        }
      }
    }
  }

  if (!description) {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#") && trimmed !== "---") {
        description = trimmed.slice(0, 240);
        break;
      }
    }
  }

  return { name, description, location: skillMdPath };
}

function buildAvailableSkillsSection(memoryDir: string): string {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolve(scriptDir, "../../../../..");

  const sources = [
    join(memoryDir, "skills"),
    join(homedir(), ".letta/skills"),
    join(repoRoot, "src/skills/builtin"),
    join(repoRoot, ".skills"),
  ];

  const seen = new Set<string>();
  const skills: SkillEstimate[] = [];

  for (const source of sources) {
    if (!existsSync(source)) {
      continue;
    }

    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(source, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const skillMd = join(source, entry.name, "SKILL.md");
      if (!existsSync(skillMd)) {
        continue;
      }

      const key = normalizePath(skillMd);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      try {
        skills.push(parseSkillFromSkillMd(skillMd));
      } catch {}
    }
  }

  const lines: string[] = ["<available_skills>"];
  for (const skill of skills) {
    lines.push("<skill>");
    lines.push(`<name>${skill.name}</name>`);
    lines.push(`<description>${skill.description}</description>`);
    lines.push(`<location>${skill.location}</location>`);
    lines.push("</skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildMemoryMetadataSection(agentId: string): string {
  return [
    "<memory_metadata>",
    `- AGENT_ID: ${agentId}`,
    "- CONVERSATION_ID: default",
    "- System prompt last recompiled: unknown",
    "</memory_metadata>",
  ].join("\n");
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

  const systemTokens = rows.reduce((sum, row) => sum + row.tokens, 0);

  const generatedSections = [
    buildMemoryFilesystemSection(memoryDir),
    buildAvailableSkillsSection(memoryDir),
    buildMemoryMetadataSection(agentId),
  ];
  const generatedTokens = generatedSections.reduce(
    (sum, section) => sum + estimateTokens(section),
    0,
  );

  const estimatedTotalTokens = systemTokens + generatedTokens;

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
