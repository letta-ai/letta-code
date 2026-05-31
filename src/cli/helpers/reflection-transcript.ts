import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_SYSTEM_DIR } from "@/agent/memory-filesystem";
import { REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT } from "@/agent/subagents/context-budget";
import { getBackend } from "@/backend";
import {
  type ConversationSearchResult,
  searchConversationsForBackend,
} from "@/backend/conversation-search";
import { getDirectoryLimits } from "@/utils/directory-limits";
import { withFileLock } from "@/utils/file-lock";
import { parseFrontmatter } from "@/utils/frontmatter";
import type { Line } from "./accumulator";
import { safeJsonParseOr } from "./safe-json-parse";

const TRANSCRIPT_ROOT_ENV = "LETTA_TRANSCRIPT_ROOT";
const DEFAULT_TRANSCRIPT_DIR = "transcripts";
export const REFLECTION_STATE_SCHEMA_VERSION = "v2_message_id" as const;

export interface ReflectionTranscriptState {
  schema_version: typeof REFLECTION_STATE_SCHEMA_VERSION;
  reflected_through_message_id?: string;
  total_completed_turns: number;
  reflected_completed_turns: number;
  turns_since_last_successful_reflection: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

interface LegacyReflectionTranscriptState {
  auto_cursor_line: number;
  last_auto_reflection_started_at?: string;
  last_auto_reflection_succeeded_at?: string;
}

type TranscriptEntry =
  | {
      kind: "user" | "assistant" | "reasoning" | "error";
      text: string;
      captured_at: string;
      source_line_id?: string; // local transcript row id; may be synthetic
      source_message_id?: string; // canonical backend message.id when known
    }
  | {
      kind: "tool_call";
      name?: string;
      argsText?: string;
      resultText?: string;
      resultOk?: boolean;
      captured_at: string;
      source_line_id?: string; // local transcript row id; may be synthetic
      source_message_id?: string; // canonical backend message.id when known
    };

export interface ReflectionTranscriptPaths {
  /** ~/.letta/transcripts/{agentId}/{conversationId}/ */
  rootDir: string;
  transcriptPath: string;
  statePath: string;
}

export interface AutoReflectionPayload {
  payloadPath: string;
  startMessageId?: string;
  endMessageId?: string;
  endSnapshotLine: number;
}

export type ReflectionSliceMode = "unreflected" | "replay";

export interface MultiReflectionTranscriptSlice {
  conversation_id: string;
  mode: ReflectionSliceMode;
  payload_path: string;
  selection_reason?: string;
  selection_priority?: ReflectionDiscoveryPriority;
  start_message_id: string;
  end_message_id: string;
  start_line: number;
  end_line: number;
  end_snapshot_line: number;
  completed_turns: number;
  approx_chars: number;
  last_updated_at?: string;
}

export interface MultiReflectionManifest {
  schema_version: 1;
  type: "multi_transcript_reflection_payload";
  agent_id: string;
  created_at: string;
  selection_policy:
    | { mode: "recent"; limit: number }
    | { mode: "explicit-conversations"; conversation_ids: string[] }
    | {
        mode: "discovered";
        selected_conversations: ReflectionDiscoverySelectedConversation[];
        catalog_path?: string;
      };
  transcripts: MultiReflectionTranscriptSlice[];
}

export interface MultiReflectionPayload {
  payloadPath: string;
  manifest: MultiReflectionManifest;
  startMessageId?: string;
  endMessageId?: string;
}

export interface ReflectionTranscriptCandidate {
  conversationId: string;
  transcriptPath: string;
  statePath: string;
  lastUpdatedAt?: string;
  totalCompletedTurns: number;
  reflectedCompletedTurns: number;
  turnsSinceLastSuccessfulReflection: number;
}

export type ReflectionDiscoveryPriority = "high" | "medium" | "low";

export interface ReflectionDiscoverySelectedConversation {
  conversation_id: string;
  reason: string;
  priority?: ReflectionDiscoveryPriority;
}

export interface ReflectionDiscoverySearchScore {
  query: string;
  rrf_score: number;
  normalized_score: number;
}

export interface ReflectionDiscoveryCandidate {
  conversation_id: string;
  summary?: string;
  description?: string;
  last_updated_at?: string;
  total_completed_turns: number;
  reflected_completed_turns: number;
  turns_since_last_successful_reflection: number;
  has_unreflected_content: boolean;
  is_current_conversation: boolean;
  sources: string[];
  search_scores: ReflectionDiscoverySearchScore[];
  heuristic_score: number;
}

export interface ReflectionDiscoveryCatalog {
  schema_version: 1;
  type: "reflection_discovery_catalog";
  agent_id: string;
  current_conversation_id?: string;
  created_at: string;
  max_selected: number;
  selection_output_path: string;
  instructions: string;
  candidates: ReflectionDiscoveryCandidate[];
}

export interface ReflectionDiscoverySelection {
  selected_conversations: ReflectionDiscoverySelectedConversation[];
}

export interface ReflectionDiscoveryPayload {
  catalogPath: string;
  selectionOutputPath: string;
  catalog: ReflectionDiscoveryCatalog;
}

export interface ReflectionPromptInput {
  memoryDir: string;
  parentMemory?: string;
}

export function buildReflectionSubagentPrompt(
  input: ReflectionPromptInput,
): string {
  const lines: string[] = [];

  lines.push(
    "Review the conversation transcript payload and update memory files. The payload path is available as the `$TRANSCRIPT_PATH` env var — read it via Bash (e.g. `cat $TRANSCRIPT_PATH`). Note: `$TRANSCRIPT_PATH` only expands in shell commands; Edit/Read/Write `file_path` is literal and does NOT expand env vars.",
    "",
    'The payload may be either a JSON message array for one conversation or a `multi_transcript_reflection_payload` manifest. If it is a manifest, read each `payload_path` listed in `transcripts` and synthesize across all conversations. Entries with `mode: "replay"` were already reflected before and are included intentionally for re-review/deduplication; do not ignore them just because they are replay slices.',
    "When reviewing multiple transcripts, prefer durable patterns and latest evidence across sessions. Resolve contradictions by updating stale memory at the source, deduplicate repeated facts, and avoid storing one-off task state.",
    "",
    `The primary agent's memory filesystem is located at: ${input.memoryDir}`,
    "In-context memory (in the parent agent's system prompt) is stored in the `system/` folder and are rendered in <memory> tags below. Modification to files in `system/` will edit the parent agent's system prompt.",
    "Additional memory files (such as skills and external memory) may also be read and modified.",
    "",
  );

  if (input.parentMemory) {
    lines.push(input.parentMemory);
  }
  return lines.join("\n");
}

export function buildReflectionSelectorPrompt(): string {
  return [
    "You are selecting conversation transcripts for memory reflection. The discovery catalog path is available as the `$TRANSCRIPT_PATH` env var — read it via Bash (e.g. `cat $TRANSCRIPT_PATH`). Note: `$TRANSCRIPT_PATH` only expands in shell commands; Read/Edit file_path is literal and does NOT expand env vars.",
    "",
    "The payload is a `reflection_discovery_catalog` with compact metadata about candidate conversations. Your job is only to choose which conversations should be opened for a full reflection pass. Do not edit memory files. Do not commit anything.",
    "",
    "Select up to `max_selected` conversations. Prefer candidates likely to contain durable memory updates: explicit user corrections, repeated preferences, coding/review/commit style preferences, repo or workflow gotchas, durable facts about people/projects, contradictions with current memory, or repeated agent failures.",
    "Avoid one-off debugging, transient task status, duplicated/redundant candidates, and conversations already fully reflected unless they are useful for deduplication or contradiction resolution.",
    "Treat summaries/descriptions as weak internal metadata, not confirmed facts. The final reflection pass will verify against the actual transcript before writing memory.",
    "",
    "Write strict JSON to the catalog's `selection_output_path` with this shape:",
    '{"selected_conversations":[{"conversation_id":"conv-...","reason":"durable reason for selecting this transcript","priority":"high"}]}',
    'Use priority values `high`, `medium`, or `low`. If nothing looks memory-worthy, write `{"selected_conversations":[]}`.',
  ].join("\n");
}

interface ParentMemoryFile {
  relativePath: string;
  content: string;
  description?: string;
}

interface ParentMemorySnapshotOptions {
  /** Maximum characters for the full rendered parent-memory preview. */
  maxChars?: number;
}

function isSystemMemoryFile(relativePath: string): boolean {
  return relativePath.startsWith(`${MEMORY_SYSTEM_DIR}/`);
}

async function collectParentMemoryFiles(
  memoryDir: string,
): Promise<ParentMemoryFile[]> {
  const files: ParentMemoryFile[] = [];

  const walk = async (currentDir: string, relativeDir: string) => {
    let entries: Dirent[] = [];
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    const sortedEntries = entries
      .filter((entry) => !entry.name.startsWith("."))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) {
          return a.isDirectory() ? -1 : 1;
        }
        return a.name.localeCompare(b.name);
      });

    for (const entry of sortedEntries) {
      const entryPath = join(currentDir, entry.name);
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;

      if (entry.isDirectory()) {
        await walk(entryPath, relativePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }

      try {
        const content = await readFile(entryPath, "utf-8");
        const { frontmatter } = parseFrontmatter(content);
        const description =
          typeof frontmatter.description === "string"
            ? frontmatter.description
            : undefined;
        files.push({
          relativePath: relativePath.replace(/\\/g, "/"),
          content,
          description,
        });
      } catch {
        // Skip unreadable files.
      }
    }
  };

  await walk(memoryDir, "");
  return files;
}

function buildParentMemoryTree(files: ParentMemoryFile[]): string {
  type TreeNode = {
    children: Map<string, TreeNode>;
    isFile: boolean;
    description?: string;
  };

  const makeNode = (): TreeNode => ({ children: new Map(), isFile: false });
  const root = makeNode();

  for (const file of files) {
    const normalizedPath = file.relativePath.replace(/\\/g, "/");
    const parts = normalizedPath.split("/");
    let current = root;

    for (const [index, part] of parts.entries()) {
      if (!current.children.has(part)) {
        current.children.set(part, makeNode());
      }
      current = current.children.get(part) as TreeNode;
      if (index === parts.length - 1) {
        current.isFile = true;
        if (file.description && !isSystemMemoryFile(normalizedPath)) {
          current.description = file.description;
        }
      }
    }
  }

  if (!root.children.has(MEMORY_SYSTEM_DIR)) {
    root.children.set(MEMORY_SYSTEM_DIR, makeNode());
  }

  const sortedEntries = (node: TreeNode) =>
    Array.from(node.children.entries()).sort(
      ([nameA, nodeA], [nameB, nodeB]) => {
        if (nodeA.isFile !== nodeB.isFile) {
          return nodeA.isFile ? 1 : -1;
        }
        return nameA.localeCompare(nameB);
      },
    );

  const limits = getDirectoryLimits();
  const maxLines = Math.max(2, limits.memfsTreeMaxLines);
  const maxChars = Math.max(128, limits.memfsTreeMaxChars);
  const maxChildrenPerDir = Math.max(1, limits.memfsTreeMaxChildrenPerDir);

  const rootLine = "/memory/";
  const lines: string[] = [rootLine];
  let totalChars = rootLine.length;

  const countTreeEntries = (node: TreeNode): number => {
    let total = 0;
    for (const [, child] of node.children) {
      total += 1;
      if (child.children.size > 0) {
        total += countTreeEntries(child);
      }
    }
    return total;
  };

  const canAppendLine = (line: string): boolean => {
    const nextLineCount = lines.length + 1;
    const nextCharCount = totalChars + 1 + line.length;
    return nextLineCount <= maxLines && nextCharCount <= maxChars;
  };

  const render = (node: TreeNode, prefix: string): boolean => {
    const entries = sortedEntries(node);
    const visibleEntries = entries.slice(0, maxChildrenPerDir);
    const omittedEntries = Math.max(0, entries.length - visibleEntries.length);

    const renderItems: Array<
      | { kind: "entry"; name: string; child: TreeNode }
      | { kind: "omitted"; omittedCount: number }
    > = visibleEntries.map(([name, child]) => ({
      kind: "entry",
      name,
      child,
    }));

    if (omittedEntries > 0) {
      renderItems.push({ kind: "omitted", omittedCount: omittedEntries });
    }

    for (const [index, item] of renderItems.entries()) {
      const isLast = index === renderItems.length - 1;
      const branch = isLast ? "└──" : "├──";
      const line =
        item.kind === "entry"
          ? `${prefix}${branch} ${item.name}${item.child.isFile ? "" : "/"}${item.child.description ? ` (${item.child.description})` : ""}`
          : `${prefix}${branch} … (${item.omittedCount.toLocaleString()} more entries)`;

      if (!canAppendLine(line)) {
        return false;
      }

      lines.push(line);
      totalChars += 1 + line.length;

      if (item.kind === "entry" && item.child.children.size > 0) {
        const nextPrefix = `${prefix}${isLast ? "    " : "│   "}`;
        if (!render(item.child, nextPrefix)) {
          return false;
        }
      }
    }

    return true;
  };

  const totalEntries = countTreeEntries(root);
  const fullyRendered = render(root, "");

  if (!fullyRendered) {
    while (lines.length > 1) {
      const shownEntries = Math.max(0, lines.length - 1);
      const omittedEntries = Math.max(1, totalEntries - shownEntries);
      const notice = `[Tree truncated: showing ${shownEntries.toLocaleString()} of ${totalEntries.toLocaleString()} entries. ${omittedEntries.toLocaleString()} omitted.]`;

      if (canAppendLine(notice)) {
        lines.push(notice);
        break;
      }

      const removed = lines.pop();
      if (removed) {
        totalChars -= 1 + removed.length;
      }
    }
  }

  return lines.join("\n");
}

function joinedLength(lines: string[]): number {
  return lines.join("\n").length;
}

function canAppendWithinBudget(
  lines: string[],
  additions: string[],
  maxChars: number,
): boolean {
  return joinedLength([...lines, ...additions, "</parent_memory>"]) <= maxChars;
}

function truncateMemoryContentToFit(
  lines: string[],
  prefix: string[],
  content: string,
  suffix: string[],
  maxChars: number,
): string | null {
  const fixedLength = joinedLength([
    ...lines,
    ...prefix,
    "",
    ...suffix,
    "</parent_memory>",
  ]);
  const budget = maxChars - fixedLength;
  if (budget <= 0) {
    return null;
  }

  return content.slice(0, budget).trimEnd();
}

function buildMemoryPreviewNotice(
  relativePath: string,
  absolutePath: string,
  kind: "truncated" | "omitted",
): string {
  const action = kind === "truncated" ? "truncated" : "omitted";
  return `[Memory preview ${action}: startup context is capped at ~16k estimated tokens. Full file available at ${absolutePath}; read it directly if needed. Relative path: ${relativePath}]`;
}

export async function buildParentMemorySnapshot(
  memoryDir: string,
  options: ParentMemorySnapshotOptions = {},
): Promise<string> {
  const files = await collectParentMemoryFiles(memoryDir);
  const tree = buildParentMemoryTree(files);
  const systemFiles = files.filter((file) =>
    isSystemMemoryFile(file.relativePath),
  );
  const maxChars = Math.max(
    1_000,
    options.maxChars ?? REFLECTION_PARENT_MEMORY_SNAPSHOT_CHAR_LIMIT,
  );

  const lines = [
    "<parent_memory>",
    "<memory_filesystem>",
    tree,
    "</memory_filesystem>",
  ];

  if (files.length === 0) {
    lines.push("(no memory markdown files found)");
  } else {
    let omittedSystemFiles = 0;

    for (const file of systemFiles) {
      const normalizedPath = file.relativePath.replace(/\\/g, "/");
      const absolutePath = `${memoryDir.replace(/\\/g, "/")}/${normalizedPath}`;
      const prefix = ["<memory>", `<path>${absolutePath}</path>`];
      const suffix = ["</memory>"];
      const fullEntry = [...prefix, file.content, ...suffix];

      if (canAppendWithinBudget(lines, fullEntry, maxChars)) {
        lines.push(...fullEntry);
        continue;
      }

      const truncatedNotice = buildMemoryPreviewNotice(
        normalizedPath,
        absolutePath,
        "truncated",
      );
      const truncatedContent = truncateMemoryContentToFit(
        lines,
        prefix,
        file.content,
        [truncatedNotice, ...suffix],
        maxChars,
      );

      if (truncatedContent) {
        const truncatedEntry = [
          ...prefix,
          truncatedContent,
          truncatedNotice,
          ...suffix,
        ];
        if (canAppendWithinBudget(lines, truncatedEntry, maxChars)) {
          lines.push(...truncatedEntry);
          continue;
        }
      }

      const omittedEntry = [
        ...prefix,
        buildMemoryPreviewNotice(normalizedPath, absolutePath, "omitted"),
        ...suffix,
      ];
      if (canAppendWithinBudget(lines, omittedEntry, maxChars)) {
        lines.push(...omittedEntry);
      } else {
        omittedSystemFiles += 1;
      }
    }

    if (omittedSystemFiles > 0) {
      const notice = `[Memory preview omitted ${omittedSystemFiles.toLocaleString()} additional system file(s) because the reflection startup context budget was exhausted. Read files directly from ${memoryDir} if needed.]`;
      if (canAppendWithinBudget(lines, [notice], maxChars)) {
        lines.push(notice);
      }
    }
  }

  lines.push("</parent_memory>");
  return lines.join("\n");
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "unknown";
}

function getTranscriptRoot(): string {
  const envRoot = process.env[TRANSCRIPT_ROOT_ENV]?.trim();
  if (envRoot) {
    return envRoot;
  }
  return join(homedir(), ".letta", DEFAULT_TRANSCRIPT_DIR);
}

function defaultState(): ReflectionTranscriptState {
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_completed_turns: 0,
    reflected_completed_turns: 0,
    turns_since_last_successful_reflection: 0,
  };
}

const stateMutexes = new Map<string, Promise<unknown>>();

function withStateLock<T>(
  agentId: string,
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const key = `${agentId}::${conversationId}`;
  const previous = stateMutexes.get(key) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const paths = getReflectionTranscriptPaths(agentId, conversationId);
      await mkdir(paths.rootDir, { recursive: true });
      return withFileLock(`${paths.statePath}.lock`, fn);
    });
  const tail = next.catch(() => undefined);
  stateMutexes.set(key, tail);
  tail.finally(() => {
    if (stateMutexes.get(key) === tail) {
      stateMutexes.delete(key);
    }
  });
  return next;
}

function isEligibleCanonicalEntry(
  entry: TranscriptEntry,
): entry is TranscriptEntry & { source_message_id: string } {
  return (
    (entry.kind === "user" || entry.kind === "assistant") &&
    typeof entry.source_message_id === "string" &&
    entry.source_message_id.length > 0
  );
}

function countUserRows(entries: TranscriptEntry[]): number {
  return entries.filter((entry) => entry.kind === "user").length;
}

/** Maximum characters to keep for tool-call arguments in the reflection payload. */
const TOOL_ARGS_TRUNCATE_LIMIT = 300;

/**
 * Truncate text to a character limit, appending a marker when content is cut.
 */
function truncateArgs(
  text: string | undefined,
  limit: number,
): string | undefined {
  if (text === undefined) return undefined;
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…[truncated]`;
}

/**
 * Strip inline base64 image data and data-URI image references from text.
 * This is a safety net — the accumulator's `extractTextPart` already drops
 * multimodal image_url parts, but pasted/inline base64 could still appear.
 */
function stripImagesFromText(text: string): string {
  // Strip data:image URIs (including surrounding markdown image syntax)
  return text.replace(
    /!\[[^\]]*\]\(data:image\/[^)]+\)|data:image\/[^\s"')]+/g,
    "[image]",
  );
}

/**
 * JSON message entry for the reflection payload.
 * Follows the ChatML-style format from the reference transcript spec.
 */
type ReflectionMessage =
  | { role: "system" | "user" | "reasoning" | "error"; content: string }
  | {
      role: "assistant";
      content: string;
    }
  | {
      role: "assistant";
      content: null;
      tool_calls: Array<{ name: string; args: string }>;
    };

/**
 * Serialize transcript entries (and optional filtered system prompt) into a
 * JSON message array for the reflection subagent.
 *
 * Output is a flat array of `{ role, content, tool_calls? }` objects.
 */
function formatTaggedTranscript(
  entries: TranscriptEntry[],
  filteredSystemPrompt?: string,
): string {
  const messages: ReflectionMessage[] = [];

  if (filteredSystemPrompt) {
    messages.push({ role: "system", content: filteredSystemPrompt });
  }

  for (const entry of entries) {
    switch (entry.kind) {
      case "user":
        messages.push({
          role: "user",
          content: stripImagesFromText(entry.text),
        });
        break;
      case "assistant":
        messages.push({
          role: "assistant",
          content: stripImagesFromText(entry.text),
        });
        break;
      case "reasoning":
        messages.push({ role: "reasoning", content: entry.text });
        break;
      case "error":
        messages.push({ role: "error", content: entry.text });
        break;
      case "tool_call": {
        const args =
          truncateArgs(entry.argsText, TOOL_ARGS_TRUNCATE_LIMIT) ?? "{}";
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [{ name: entry.name ?? "unknown", args }],
        });
        break;
      }
    }
  }
  return JSON.stringify(messages, null, 2);
}

function lineToTranscriptEntry(
  line: Line,
  capturedAt: string,
): TranscriptEntry | null {
  switch (line.kind) {
    case "user":
      return {
        kind: "user",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
        source_message_id: line.messageId,
      };
    case "assistant":
      return {
        kind: "assistant",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
        source_message_id: line.messageId,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
        source_message_id: line.messageId,
      };
    case "error":
      return {
        kind: "error",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
      };
    case "tool_call":
      return {
        kind: "tool_call",
        name: line.name,
        argsText: line.argsText,
        resultText: line.resultText,
        resultOk: line.resultOk,
        captured_at: capturedAt,
        source_line_id: line.id,
      };
    default:
      return null;
  }
}

async function ensurePaths(paths: ReflectionTranscriptPaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await writeFile(paths.transcriptPath, "", { encoding: "utf-8", flag: "a" });
}

async function readTranscriptLines(
  paths: ReflectionTranscriptPaths,
): Promise<string[]> {
  try {
    const raw = await readFile(paths.transcriptPath, "utf-8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

type ParsedTranscriptRow = {
  entry: TranscriptEntry;
  lineIndex: number;
};

function parseTranscriptRows(lines: string[]): ParsedTranscriptRow[] {
  return lines
    .map((line, lineIndex) => {
      const entry = safeJsonParseOr<TranscriptEntry | null>(line, null);
      return entry ? { entry, lineIndex } : null;
    })
    .filter((row): row is ParsedTranscriptRow => row !== null);
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeNonNegativeInteger(value: unknown, fallback = 0): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value >= 0
    ? value
    : fallback;
}

function normalizeV2State(
  parsed: Partial<ReflectionTranscriptState>,
): ReflectionTranscriptState {
  const totalCompletedTurns = normalizeNonNegativeInteger(
    parsed.total_completed_turns,
  );
  const reflectedCompletedTurns = Math.min(
    normalizeNonNegativeInteger(parsed.reflected_completed_turns),
    totalCompletedTurns,
  );
  const turnsSinceLastSuccessfulReflection = Math.max(
    0,
    totalCompletedTurns - reflectedCompletedTurns,
  );

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id: normalizeString(
      parsed.reflected_through_message_id,
    ),
    total_completed_turns: totalCompletedTurns,
    reflected_completed_turns: reflectedCompletedTurns,
    turns_since_last_successful_reflection: turnsSinceLastSuccessfulReflection,
    last_reflection_started_at: normalizeString(
      parsed.last_reflection_started_at,
    ),
    last_reflection_succeeded_at: normalizeString(
      parsed.last_reflection_succeeded_at,
    ),
  };
}

function migrateLegacyState(
  parsed: Partial<LegacyReflectionTranscriptState> | null,
  lines: string[],
): ReflectionTranscriptState {
  const rows = parseTranscriptRows(lines);
  const cursorLine = Math.min(
    Math.max(
      0,
      typeof parsed?.auto_cursor_line === "number"
        ? Math.floor(parsed.auto_cursor_line)
        : 0,
    ),
    lines.length,
  );
  const prefixRows = rows.filter((row) => row.lineIndex < cursorLine);
  const lastCanonicalRow = prefixRows.findLast((row) =>
    isEligibleCanonicalEntry(row.entry),
  );
  const reflectedThroughMessageId = lastCanonicalRow
    ? lastCanonicalRow.entry.source_message_id
    : undefined;
  const allEntries = rows.map((row) => row.entry);
  const reflectedEntries = lastCanonicalRow
    ? rows
        .filter((row) => row.lineIndex <= lastCanonicalRow.lineIndex)
        .map((row) => row.entry)
    : [];
  const totalCompletedTurns = countUserRows(allEntries);
  const reflectedCompletedTurns = reflectedThroughMessageId
    ? countUserRows(reflectedEntries)
    : 0;

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id: reflectedThroughMessageId,
    total_completed_turns: totalCompletedTurns,
    reflected_completed_turns: reflectedCompletedTurns,
    turns_since_last_successful_reflection: Math.max(
      0,
      totalCompletedTurns - reflectedCompletedTurns,
    ),
    last_reflection_started_at: normalizeString(
      parsed?.last_auto_reflection_started_at,
    ),
    last_reflection_succeeded_at: normalizeString(
      parsed?.last_auto_reflection_succeeded_at,
    ),
  };
}

async function readState(
  paths: ReflectionTranscriptPaths,
): Promise<ReflectionTranscriptState> {
  let raw: string | null = null;
  try {
    raw = await readFile(paths.statePath, "utf-8");
  } catch {
    raw = null;
  }
  const parsed = raw
    ? safeJsonParseOr<Partial<
        ReflectionTranscriptState & LegacyReflectionTranscriptState
      > | null>(raw, null)
    : null;

  if (parsed?.schema_version === REFLECTION_STATE_SCHEMA_VERSION) {
    const state = normalizeV2State(parsed);
    if (JSON.stringify(state) !== JSON.stringify(parsed)) {
      await writeState(paths, state);
    }
    return state;
  }

  if (!parsed) {
    const state = defaultState();
    await writeState(paths, state);
    return state;
  }

  const transcriptLines = await readTranscriptLines(paths);
  const migrated = migrateLegacyState(parsed, transcriptLines);
  await writeState(paths, migrated);
  return migrated;
}

async function writeState(
  paths: ReflectionTranscriptPaths,
  state: ReflectionTranscriptState,
): Promise<void> {
  state.turns_since_last_successful_reflection = Math.max(
    0,
    state.total_completed_turns - state.reflected_completed_turns,
  );
  await writeFile(
    paths.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

function buildPayloadPath(
  rootDir: string,
  kind: "auto" | "discover" | "multi" | "remember" | "selected" | "slice",
): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(rootDir, `payload-${kind}-${nonce}.json`);
}

function getAgentTranscriptRoot(agentId: string): string {
  return join(getTranscriptRoot(), sanitizePathSegment(agentId));
}

export function getReflectionTranscriptPaths(
  agentId: string,
  conversationId: string,
): ReflectionTranscriptPaths {
  const rootDir = join(
    getTranscriptRoot(),
    sanitizePathSegment(agentId),
    sanitizePathSegment(conversationId),
  );
  return {
    rootDir,
    transcriptPath: join(rootDir, "transcript.jsonl"),
    statePath: join(rootDir, "state.json"),
  };
}

export async function appendTranscriptDeltaJsonl(
  agentId: string,
  conversationId: string,
  lines: Line[],
): Promise<number> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    const state = await readState(paths);

    const capturedAt = new Date().toISOString();
    const entries = lines
      .map((line) => lineToTranscriptEntry(line, capturedAt))
      .filter((entry): entry is TranscriptEntry => entry !== null);
    if (entries.length === 0) {
      return 0;
    }

    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
    await appendFile(paths.transcriptPath, `${payload}\n`, "utf-8");
    state.total_completed_turns += countUserRows(entries);
    await writeState(paths, state);
    return entries.length;
  });
}

/**
 * Strip dynamic / noisy sections from a system prompt so the reflection agent
 * sees only the core behavioural instructions.
 *
 * Removes:
 * - XML blocks: `<memory>`, `<self>`, `<human>`, `<available_skills>`,
 *   `<system-reminder>`, `<memory_metadata>`
 * - The `# Memory` markdown section (operational memory-filesystem docs)
 */
export function filterSystemPromptForReflection(raw: string): string {
  // Remove XML-style blocks that carry dynamic/ephemeral content.
  // Using [\s\S] instead of . so we cross newlines.
  const tagsToStrip = [
    "memory",
    "self",
    "human",
    "available_skills",
    "system-reminder",
    "memory_metadata",
  ];
  let filtered = raw;
  for (const tag of tagsToStrip) {
    filtered = filtered.replace(
      new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"),
      "",
    );
  }
  // Strip the "# Memory" markdown section (and everything after it).
  // This section contains operational memory-filesystem docs that the
  // reflection agent doesn't need.
  filtered = filtered.replace(/\n# Memory\n[\s\S]*$/, "");
  // Collapse runs of 3+ blank lines into 2
  filtered = filtered.replace(/\n{3,}/g, "\n\n");
  return filtered.trim();
}

type TranscriptSelection = {
  startLineIndex: number;
  endLineIndex: number;
  startMessageId: string;
  endMessageId: string;
};

function selectUnreflectedTranscriptRange(
  rows: ParsedTranscriptRow[],
  reflectedThroughMessageId?: string,
): TranscriptSelection | null {
  if (rows.length === 0) {
    return null;
  }

  const anchorRow =
    reflectedThroughMessageId === undefined
      ? undefined
      : rows.find(
          (row) =>
            isEligibleCanonicalEntry(row.entry) &&
            row.entry.source_message_id === reflectedThroughMessageId,
        );
  const afterLineIndex = anchorRow ? anchorRow.lineIndex : -1;
  const startRow = rows.find(
    (row) =>
      row.lineIndex > afterLineIndex && isEligibleCanonicalEntry(row.entry),
  );
  if (!startRow || !isEligibleCanonicalEntry(startRow.entry)) {
    return null;
  }

  const endRow = rows.findLast(
    (row) =>
      row.lineIndex >= startRow.lineIndex &&
      isEligibleCanonicalEntry(row.entry),
  );
  if (!endRow || !isEligibleCanonicalEntry(endRow.entry)) {
    return null;
  }

  return {
    startLineIndex: afterLineIndex + 1,
    endLineIndex: endRow.lineIndex,
    startMessageId: startRow.entry.source_message_id,
    endMessageId: endRow.entry.source_message_id,
  };
}

function entriesForSelection(
  rows: ParsedTranscriptRow[],
  selection: TranscriptSelection,
): TranscriptEntry[] {
  return rows
    .filter(
      (row) =>
        row.lineIndex >= selection.startLineIndex &&
        row.lineIndex <= selection.endLineIndex,
    )
    .map((row) => row.entry);
}

function selectReplayTranscriptRange(
  rows: ParsedTranscriptRow[],
  maxTurns: number,
): TranscriptSelection | null {
  if (rows.length === 0 || maxTurns <= 0) {
    return null;
  }

  const endRow = rows.findLast((row) => isEligibleCanonicalEntry(row.entry));
  if (!endRow || !isEligibleCanonicalEntry(endRow.entry)) {
    return null;
  }

  let usersSeen = 0;
  let startLineIndex = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) continue;
    if (row.lineIndex > endRow.lineIndex) continue;
    startLineIndex = row.lineIndex;
    if (row.entry.kind === "user") {
      usersSeen += 1;
      if (usersSeen >= maxTurns) {
        break;
      }
    }
  }

  const startRow = rows.find(
    (row) =>
      row.lineIndex >= startLineIndex &&
      row.lineIndex <= endRow.lineIndex &&
      isEligibleCanonicalEntry(row.entry),
  );
  if (!startRow || !isEligibleCanonicalEntry(startRow.entry)) {
    return null;
  }

  return {
    startLineIndex,
    endLineIndex: endRow.lineIndex,
    startMessageId: startRow.entry.source_message_id,
    endMessageId: endRow.entry.source_message_id,
  };
}

async function getTranscriptLastUpdatedAt(
  paths: ReflectionTranscriptPaths,
): Promise<string | undefined> {
  try {
    const info = await stat(paths.transcriptPath);
    return info.mtime.toISOString();
  } catch {
    return undefined;
  }
}

async function ensureAgentPayloadRoot(agentId: string): Promise<string> {
  const root = join(
    getAgentTranscriptRoot(agentId),
    "multi-reflection-payloads",
  );
  await mkdir(root, { recursive: true });
  return root;
}

const REFLECTION_DISCOVERY_QUERIES = [
  {
    id: "user-corrections",
    query:
      "user corrections and preferences repeated mistakes durable feedback",
  },
  {
    id: "coding-style",
    query: "coding style preferences review commit testing branch conventions",
  },
  {
    id: "collaboration",
    query:
      "collaboration communication style team preferences durable workflow",
  },
  {
    id: "repo-gotchas",
    query: "repo conventions project gotchas durable implementation details",
  },
  {
    id: "long-term-facts",
    query:
      "long term facts about people projects workflows memory worthy context",
  },
] as const;

const REFLECTION_DISCOVERY_RECENT_LIMIT = 20;
const REFLECTION_DISCOVERY_UNREFLECTED_LIMIT = 20;
const REFLECTION_DISCOVERY_SEARCH_LIMIT_PER_QUERY = 10;
const REFLECTION_DISCOVERY_MAX_CATALOG_CANDIDATES = 30;
export const REFLECTION_DISCOVERY_MAX_SELECTED_TRANSCRIPTS = 5;

function pageItems<T>(page: unknown): T[] {
  if (Array.isArray(page)) return page as T[];
  if (page && typeof page === "object") {
    const maybePage = page as {
      getPaginatedItems?: () => T[];
      items?: T[];
    };
    if (typeof maybePage.getPaginatedItems === "function") {
      return maybePage.getPaginatedItems();
    }
    if (Array.isArray(maybePage.items)) {
      return maybePage.items;
    }
  }
  return [];
}

function addSource(
  candidate: ReflectionDiscoveryCandidate,
  source: string,
): void {
  if (!candidate.sources.includes(source)) {
    candidate.sources.push(source);
  }
}

function recencyScore(lastUpdatedAt?: string): number {
  if (!lastUpdatedAt) return 0;
  const parsed = Date.parse(lastUpdatedAt);
  if (!Number.isFinite(parsed)) return 0;
  const ageMs = Date.now() - parsed;
  const dayMs = 24 * 60 * 60 * 1000;
  if (ageMs <= dayMs) return 8;
  if (ageMs <= 7 * dayMs) return 5;
  if (ageMs <= 30 * dayMs) return 2;
  return 0;
}

function scoreDiscoveryCandidate(
  candidate: ReflectionDiscoveryCandidate,
): number {
  const bestNormalizedSearch = Math.max(
    0,
    ...candidate.search_scores.map((score) => score.normalized_score),
  );
  const searchScore = 50 * bestNormalizedSearch;
  const turns = candidate.turns_since_last_successful_reflection;
  const unreflectedScore = turns > 0 ? 15 + Math.min(turns, 10) : 0;
  const sourceScore = Math.min(candidate.sources.length, 4);
  const sizeScore =
    candidate.total_completed_turns >= 3
      ? 4
      : candidate.total_completed_turns >= 1
        ? 1
        : 0;
  const currentConversationScore =
    candidate.is_current_conversation && turns > 0 ? 8 : 0;
  const alreadyReflectedPenalty =
    turns === 0 && candidate.search_scores.length === 0 ? 8 : 0;

  return (
    searchScore +
    unreflectedScore +
    recencyScore(candidate.last_updated_at) +
    sourceScore +
    sizeScore +
    currentConversationScore -
    alreadyReflectedPenalty
  );
}

export async function buildReflectionDiscoveryPayload(options: {
  agentId: string;
  currentConversationId?: string;
  maxSelected?: number;
  maxCatalogCandidates?: number;
}): Promise<ReflectionDiscoveryPayload | null> {
  const {
    agentId,
    currentConversationId,
    maxSelected = REFLECTION_DISCOVERY_MAX_SELECTED_TRANSCRIPTS,
    maxCatalogCandidates = REFLECTION_DISCOVERY_MAX_CATALOG_CANDIDATES,
  } = options;
  const transcriptCandidates =
    await listReflectionTranscriptCandidates(agentId);
  if (transcriptCandidates.length === 0) {
    return null;
  }

  const candidates = new Map<string, ReflectionDiscoveryCandidate>();
  const ensureCandidate = (conversationId: string) => {
    const existing = candidates.get(conversationId);
    if (existing) return existing;
    const transcriptCandidate = transcriptCandidates.find(
      (candidate) => candidate.conversationId === conversationId,
    );
    if (!transcriptCandidate) return null;
    const candidate: ReflectionDiscoveryCandidate = {
      conversation_id: conversationId,
      last_updated_at: transcriptCandidate.lastUpdatedAt,
      total_completed_turns: transcriptCandidate.totalCompletedTurns,
      reflected_completed_turns: transcriptCandidate.reflectedCompletedTurns,
      turns_since_last_successful_reflection:
        transcriptCandidate.turnsSinceLastSuccessfulReflection,
      has_unreflected_content:
        transcriptCandidate.turnsSinceLastSuccessfulReflection > 0,
      is_current_conversation: conversationId === currentConversationId,
      sources: [],
      search_scores: [],
      heuristic_score: 0,
    };
    candidates.set(conversationId, candidate);
    return candidate;
  };

  for (const candidate of transcriptCandidates.slice(
    0,
    REFLECTION_DISCOVERY_RECENT_LIMIT,
  )) {
    const discoveryCandidate = ensureCandidate(candidate.conversationId);
    if (discoveryCandidate) addSource(discoveryCandidate, "recent");
  }

  for (const candidate of transcriptCandidates
    .filter((item) => item.turnsSinceLastSuccessfulReflection > 0)
    .sort(
      (a, b) =>
        b.turnsSinceLastSuccessfulReflection -
          a.turnsSinceLastSuccessfulReflection ||
        Date.parse(b.lastUpdatedAt ?? "") - Date.parse(a.lastUpdatedAt ?? ""),
    )
    .slice(0, REFLECTION_DISCOVERY_UNREFLECTED_LIMIT)) {
    const discoveryCandidate = ensureCandidate(candidate.conversationId);
    if (discoveryCandidate) addSource(discoveryCandidate, "unreflected");
  }

  if (currentConversationId) {
    const discoveryCandidate = ensureCandidate(currentConversationId);
    if (discoveryCandidate) addSource(discoveryCandidate, "current");
  }

  const transcriptConversationIds = new Set(
    transcriptCandidates.map((candidate) => candidate.conversationId),
  );
  const conversationSummaries = new Map<string, string>();
  try {
    for (const conversation of pageItems<{
      id: string;
      summary?: string | null;
    }>(
      await getBackend().listConversations({
        agent_id: agentId,
        limit: 100,
        order: "desc",
        order_by: "last_message_at",
      } as never),
    )) {
      if (conversation.summary?.trim()) {
        conversationSummaries.set(conversation.id, conversation.summary.trim());
      }
    }
  } catch {
    // Summaries are helpful metadata but not required for discovery.
  }

  const searchResultsByQuery = await Promise.allSettled(
    REFLECTION_DISCOVERY_QUERIES.map(async ({ id, query }) => {
      const results = await searchConversationsForBackend({
        agent_id: agentId,
        query,
        search_mode: "hybrid",
        search_target: "description",
        limit: REFLECTION_DISCOVERY_SEARCH_LIMIT_PER_QUERY,
      });
      return { id, query, results };
    }),
  );

  for (const queryResult of searchResultsByQuery) {
    if (queryResult.status !== "fulfilled") continue;
    const { id, query, results } = queryResult.value;
    const eligibleResults = results.filter((result: ConversationSearchResult) =>
      transcriptConversationIds.has(result.conversation.id),
    );
    const bestRrfScore = Math.max(
      0,
      ...eligibleResults.map((result) => result.rrf_score),
    );
    for (const result of eligibleResults) {
      const discoveryCandidate = ensureCandidate(result.conversation.id);
      if (!discoveryCandidate) continue;
      addSource(discoveryCandidate, `search:${id}`);
      const summary = result.conversation.summary?.trim();
      if (summary) discoveryCandidate.summary = summary;
      const description = result.embedded_text.trim();
      if (description) discoveryCandidate.description = description;
      discoveryCandidate.search_scores.push({
        query,
        rrf_score: result.rrf_score,
        normalized_score:
          bestRrfScore > 0 ? result.rrf_score / bestRrfScore : 0,
      });
    }
  }

  for (const [conversationId, summary] of conversationSummaries) {
    const candidate = candidates.get(conversationId);
    if (candidate && !candidate.summary) {
      candidate.summary = summary;
    }
  }

  const sortedCandidates = Array.from(candidates.values())
    .map((candidate) => ({
      ...candidate,
      sources: [...candidate.sources].sort(),
      search_scores: [...candidate.search_scores].sort(
        (a, b) => b.normalized_score - a.normalized_score,
      ),
      heuristic_score: scoreDiscoveryCandidate(candidate),
    }))
    .sort(
      (a, b) =>
        b.heuristic_score - a.heuristic_score ||
        (b.last_updated_at ? Date.parse(b.last_updated_at) : 0) -
          (a.last_updated_at ? Date.parse(a.last_updated_at) : 0) ||
        a.conversation_id.localeCompare(b.conversation_id),
    )
    .slice(0, Math.max(1, maxCatalogCandidates));

  if (sortedCandidates.length === 0) {
    return null;
  }

  const payloadRoot = await ensureAgentPayloadRoot(agentId);
  const selectionOutputPath = buildPayloadPath(payloadRoot, "selected");
  const catalog: ReflectionDiscoveryCatalog = {
    schema_version: 1,
    type: "reflection_discovery_catalog",
    agent_id: agentId,
    current_conversation_id: currentConversationId,
    created_at: new Date().toISOString(),
    max_selected: maxSelected,
    selection_output_path: selectionOutputPath,
    instructions:
      "Choose conversations likely to contain durable memory updates. Prefer explicit corrections, repeated preferences, project conventions, and contradictions; avoid one-off debugging and transient task state.",
    candidates: sortedCandidates,
  };
  const catalogPath = buildPayloadPath(payloadRoot, "discover");
  await writeFile(
    catalogPath,
    `${JSON.stringify(catalog, null, 2)}\n`,
    "utf-8",
  );

  return { catalogPath, selectionOutputPath, catalog };
}

function isReflectionDiscoveryPriority(
  value: unknown,
): value is ReflectionDiscoveryPriority {
  return value === "high" || value === "medium" || value === "low";
}

export async function readReflectionDiscoverySelection(options: {
  selectionOutputPath: string;
  catalog: ReflectionDiscoveryCatalog;
}): Promise<ReflectionDiscoverySelectedConversation[]> {
  const raw = await readFile(options.selectionOutputPath, "utf-8");
  const parsed = safeJsonParseOr<unknown>(raw, null);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Reflection selector did not write valid JSON.");
  }
  const selected = (parsed as { selected_conversations?: unknown })
    .selected_conversations;
  if (!Array.isArray(selected)) {
    throw new Error(
      'Reflection selector JSON must include a "selected_conversations" array.',
    );
  }

  const allowedIds = new Set(
    options.catalog.candidates.map((candidate) => candidate.conversation_id),
  );
  const seenIds = new Set<string>();
  const validated: ReflectionDiscoverySelectedConversation[] = [];
  for (const item of selected) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const conversationId =
      typeof record.conversation_id === "string"
        ? record.conversation_id.trim()
        : "";
    if (!conversationId || seenIds.has(conversationId)) continue;
    if (!allowedIds.has(conversationId)) {
      throw new Error(
        `Reflection selector chose unknown conversation: ${conversationId}`,
      );
    }
    const reason =
      typeof record.reason === "string" && record.reason.trim()
        ? record.reason.trim()
        : "Selected by reflection discovery.";
    validated.push({
      conversation_id: conversationId,
      reason,
      ...(isReflectionDiscoveryPriority(record.priority)
        ? { priority: record.priority }
        : {}),
    });
    seenIds.add(conversationId);
    if (validated.length >= options.catalog.max_selected) {
      break;
    }
  }

  return validated;
}

export async function listReflectionTranscriptCandidates(
  agentId: string,
): Promise<ReflectionTranscriptCandidate[]> {
  const agentRoot = getAgentTranscriptRoot(agentId);
  let entries: Dirent[] = [];
  try {
    entries = await readdir(agentRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: ReflectionTranscriptCandidate[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "multi-reflection-payloads") {
      continue;
    }
    const conversationId = entry.name;
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    const lines = await readTranscriptLines(paths);
    if (lines.length === 0) {
      continue;
    }
    const rows = parseTranscriptRows(lines);
    if (!rows.some((row) => isEligibleCanonicalEntry(row.entry))) {
      continue;
    }
    const state = await readState(paths);
    candidates.push({
      conversationId,
      transcriptPath: paths.transcriptPath,
      statePath: paths.statePath,
      lastUpdatedAt: await getTranscriptLastUpdatedAt(paths),
      totalCompletedTurns: state.total_completed_turns,
      reflectedCompletedTurns: state.reflected_completed_turns,
      turnsSinceLastSuccessfulReflection:
        state.turns_since_last_successful_reflection,
    });
  }

  return candidates.sort((a, b) => {
    const aTime = a.lastUpdatedAt ? Date.parse(a.lastUpdatedAt) : 0;
    const bTime = b.lastUpdatedAt ? Date.parse(b.lastUpdatedAt) : 0;
    return bTime - aTime || a.conversationId.localeCompare(b.conversationId);
  });
}

export async function getReflectionTranscriptState(
  agentId: string,
  conversationId: string,
): Promise<ReflectionTranscriptState> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);
    return readState(paths);
  });
}

export async function buildAutoReflectionPayload(
  agentId: string,
  conversationId: string,
  systemPrompt?: string,
): Promise<AutoReflectionPayload | null> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);

    const lines = await readTranscriptLines(paths);
    const state = await readState(paths);
    const rows = parseTranscriptRows(lines);
    const selection = selectUnreflectedTranscriptRange(
      rows,
      state.reflected_through_message_id,
    );
    if (!selection) {
      return null;
    }

    const entries = entriesForSelection(rows, selection);
    const filteredSystemPrompt = systemPrompt
      ? filterSystemPromptForReflection(systemPrompt) || undefined
      : undefined;
    const transcript = formatTaggedTranscript(entries, filteredSystemPrompt);
    if (!transcript || transcript === "[]") {
      return null;
    }

    const payloadPath = buildPayloadPath(paths.rootDir, "auto");
    await writeFile(payloadPath, transcript, "utf-8");

    state.last_reflection_started_at = new Date().toISOString();
    await writeState(paths, state);

    return {
      payloadPath,
      startMessageId: selection.startMessageId,
      endMessageId: selection.endMessageId,
      endSnapshotLine: selection.endLineIndex + 1,
    };
  });
}

type MultiReflectionSelectionPolicy =
  | { mode: "recent"; limit: number }
  | { mode: "explicit-conversations"; conversationIds: string[] }
  | {
      mode: "discovered";
      selectedConversations: ReflectionDiscoverySelectedConversation[];
      catalogPath?: string;
    };

export interface BuildMultiReflectionPayloadOptions {
  agentId: string;
  selectionPolicy: MultiReflectionSelectionPolicy;
  systemPrompt?: string;
  maxReplayTurnsPerConversation?: number;
  maxTotalChars?: number;
}

async function resolveMultiReflectionConversationIds(
  agentId: string,
  selectionPolicy: MultiReflectionSelectionPolicy,
): Promise<string[]> {
  if (selectionPolicy.mode === "discovered") {
    return Array.from(
      new Set(
        selectionPolicy.selectedConversations.map(
          (selection) => selection.conversation_id,
        ),
      ),
    );
  }

  if (selectionPolicy.mode === "explicit-conversations") {
    return Array.from(new Set(selectionPolicy.conversationIds));
  }

  const candidates = await listReflectionTranscriptCandidates(agentId);
  return candidates
    .slice(0, Math.max(0, selectionPolicy.limit))
    .map((candidate) => candidate.conversationId);
}

function manifestSelectionPolicy(
  selectionPolicy: MultiReflectionSelectionPolicy,
): MultiReflectionManifest["selection_policy"] {
  if (selectionPolicy.mode === "recent") {
    return { mode: "recent", limit: selectionPolicy.limit };
  }
  if (selectionPolicy.mode === "discovered") {
    return {
      mode: "discovered",
      selected_conversations: selectionPolicy.selectedConversations,
      catalog_path: selectionPolicy.catalogPath,
    };
  }
  return {
    mode: "explicit-conversations",
    conversation_ids: selectionPolicy.conversationIds,
  };
}

function discoverySelectionByConversationId(
  selectionPolicy: MultiReflectionSelectionPolicy,
): Map<string, ReflectionDiscoverySelectedConversation> {
  if (selectionPolicy.mode !== "discovered") {
    return new Map();
  }

  return new Map(
    selectionPolicy.selectedConversations.map((selection) => [
      selection.conversation_id,
      selection,
    ]),
  );
}

export async function buildMultiReflectionPayload(
  options: BuildMultiReflectionPayloadOptions,
): Promise<MultiReflectionPayload | null> {
  const {
    agentId,
    selectionPolicy,
    systemPrompt,
    maxReplayTurnsPerConversation = 50,
    maxTotalChars = 150_000,
  } = options;
  const conversationIds = await resolveMultiReflectionConversationIds(
    agentId,
    selectionPolicy,
  );
  if (conversationIds.length === 0) {
    return null;
  }

  const payloadRoot = await ensureAgentPayloadRoot(agentId);
  const filteredSystemPrompt = systemPrompt
    ? filterSystemPromptForReflection(systemPrompt) || undefined
    : undefined;
  const transcripts: MultiReflectionTranscriptSlice[] = [];
  let totalChars = 0;
  let firstMessageId: string | undefined;
  let lastMessageId: string | undefined;
  const discoverySelections =
    discoverySelectionByConversationId(selectionPolicy);

  for (const conversationId of conversationIds) {
    const slice = await withStateLock(agentId, conversationId, async () => {
      const paths = getReflectionTranscriptPaths(agentId, conversationId);
      await ensurePaths(paths);
      const lines = await readTranscriptLines(paths);
      const rows = parseTranscriptRows(lines);
      const state = await readState(paths);
      const unreflectedSelection = selectUnreflectedTranscriptRange(
        rows,
        state.reflected_through_message_id,
      );
      const mode: ReflectionSliceMode = unreflectedSelection
        ? "unreflected"
        : "replay";
      const selection =
        unreflectedSelection ??
        selectReplayTranscriptRange(rows, maxReplayTurnsPerConversation);
      if (!selection) {
        return null;
      }

      const entries = entriesForSelection(rows, selection);
      const transcript = formatTaggedTranscript(entries, filteredSystemPrompt);
      if (!transcript || transcript === "[]") {
        return null;
      }
      const approxChars = transcript.length;
      if (transcripts.length > 0 && totalChars + approxChars > maxTotalChars) {
        return null;
      }

      const payloadPath = buildPayloadPath(payloadRoot, "slice");
      await writeFile(payloadPath, transcript, "utf-8");
      state.last_reflection_started_at = new Date().toISOString();
      await writeState(paths, state);

      return {
        conversation_id: conversationId,
        mode,
        payload_path: payloadPath,
        selection_reason: discoverySelections.get(conversationId)?.reason,
        selection_priority: discoverySelections.get(conversationId)?.priority,
        start_message_id: selection.startMessageId,
        end_message_id: selection.endMessageId,
        start_line: selection.startLineIndex,
        end_line: selection.endLineIndex,
        end_snapshot_line: selection.endLineIndex + 1,
        completed_turns: countUserRows(entries),
        approx_chars: approxChars,
        last_updated_at: await getTranscriptLastUpdatedAt(paths),
      } satisfies MultiReflectionTranscriptSlice;
    });

    if (!slice) {
      continue;
    }
    if (!firstMessageId) {
      firstMessageId = slice.start_message_id;
    }
    lastMessageId = slice.end_message_id;
    totalChars += slice.approx_chars;
    transcripts.push(slice);
  }

  if (transcripts.length === 0) {
    return null;
  }

  const manifest: MultiReflectionManifest = {
    schema_version: 1,
    type: "multi_transcript_reflection_payload",
    agent_id: agentId,
    created_at: new Date().toISOString(),
    selection_policy: manifestSelectionPolicy(selectionPolicy),
    transcripts,
  };
  const payloadPath = buildPayloadPath(payloadRoot, "multi");
  await writeFile(
    payloadPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf-8",
  );

  return {
    payloadPath,
    manifest,
    startMessageId: firstMessageId,
    endMessageId: lastMessageId,
  };
}

export async function finalizeAutoReflectionPayload(
  agentId: string,
  conversationId: string,
  _payloadPath: string,
  endSnapshotLine: number,
  success: boolean,
): Promise<void> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);

    const lines = await readTranscriptLines(paths);
    const state = await readState(paths);
    if (success) {
      const snapshotLines = lines.slice(0, Math.max(0, endSnapshotLine));
      const snapshotRows = parseTranscriptRows(snapshotLines);
      const selection = selectUnreflectedTranscriptRange(
        snapshotRows,
        state.reflected_through_message_id,
      );
      if (!selection) {
        await writeState(paths, state);
        return;
      }
      const nowIso = new Date().toISOString();
      state.reflected_through_message_id = selection.endMessageId;
      state.reflected_completed_turns = countUserRows(
        snapshotRows.map((row) => row.entry),
      );
      state.last_reflection_succeeded_at = nowIso;
    }
    await writeState(paths, state);
  });
}

export async function finalizeMultiReflectionPayload(
  agentId: string,
  manifest: MultiReflectionManifest,
  success: boolean,
): Promise<void> {
  if (!success) {
    return;
  }

  for (const slice of manifest.transcripts) {
    if (slice.mode !== "unreflected") {
      continue;
    }
    await finalizeAutoReflectionPayload(
      agentId,
      slice.conversation_id,
      slice.payload_path,
      slice.end_snapshot_line,
      true,
    );
  }
}
