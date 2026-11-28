import { execFile as execFileCb } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { getScopedMemoryFilesystemRoot } from "@/agent/memory-filesystem";
import { detectMemoryFormat, isCoreMemoryPath } from "@/agent/memory-format";
import {
  getFileNodes,
  readFileContent,
  scanMemoryFilesystem,
} from "@/agent/memory-scanner";
import { getAgentContextOverview } from "@/backend/api/agents";
import { getClient } from "@/backend/api/client";
import { apiRequest } from "@/backend/api/request";
import { getServerUrl } from "@/backend/api/server-url";
import type { MemoryFileEntry } from "@/types/protocol_v2";
import { resolveGlobalConfigDir } from "@/utils/settings-path";
import {
  applyContextUsageSnapshot,
  type ContextUsageSnapshot,
} from "./context-usage";
import { collectLocalMemoryContextData } from "./local-memory-context";
import memoryViewerTemplate from "./memory-viewer-template.txt";
import type {
  ContextData,
  ConversationInfo,
  MemoryCommit,
  MemoryFile,
  MemoryViewerData,
  MessageInfo,
} from "./types";

const execFile = promisify(execFileCb);

const VIEWERS_DIR = join(resolveGlobalConfigDir(), "viewers");
const MAX_COMMITS = 500;
const RECENT_DIFF_COUNT = 50;
const PER_DIFF_CAP = 100_000;
const TOTAL_PAYLOAD_CAP = 5_000_000;
const RECORD_SEP = "\x1e";

type ConversationListItem = {
  id?: string | null;
  created_at?: string | null;
  last_run_completion?: string | null;
  label?: string | null;
};

type ContextOverviewResponse = {
  messages?: Array<{
    id: string;
    role: string;
    content: string | unknown[];
    conversation_id?: string | null;
    created_at: string;
  }>;
  context_window_size_max: number;
  context_window_size_current: number;
  num_tokens_system: number;
  num_tokens_core_memory: number;
  num_tokens_external_memory_summary: number;
  num_tokens_summary_memory: number;
  num_tokens_functions_definitions: number;
  num_tokens_messages: number;
};

function messagesFromOverview(
  overview: ContextOverviewResponse,
): MessageInfo[] | undefined {
  return overview.messages?.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    conversation_id: message.conversation_id,
    created_at: message.created_at,
  }));
}

function contextFromOverview(
  overview: ContextOverviewResponse,
  model: string,
  contextWindow?: number,
): ContextData {
  return {
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

export interface GenerateResult {
  filePath: string;
  opened: boolean;
}

export interface GenerateMemoryViewerOptions {
  agentName?: string;
  conversationId?: string;
  contextUsage?: ContextUsageSnapshot;
}

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

export function collectMemoryViewerFiles(memoryRoot: string): MemoryFile[] {
  const format = detectMemoryFormat(memoryRoot, false);
  const treeNodes = scanMemoryFilesystem(memoryRoot);
  const fileNodes = getFileNodes(treeNodes);

  return fileNodes
    .filter((n) => n.name.endsWith(".md"))
    .map((n) => {
      const raw = readFileContent(n.fullPath);
      const { frontmatter, body } = parseFrontmatter(raw);
      return {
        path: n.relativePath,
        isSystem: isCoreMemoryPath(n.relativePath, format),
        frontmatter,
        content: body,
      };
    });
}

async function collectMetadata(repoDir: string): Promise<
  Array<{
    hash: string;
    author: string;
    date: string;
    subject: string;
    body: string;
  }>
> {
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

async function getTotalCommitCount(repoDir: string): Promise<number> {
  const raw = await runGitSafe(repoDir, ["rev-list", "--count", "HEAD"]);
  const n = parseInt(raw.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

const REFLECTION_PATTERN = /\(reflection\)|🔮|reflection:/i;

async function collectMemoryData(
  agentId: string,
  repoDir: string,
  memoryRoot: string,
  conversationId?: string,
): Promise<MemoryViewerData> {
  const files = collectMemoryViewerFiles(memoryRoot);

  const [metadata, statsMap, diffsMap, totalCount] = await Promise.all([
    collectMetadata(repoDir),
    collectStats(repoDir),
    collectDiffs(repoDir),
    getTotalCommitCount(repoDir),
  ]);

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

  let agentName = agentId;
  let context: ContextData | undefined;
  let messages: MessageInfo[] | undefined;
  let conversations: ConversationInfo[] | undefined;
  let model = "unknown";

  try {
    const localData = await collectLocalMemoryContextData(
      agentId,
      conversationId,
    );
    if (localData.agentName) agentName = localData.agentName;
    if (localData.model) model = localData.model;
    context = localData.context;
    messages = localData.messages;
    conversations = localData.conversations;
  } catch {}

  if (!context) {
    try {
      const client = await getClient();
      const agent = await client.agents.retrieve(agentId);
      if (agent.name) agentName = agent.name;
      model = agent.llm_config?.model ?? "unknown";

      const contextWindow = agent.llm_config?.context_window ?? 0;
      try {
        const overview = await getAgentContextOverview<ContextOverviewResponse>(
          agentId,
          { signal: AbortSignal.timeout(5000) },
        );
        messages = messagesFromOverview(overview);
        context = contextFromOverview(overview, model, contextWindow);
      } catch {}
    } catch {
      try {
        const apiKey = process.env.LETTA_API_KEY || "";
        if (apiKey && serverUrl) {
          const [agentData, overview] = await Promise.all([
            apiRequest<{
              name?: string;
              llm_config?: { model?: string; context_window?: number };
            }>("GET", `/v1/agents/${agentId}`, undefined, {
              baseUrl: serverUrl,
              apiKey,
              signal: AbortSignal.timeout(5000),
            }).catch(() => null),
            apiRequest<ContextOverviewResponse>(
              "GET",
              `/v1/agents/${agentId}/context`,
              undefined,
              {
                baseUrl: serverUrl,
                apiKey,
                signal: AbortSignal.timeout(5000),
              },
            ).catch(() => null),
          ]);

          if (agentData?.name) agentName = agentData.name;
          if (agentData?.llm_config?.model) model = agentData.llm_config.model;

          if (overview) {
            messages = messagesFromOverview(overview);
            context = contextFromOverview(
              overview,
              model,
              agentData?.llm_config?.context_window,
            );
          }
        }
      } catch {}
    }
  }

  if (!conversations) {
    try {
      const client = await getClient();
      const convPage = await client.conversations.list({
        agent_id: agentId,
        limit: 10,
        order: "desc",
        order_by: "last_run_completion",
      });
      const convItems = convPage as ConversationListItem[];
      conversations = convItems.flatMap((c) => {
        if (!c.id || !c.created_at) {
          return [];
        }
        return [
          {
            id: c.id,
            created_at: c.created_at,
            last_run_completion: c.last_run_completion ?? null,
            label: c.label ?? null,
          },
        ];
      });
    } catch {}
  }

  return {
    agent: { id: agentId, name: agentName, serverUrl },
    generatedAt: new Date().toISOString(),
    totalCommitCount: totalCount || commits.length,
    files,
    commits,
    context,
    conversations,
    messages,
    selectedConversationId: conversationId ?? undefined,
  };
}

export async function generateAndOpenMemoryViewer(
  agentId: string,
  options?: GenerateMemoryViewerOptions,
): Promise<GenerateResult> {
  const memoryRoot = getScopedMemoryFilesystemRoot(agentId);
  const repoDir = memoryRoot;

  if (!existsSync(join(repoDir, ".git"))) {
    throw new Error("Memory viewer requires memfs. Run /memfs enable first.");
  }

  const data = await collectMemoryData(
    agentId,
    repoDir,
    memoryRoot,
    options?.conversationId,
  );

  if (options?.agentName) {
    data.agent.name = options.agentName;
  }

  data.context = applyContextUsageSnapshot(data.context, options?.contextUsage);

  return openMemoryViewerData(data);
}

export function openSessionMemoryViewer(
  agentId: string,
  entries: readonly MemoryFileEntry[],
  conversationId?: string,
) {
  return openMemoryViewerData({
    agent: { id: agentId, name: agentId, serverUrl: "" },
    generatedAt: new Date().toISOString(),
    totalCommitCount: 0,
    commits: [],
    selectedConversationId: conversationId,
    files: entries
      .filter((entry) => entry.kind !== "image")
      .map((entry) => {
        const { body, frontmatter } = parseFrontmatter(entry.content);
        return {
          path: entry.relative_path,
          isSystem: entry.is_system,
          content: body,
          frontmatter,
        };
      }),
  });
}

async function openMemoryViewerData(
  data: MemoryViewerData,
): Promise<GenerateResult> {
  const jsonPayload = JSON.stringify(data).replace(/</g, "\\u003c");
  const html = memoryViewerTemplate.replace(
    "<!--LETTA_DATA_PLACEHOLDER-->",
    () => jsonPayload,
  );

  if (!existsSync(VIEWERS_DIR)) {
    mkdirSync(VIEWERS_DIR, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(VIEWERS_DIR, 0o700);
  } catch {}

  const filePath = join(
    VIEWERS_DIR,
    `memory-${encodeURIComponent(data.agent.id)}.html`,
  );
  writeFileSync(filePath, html);
  chmodSync(filePath, 0o600);

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
