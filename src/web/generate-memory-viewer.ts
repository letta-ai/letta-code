/**
 * Memory Viewer Generator
 *
 * Collects data from the git-backed memory filesystem, injects it into the
 * self-contained HTML template, writes the result to ~/.letta/viewers/, and
 * opens it in the user's browser.
 */

import { execFile as execFileCb } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { getClient, getServerUrl } from "../agent/client";
import { getMemoryFilesystemRoot } from "../agent/memoryFilesystem";
import { getMemoryRepoDir, isGitRepo } from "../agent/memoryGit";
import {
  getFileNodes,
  readFileContent,
  scanMemoryFilesystem,
} from "../agent/memoryScanner";
import memoryViewerTemplate from "./memory-viewer-template.txt";
import type {
  ContextData,
  MemoryCommit,
  MemoryFile,
  MemoryViewerData,
} from "./types";

const execFile = promisify(execFileCb);

const VIEWERS_DIR = join(homedir(), ".letta", "viewers");
const MAX_COMMITS = 500;
const RECENT_DIFF_COUNT = 50;
const PER_DIFF_CAP = 100_000; // 100KB per diff
const TOTAL_PAYLOAD_CAP = 5_000_000; // 5MB total
const RECORD_SEP = "\x1e";

export interface GenerateResult {
  filePath: string;
  opened: boolean;
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function runGitSafe(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 60_000,
    });
    return stdout?.toString() ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Data collectors
// ---------------------------------------------------------------------------

/** Parse frontmatter from a .md file's raw content. */
function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw };
  }
  const closingIdx = raw.indexOf("\n---", 3);
  if (closingIdx === -1) {
    return { frontmatter: {}, body: raw };
  }
  const fmBlock = raw.slice(4, closingIdx);
  const fm: Record<string, string> = {};
  for (const line of fmBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim();
      if (key) fm[key] = value;
    }
  }
  const body = raw.slice(closingIdx + 4).replace(/^\n/, "");
  return { frontmatter: fm, body };
}

/** Collect memory files from the working tree on disk. */
function collectFiles(memoryRoot: string): MemoryFile[] {
  const treeNodes = scanMemoryFilesystem(memoryRoot);
  const fileNodes = getFileNodes(treeNodes);

  return fileNodes
    .filter((n) => n.name.endsWith(".md"))
    .map((n) => {
      const raw = readFileContent(n.fullPath);
      const { frontmatter, body } = parseFrontmatter(raw);
      return {
        path: n.relativePath,
        isSystem:
          n.relativePath.startsWith("system/") ||
          n.relativePath.startsWith("system\\"),
        isSkill:
          n.relativePath.startsWith("skills/") ||
          n.relativePath.startsWith("skills\\"),
        frontmatter,
        content: body,
      };
    });
}

/** Collect commit metadata via a single git log call. */
async function collectMetadata(repoDir: string): Promise<
  Array<{
    hash: string;
    author: string;
    date: string;
    subject: string;
    body: string;
  }>
> {
  // Use RECORD_SEP between commits and NUL between fixed fields.
  // Body (%b) can be empty, so we use exactly 4 NUL delimiters per record
  // and treat everything after the 4th NUL (up to the next RECORD_SEP) as body.
  const raw = await runGitSafe(repoDir, [
    "log",
    "-n",
    String(MAX_COMMITS),
    "--first-parent",
    `--format=${RECORD_SEP}%H%x00%an%x00%aI%x00%s%x00%b`,
  ]);
  if (!raw.trim()) return [];

  const records = raw.split(RECORD_SEP).filter((s) => s.trim().length > 0);
  const commits: Array<{
    hash: string;
    author: string;
    date: string;
    subject: string;
    body: string;
  }> = [];

  for (const record of records) {
    const parts = record.replace(/^\n+/, "");
    // Split on first 4 NUL bytes only
    const nulPositions: number[] = [];
    for (let j = 0; j < parts.length && nulPositions.length < 4; j++) {
      if (parts[j] === "\0") nulPositions.push(j);
    }
    if (nulPositions.length < 4) continue;
    const [p0, p1, p2, p3] = nulPositions as [number, number, number, number];

    const hash = parts.slice(0, p0).trim();
    const author = parts.slice(p0 + 1, p1).trim();
    const date = parts.slice(p1 + 1, p2).trim();
    const subject = parts.slice(p2 + 1, p3).trim();
    const body = parts.slice(p3 + 1).trim();

    if (!hash || !/^[0-9a-f]{40}$/i.test(hash)) continue;

    commits.push({ hash, author, date, subject, body });
  }
  return commits;
}

/** Collect diffstats via a single git log call. Returns a hash -> stat map. */
async function collectStats(repoDir: string): Promise<Map<string, string>> {
  const raw = await runGitSafe(repoDir, [
    "log",
    "-n",
    String(MAX_COMMITS),
    "--first-parent",
    `--format=${RECORD_SEP}%H`,
    "--stat",
  ]);
  if (!raw.trim()) return new Map();

  const map = new Map<string, string>();
  const chunks = raw.split(RECORD_SEP).filter((s) => s.trim().length > 0);
  for (const chunk of chunks) {
    const normalized = chunk.replace(/^\n+/, "");
    const firstNewline = normalized.indexOf("\n");
    if (firstNewline === -1) continue;
    const hash = normalized.slice(0, firstNewline).trim();
    if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
    map.set(hash, normalized.slice(firstNewline + 1).trim());
  }
  return map;
}

/** Collect full diffs for the most recent N commits. Returns hash -> patch map. */
async function collectDiffs(repoDir: string): Promise<Map<string, string>> {
  const raw = await runGitSafe(repoDir, [
    "log",
    "-n",
    String(RECENT_DIFF_COUNT),
    "--first-parent",
    `--format=${RECORD_SEP}%H`,
    "-p",
  ]);
  if (!raw.trim()) return new Map();

  const map = new Map<string, string>();
  const chunks = raw.split(RECORD_SEP).filter((s) => s.trim().length > 0);
  for (const chunk of chunks) {
    const normalized = chunk.replace(/^\n+/, "");
    const firstNewline = normalized.indexOf("\n");
    if (firstNewline === -1) continue;
    const hash = normalized.slice(0, firstNewline).trim();
    if (!/^[0-9a-f]{40}$/i.test(hash)) continue;
    map.set(hash, normalized.slice(firstNewline + 1));
  }
  return map;
}

/** Get total commit count (may exceed MAX_COMMITS). */
async function getTotalCommitCount(repoDir: string): Promise<number> {
  const raw = await runGitSafe(repoDir, ["rev-list", "--count", "HEAD"]);
  const n = parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

const REFLECTION_PATTERN = /\(reflection\)|🔮|reflection:/i;

/** Assemble all data into a MemoryViewerData object. */
async function collectMemoryData(
  agentId: string,
  repoDir: string,
  memoryRoot: string,
): Promise<MemoryViewerData> {
  // Filesystem scan (synchronous)
  const files = collectFiles(memoryRoot);

  // Git calls (parallel)
  const [metadata, statsMap, diffsMap, totalCount] = await Promise.all([
    collectMetadata(repoDir),
    collectStats(repoDir),
    collectDiffs(repoDir),
    getTotalCommitCount(repoDir),
  ]);

  // Merge into commits with payload size caps
  let cumulativeSize = 0;
  const commits: MemoryCommit[] = metadata.map((m) => {
    const message = m.body ? `${m.subject}\n\n${m.body}` : m.subject;
    const stats = statsMap.get(m.hash) ?? "";
    let diff = diffsMap.get(m.hash);
    let truncated = false;

    if (diff !== undefined) {
      if (diff.length > PER_DIFF_CAP) {
        diff = `${diff.slice(0, PER_DIFF_CAP)}\n\n[diff truncated - exceeded ${Math.round(PER_DIFF_CAP / 1024)}KB]`;
        truncated = true;
      }
      cumulativeSize += diff.length;
      if (cumulativeSize > TOTAL_PAYLOAD_CAP) {
        diff = undefined;
        truncated = true;
      }
    }

    return {
      hash: m.hash,
      shortHash: m.hash.slice(0, 7),
      author: m.author,
      date: m.date,
      message,
      stats,
      diff,
      truncated,
      isReflection: REFLECTION_PATTERN.test(m.subject),
    };
  });

  let serverUrl: string;
  try {
    serverUrl = getServerUrl();
  } catch {
    serverUrl = process.env.LETTA_BASE_URL || "https://api.letta.com";
  }

  // Fetch agent info and context breakdown (best-effort, parallel)
  let agentName = agentId;
  let context: ContextData | undefined;
  let model = "unknown";

  // Try SDK client for agent name + model info
  try {
    const client = await getClient();
    const agent = await client.agents.retrieve(agentId);
    if (agent.name) agentName = agent.name;
    model = agent.llm_config?.model ?? "unknown";

    // Fetch context breakdown via raw API (not in SDK)
    const apiKey =
      (client as unknown as { apiKey?: string }).apiKey ||
      process.env.LETTA_API_KEY ||
      "";
    const contextWindow = agent.llm_config?.context_window ?? 0;
    try {
      const contextRes = await fetch(
        `${serverUrl}/v1/agents/${agentId}/context`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(5000),
        },
      );
      if (contextRes.ok) {
        const overview = (await contextRes.json()) as {
          context_window_size_max: number;
          context_window_size_current: number;
          num_tokens_system: number;
          num_tokens_core_memory: number;
          num_tokens_external_memory_summary: number;
          num_tokens_summary_memory: number;
          num_tokens_functions_definitions: number;
          num_tokens_messages: number;
        };
        context = {
          contextWindow: contextWindow || overview.context_window_size_max,
          usedTokens: overview.context_window_size_current,
          model,
          breakdown: {
            system: overview.num_tokens_system,
            coreMemory: overview.num_tokens_core_memory,
            externalMemory: overview.num_tokens_external_memory_summary,
            summaryMemory: overview.num_tokens_summary_memory,
            tools: overview.num_tokens_functions_definitions,
            messages: overview.num_tokens_messages,
          },
        };
      }
    } catch {
      // Context fetch failed - continue without it
    }
  } catch {
    // SDK client failed - try raw API with env key as fallback
    try {
      const apiKey = process.env.LETTA_API_KEY || "";
      if (apiKey && serverUrl) {
        // Fetch agent info + context in parallel
        const [agentRes, contextRes] = await Promise.all([
          fetch(`${serverUrl}/v1/agents/${agentId}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          }).catch(() => null),
          fetch(`${serverUrl}/v1/agents/${agentId}/context`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: AbortSignal.timeout(5000),
          }).catch(() => null),
        ]);

        if (agentRes?.ok) {
          const agentData = (await agentRes.json()) as {
            name?: string;
            llm_config?: { model?: string; context_window?: number };
          };
          if (agentData.name) agentName = agentData.name;
          if (agentData.llm_config?.model) model = agentData.llm_config.model;
        }

        if (contextRes?.ok) {
          const overview = (await contextRes.json()) as {
            context_window_size_max: number;
            context_window_size_current: number;
            num_tokens_system: number;
            num_tokens_core_memory: number;
            num_tokens_external_memory_summary: number;
            num_tokens_summary_memory: number;
            num_tokens_functions_definitions: number;
            num_tokens_messages: number;
          };
          context = {
            contextWindow: overview.context_window_size_max,
            usedTokens: overview.context_window_size_current,
            model,
            breakdown: {
              system: overview.num_tokens_system,
              coreMemory: overview.num_tokens_core_memory,
              externalMemory: overview.num_tokens_external_memory_summary,
              summaryMemory: overview.num_tokens_summary_memory,
              tools: overview.num_tokens_functions_definitions,
              messages: overview.num_tokens_messages,
            },
          };
        }
      }
    } catch {
      // All API calls failed - continue without context
    }
  }

  return {
    agent: { id: agentId, name: agentName, serverUrl },
    generatedAt: new Date().toISOString(),
    totalCommitCount: totalCount || commits.length,
    files,
    commits,
    context,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function generateAndOpenMemoryViewer(
  agentId: string,
  options?: { agentName?: string },
): Promise<GenerateResult> {
  const repoDir = getMemoryRepoDir(agentId);
  const memoryRoot = getMemoryFilesystemRoot(agentId);

  if (!isGitRepo(agentId)) {
    throw new Error("Memory viewer requires memfs. Run /memfs enable first.");
  }

  // 1. Collect data
  const data = await collectMemoryData(agentId, repoDir, memoryRoot);

  // Override agent name if provided by caller
  if (options?.agentName) {
    data.agent.name = options.agentName;
  }

  // 2. Safely embed JSON - escape < to \u003c to prevent </script> injection
  const jsonPayload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = memoryViewerTemplate.replace(
    "<!--LETTA_DATA_PLACEHOLDER-->",
    () => jsonPayload,
  );

  // 3. Write to ~/.letta/viewers/ with owner-only permissions
  if (!existsSync(VIEWERS_DIR)) {
    mkdirSync(VIEWERS_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(VIEWERS_DIR, 0o700);
  } catch {}

  const filePath = join(
    VIEWERS_DIR,
    `memory-${encodeURIComponent(agentId)}.html`,
  );
  writeFileSync(filePath, html);
  chmodSync(filePath, 0o600);

  // 4. Open in browser (skip inside tmux or SSH — `open` either launches a
  //    broken browser instance or fails entirely on remote machines)
  const skipOpen =
    Boolean(process.env.TMUX) ||
    Boolean(process.env.SSH_CONNECTION) ||
    Boolean(process.env.SSH_TTY);
  if (!skipOpen) {
    try {
      const { default: openUrl } = await import("open");
      await openUrl(filePath, { wait: false });
    } catch {
      throw new Error(`Could not open browser. Run: open ${filePath}`);
    }
  }

  return { filePath, opened: !skipOpen };
}
