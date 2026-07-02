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
const LEGACY_MESSAGE_ID_STATE_SCHEMA_VERSION = "v2_message_id";
export const REFLECTION_STATE_SCHEMA_VERSION = "v3_assistant_steps" as const;
const META_REFLECTION_COUNTER_SCHEMA_VERSION =
  "v1_meta_reflection_counter" as const;

export interface ReflectionTranscriptState {
  schema_version: typeof REFLECTION_STATE_SCHEMA_VERSION;
  reflected_through_message_id?: string;
  total_completed_steps: number;
  reflected_completed_steps: number;
  steps_since_last_successful_reflection: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

export interface MetaReflectionCounterState {
  schema_version: "v1_meta_reflection_counter";
  successful_reflections_since_last_meta_reflection: number;
  total_successful_reflections: number;
  total_successful_meta_reflections: number;
  last_successful_reflection_at?: string;
  last_meta_reflection_started_at?: string;
  last_meta_reflection_succeeded_at?: string;
}

interface LegacyMessageIdReflectionTranscriptState {
  schema_version: typeof LEGACY_MESSAGE_ID_STATE_SCHEMA_VERSION;
  reflected_through_message_id?: string;
  total_completed_turns?: number;
  reflected_completed_turns?: number;
  turns_since_last_successful_reflection?: number;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
}

type StoredReflectionTranscriptState =
  | Partial<ReflectionTranscriptState>
  | Partial<LegacyMessageIdReflectionTranscriptState>;

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
  selection_priority?: ReflectionAutoPriority;
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
  user_instruction?: string;
  selection_policy:
    | { mode: "recent"; limit: number }
    | { mode: "explicit-conversations"; conversation_ids: string[] }
    | {
        mode: "auto-selected";
        selected_conversations: ReflectionAutoSelectedConversation[];
        candidates_path?: string;
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

export type ReflectionAutoPriority = "high" | "medium" | "low";

export interface ReflectionAutoSelectedConversation {
  conversation_id: string;
  reason: string;
  priority?: ReflectionAutoPriority;
}

export interface ReflectionAutoSearchScore {
  query: string;
  rrf_score: number;
  normalized_score: number;
}

export interface ReflectionAutoCandidate {
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
  search_scores: ReflectionAutoSearchScore[];
  heuristic_score: number;
}

export interface ReflectionAutoCandidates {
  schema_version: 1;
  type: "auto_transcript_reflection_candidates";
  agent_id: string;
  current_conversation_id?: string;
  created_at: string;
  max_selected: number;
  user_instruction?: string;
  instructions: string;
  candidates: ReflectionAutoCandidate[];
}

export interface ReflectionAutoSelection {
  selected_conversations: ReflectionAutoSelectedConversation[];
}

export interface ReflectionAutoPayload {
  candidatesPath: string;
  candidates: ReflectionAutoCandidates;
}

export type ReflectionPromptMode = "standard" | "multi";

export interface ReflectionPromptInput {
  instruction?: string;
  memoryDir: string;
  parentMemory?: string;
  mode?: ReflectionPromptMode;
}

function buildReflectionPayloadInstructions(): string[] {
  return [
    "Review the conversation transcript payload and update memory files. The payload path is available as the `$TRANSCRIPT_PATH` env var — read it via Bash (e.g. `cat $TRANSCRIPT_PATH`). Note: `$TRANSCRIPT_PATH` only expands in shell commands; Edit/Read/Write `file_path` is literal and does NOT expand env vars.",
    "",
  ];
}

function buildMultiReflectionInstructions(): string[] {
  return [
    'The payload is a `multi_transcript_reflection_payload` manifest. Read each `payload_path` listed in `transcripts` and synthesize across all conversations. Entries with `mode: "replay"` were already reflected before and are included intentionally for re-review/deduplication; do not skip them',
    "Synthesize across conversations and prioritize durable, cross-conversation signal over one-off task state, especially patterns that recur across multiple conversations:",
    "- Memory failures: things the agent repeatedly forgets or fails to apply despite existing memory.",
    "- Repeated corrections and recurring agent failure modes across sessions.",
    "- Personalization opportunities: lasting user preferences, style, and workflow conventions.",
    "- Skill generation: ONLY for reusable, durable, multi-step workflows, especially ones seen across conversations.",
    "- Proactive cleanup and memory hygiene: resolve contradictions at the source, deduplicate, prune stale or too-verbose content, move memory to the right tier, split bulky files, and fix weak cross-references.",
    "Prefer fewer, higher-confidence updates. Low-signal transcripts can support deduplication or contradiction resolution, but should not create durable memory by themselves.",
    "",
  ];
}

function buildReflectionMemoryFilesystemInstructions(memoryDir: string): string[] {
  return [
    `The primary agent's memory filesystem is located at: ${memoryDir}`,
    "In-context memory (in the parent agent's system prompt) is stored in the `system/` folder and are rendered in <memory> tags below. Modification to files in `system/` will edit the parent agent's system prompt.",
    "Additional memory files (such as skills and external memory) may also be read and modified.",
    "",
  ];
}

function buildReflectionUserInstruction(input: ReflectionPromptInput): string[] {
  if (!input.instruction?.trim()) {
    return [];
  }

  return [
    "Additional user-provided reflection instruction:",
    input.instruction.trim(),
    "",
    "Use this instruction to focus what you look for, but still only persist durable memory-worthy learnings and do not store transient task state.",
    "",
  ];
}

export function buildReflectionSubagentPrompt(
  input: ReflectionPromptInput,
): string {
  const lines: string[] = [
    ...buildReflectionPayloadInstructions(),
    ...(input.mode === "multi" ? buildMultiReflectionInstructions() : []),
    ...buildReflectionMemoryFilesystemInstructions(input.memoryDir),
    ...buildReflectionUserInstruction(input),
  ];

  if (input.parentMemory) {
    lines.push(input.parentMemory);
  }
  return lines.join("\n");
}

export function buildReflectionSelectorPrompt(options?: {
  instruction?: string;
}): string {
  const lines = [
    "You are selecting conversation transcripts for memory reflection. The transcript candidates path is available as the `$TRANSCRIPT_PATH` env var — read it via Bash (e.g. `cat $TRANSCRIPT_PATH`). Note: `$TRANSCRIPT_PATH` only expands in shell commands; Read/Edit file_path is literal and does NOT expand env vars.",
    "",
    "The payload is `auto_transcript_reflection_candidates` with compact metadata about candidate conversations. Your job is only to choose which conversations should be opened for a full reflection pass. Do not edit memory files. Do not commit anything.",
    "",
  ];

  if (options?.instruction?.trim()) {
    lines.push(
      "Additional user-provided reflection instruction:",
      options.instruction.trim(),
      "",
      "Prefer transcript candidates that help satisfy this instruction, while still avoiding transient or low-signal conversations.",
      "",
    );
  }

  lines.push(
    "If the candidates payload includes `user_instruction`, use it as the requested focus for selection.",
    "",
    "Select up to `max_selected` conversations. Prefer candidates likely to contain durable memory updates: explicit user corrections, repeated preferences, coding/review/commit style preferences, repo or workflow gotchas, durable facts about people/projects, contradictions with current memory, or repeated agent failures.",
    "Avoid one-off debugging, transient task status, duplicated/redundant candidates, and conversations already fully reflected unless they are useful for deduplication or contradiction resolution.",
    "Treat summaries/descriptions as weak internal metadata, not confirmed facts. The final reflection pass will verify against the actual transcript before writing memory.",
    "",
    "Return strict JSON as your final response with this shape:",
    '{"selected_conversations":[{"conversation_id":"conv-...","reason":"durable reason for selecting this transcript","priority":"high"}]}',
    'Use priority values `high`, `medium`, or `low`. If nothing looks memory-worthy, write `{"selected_conversations":[]}`.',
  );

  return lines.join("\n");
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

function countAssistantRows(entries: TranscriptEntry[]): number {
  return entries.filter((entry) => entry.kind === "assistant").length;
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

function normalizeV3State(
  parsed: Partial<ReflectionTranscriptState>,
): ReflectionTranscriptState {
  const totalCompletedSteps = normalizeNonNegativeInteger(
    parsed.total_completed_steps,
  );
  const reflectedCompletedSteps = Math.min(
    normalizeNonNegativeInteger(parsed.reflected_completed_steps),
    totalCompletedSteps,
  );
  const stepsSinceLastSuccessfulReflection = Math.max(
    0,
    totalCompletedSteps - reflectedCompletedSteps,
  );

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id: normalizeString(
      parsed.reflected_through_message_id,
    ),
    total_completed_steps: totalCompletedSteps,
    reflected_completed_steps: reflectedCompletedSteps,
    steps_since_last_successful_reflection: stepsSinceLastSuccessfulReflection,
    last_reflection_started_at: normalizeString(
      parsed.last_reflection_started_at,
    ),
    last_reflection_succeeded_at: normalizeString(
      parsed.last_reflection_succeeded_at,
    ),
  };
}

function countAssistantRowsThroughMessageId(
  rows: ParsedTranscriptRow[],
  reflectedThroughMessageId?: string,
): number {
  if (!reflectedThroughMessageId) {
    return 0;
  }
  const anchorRow = rows.find(
    (row) =>
      isEligibleCanonicalEntry(row.entry) &&
      row.entry.source_message_id === reflectedThroughMessageId,
  );
  if (!anchorRow) {
    return 0;
  }
  return countAssistantRows(
    rows
      .filter((row) => row.lineIndex <= anchorRow.lineIndex)
      .map((row) => row.entry),
  );
}

function migrateMessageIdState(
  parsed: Partial<LegacyMessageIdReflectionTranscriptState>,
  lines: string[],
): ReflectionTranscriptState {
  const rows = parseTranscriptRows(lines);
  const allEntries = rows.map((row) => row.entry);
  const totalCompletedSteps = countAssistantRows(allEntries);
  const reflectedThroughMessageId = normalizeString(
    parsed.reflected_through_message_id,
  );
  const reflectedCompletedSteps = Math.min(
    countAssistantRowsThroughMessageId(rows, reflectedThroughMessageId),
    totalCompletedSteps,
  );

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id: reflectedThroughMessageId,
    total_completed_steps: totalCompletedSteps,
    reflected_completed_steps: reflectedCompletedSteps,
    steps_since_last_successful_reflection: Math.max(
      0,
      totalCompletedSteps - reflectedCompletedSteps,
    ),
    last_reflection_started_at: normalizeString(
      parsed.last_reflection_started_at,
    ),
    last_reflection_succeeded_at: normalizeString(
      parsed.last_reflection_succeeded_at,
    ),
  };
}

function buildUnreflectedStateFromTranscript(
  lines: string[],
): ReflectionTranscriptState {
  const rows = parseTranscriptRows(lines);
  const allEntries = rows.map((row) => row.entry);
  const totalCompletedSteps = countAssistantRows(allEntries);

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_completed_steps: totalCompletedSteps,
    reflected_completed_steps: 0,
    steps_since_last_successful_reflection: totalCompletedSteps,
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
    ? safeJsonParseOr<StoredReflectionTranscriptState | null>(raw, null)
    : null;
  const schemaVersion =
    parsed && "schema_version" in parsed ? parsed.schema_version : undefined;

  if (schemaVersion === REFLECTION_STATE_SCHEMA_VERSION) {
    const state = normalizeV3State(
      parsed as Partial<ReflectionTranscriptState>,
    );
    if (JSON.stringify(state) !== JSON.stringify(parsed)) {
      await writeState(paths, state);
    }
    return state;
  }

  const transcriptLines = await readTranscriptLines(paths);

  if (!parsed) {
    const state = buildUnreflectedStateFromTranscript(transcriptLines);
    await writeState(paths, state);
    return state;
  }

  const migrated =
    schemaVersion === LEGACY_MESSAGE_ID_STATE_SCHEMA_VERSION
      ? migrateMessageIdState(
          parsed as Partial<LegacyMessageIdReflectionTranscriptState>,
          transcriptLines,
        )
      : buildUnreflectedStateFromTranscript(transcriptLines);
  await writeState(paths, migrated);
  return migrated;
}

async function writeState(
  paths: ReflectionTranscriptPaths,
  state: ReflectionTranscriptState,
): Promise<void> {
  state.steps_since_last_successful_reflection = Math.max(
    0,
    state.total_completed_steps - state.reflected_completed_steps,
  );
  await writeFile(
    paths.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

function buildPayloadPath(
  rootDir: string,
  kind: "auto" | "candidates" | "multi" | "remember" | "slice",
): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(rootDir, `payload-${kind}-${nonce}.json`);
}

function getAgentTranscriptRoot(agentId: string): string {
  return join(getTranscriptRoot(), sanitizePathSegment(agentId));
}

function getMetaReflectionCounterStatePath(agentId: string): string {
  return join(getAgentTranscriptRoot(agentId), "meta-reflection-state.json");
}

function getMetaReflectionCounterLockPath(agentId: string): string {
  return join(getAgentTranscriptRoot(agentId), "meta-reflection-state.lock");
}

function normalizeMetaReflectionCounterState(
  parsed: Partial<MetaReflectionCounterState> | null,
): MetaReflectionCounterState {
  return {
    schema_version: META_REFLECTION_COUNTER_SCHEMA_VERSION,
    successful_reflections_since_last_meta_reflection:
      normalizeNonNegativeInteger(
        parsed?.successful_reflections_since_last_meta_reflection,
      ),
    total_successful_reflections: normalizeNonNegativeInteger(
      parsed?.total_successful_reflections,
    ),
    total_successful_meta_reflections: normalizeNonNegativeInteger(
      parsed?.total_successful_meta_reflections,
    ),
    last_successful_reflection_at: normalizeString(
      parsed?.last_successful_reflection_at,
    ),
    last_meta_reflection_started_at: normalizeString(
      parsed?.last_meta_reflection_started_at,
    ),
    last_meta_reflection_succeeded_at: normalizeString(
      parsed?.last_meta_reflection_succeeded_at,
    ),
  };
}

async function withMetaReflectionCounterLock<T>(
  agentId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await mkdir(getAgentTranscriptRoot(agentId), { recursive: true });
  return withFileLock(getMetaReflectionCounterLockPath(agentId), fn);
}

async function readMetaReflectionCounterStateUnlocked(
  agentId: string,
): Promise<MetaReflectionCounterState> {
  let raw: string | null = null;
  try {
    raw = await readFile(getMetaReflectionCounterStatePath(agentId), "utf-8");
  } catch {
    raw = null;
  }
  const parsed = raw
    ? safeJsonParseOr<Partial<MetaReflectionCounterState> | null>(raw, null)
    : null;
  return normalizeMetaReflectionCounterState(parsed);
}

async function writeMetaReflectionCounterStateUnlocked(
  agentId: string,
  state: MetaReflectionCounterState,
): Promise<void> {
  await writeFile(
    getMetaReflectionCounterStatePath(agentId),
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
}

export async function recordSuccessfulReflectionForMetaTrigger(
  agentId: string,
  options: { interval?: number } = {},
): Promise<{
  shouldLaunchMetaReflection: boolean;
  state: MetaReflectionCounterState;
}> {
  const interval = Math.max(1, options.interval ?? 10);
  return withMetaReflectionCounterLock(agentId, async () => {
    const state = await readMetaReflectionCounterStateUnlocked(agentId);
    const nowIso = new Date().toISOString();
    state.total_successful_reflections += 1;
    state.successful_reflections_since_last_meta_reflection += 1;
    state.last_successful_reflection_at = nowIso;

    const shouldLaunchMetaReflection =
      state.successful_reflections_since_last_meta_reflection >= interval;
    if (shouldLaunchMetaReflection) {
      state.successful_reflections_since_last_meta_reflection = 0;
      state.last_meta_reflection_started_at = nowIso;
    }

    await writeMetaReflectionCounterStateUnlocked(agentId, state);
    return { shouldLaunchMetaReflection, state };
  });
}

export async function recordMetaReflectionResult(
  agentId: string,
  success: boolean,
): Promise<MetaReflectionCounterState> {
  return withMetaReflectionCounterLock(agentId, async () => {
    const state = await readMetaReflectionCounterStateUnlocked(agentId);
    if (success) {
      state.total_successful_meta_reflections += 1;
      state.last_meta_reflection_succeeded_at = new Date().toISOString();
    }
    await writeMetaReflectionCounterStateUnlocked(agentId, state);
    return state;
  });
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
    state.total_completed_steps += countAssistantRows(entries);
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

const REFLECTION_AUTO_QUERIES = [
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

const REFLECTION_AUTO_RECENT_LIMIT = 20;
const REFLECTION_AUTO_UNREFLECTED_LIMIT = 20;
const REFLECTION_AUTO_SEARCH_LIMIT_PER_QUERY = 10;
const REFLECTION_AUTO_MAX_CATALOG_CANDIDATES = 30;
export const REFLECTION_AUTO_MAX_SELECTED_TRANSCRIPTS = 5;

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

function addSource(candidate: ReflectionAutoCandidate, source: string): void {
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

function scoreAutoCandidate(candidate: ReflectionAutoCandidate): number {
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

function hasSearchHit(candidate: ReflectionAutoCandidate): boolean {
  return candidate.search_scores.length > 0;
}

function hasSummary(candidate: ReflectionAutoCandidate): boolean {
  return Boolean(candidate.summary?.trim());
}

function shouldKeepAutoCandidate(candidate: ReflectionAutoCandidate): boolean {
  if (candidate.is_current_conversation) {
    return candidate.has_unreflected_content || hasSearchHit(candidate);
  }

  if (!candidate.has_unreflected_content && !hasSearchHit(candidate)) {
    return false;
  }

  if (
    candidate.turns_since_last_successful_reflection <= 1 &&
    candidate.total_completed_turns < 3 &&
    !hasSearchHit(candidate) &&
    !hasSummary(candidate)
  ) {
    return false;
  }

  return true;
}

export async function buildReflectionAutoPayload(options: {
  agentId: string;
  currentConversationId?: string;
  instruction?: string;
  maxSelected?: number;
  maxCatalogCandidates?: number;
}): Promise<ReflectionAutoPayload | null> {
  const {
    agentId,
    currentConversationId,
    instruction,
    maxSelected = REFLECTION_AUTO_MAX_SELECTED_TRANSCRIPTS,
    maxCatalogCandidates = REFLECTION_AUTO_MAX_CATALOG_CANDIDATES,
  } = options;
  const transcriptCandidates =
    await listReflectionTranscriptCandidates(agentId);
  if (transcriptCandidates.length === 0) {
    return null;
  }

  const candidates = new Map<string, ReflectionAutoCandidate>();
  const ensureCandidate = (conversationId: string) => {
    const existing = candidates.get(conversationId);
    if (existing) return existing;
    const transcriptCandidate = transcriptCandidates.find(
      (candidate) => candidate.conversationId === conversationId,
    );
    if (!transcriptCandidate) return null;
    const candidate: ReflectionAutoCandidate = {
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
    REFLECTION_AUTO_RECENT_LIMIT,
  )) {
    const autoCandidate = ensureCandidate(candidate.conversationId);
    if (autoCandidate) addSource(autoCandidate, "recent");
  }

  for (const candidate of transcriptCandidates
    .filter((item) => item.turnsSinceLastSuccessfulReflection > 0)
    .sort(
      (a, b) =>
        b.turnsSinceLastSuccessfulReflection -
          a.turnsSinceLastSuccessfulReflection ||
        Date.parse(b.lastUpdatedAt ?? "") - Date.parse(a.lastUpdatedAt ?? ""),
    )
    .slice(0, REFLECTION_AUTO_UNREFLECTED_LIMIT)) {
    const autoCandidate = ensureCandidate(candidate.conversationId);
    if (autoCandidate) addSource(autoCandidate, "unreflected");
  }

  if (currentConversationId) {
    const autoCandidate = ensureCandidate(currentConversationId);
    if (autoCandidate) addSource(autoCandidate, "current");
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
    // Summaries are helpful metadata but not required for auto selection.
  }

  const searchResultsByQuery = await Promise.allSettled(
    REFLECTION_AUTO_QUERIES.map(async ({ id, query }) => {
      const results = await searchConversationsForBackend({
        agent_id: agentId,
        query,
        search_mode: "hybrid",
        search_target: "description",
        limit: REFLECTION_AUTO_SEARCH_LIMIT_PER_QUERY,
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
      const autoCandidate = ensureCandidate(result.conversation.id);
      if (!autoCandidate) continue;
      addSource(autoCandidate, `search:${id}`);
      const summary = result.conversation.summary?.trim();
      if (summary) autoCandidate.summary = summary;
      const description = result.embedded_text.trim();
      if (description) autoCandidate.description = description;
      autoCandidate.search_scores.push({
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
    .filter(shouldKeepAutoCandidate)
    .map((candidate) => ({
      ...candidate,
      sources: [...candidate.sources].sort(),
      search_scores: [...candidate.search_scores].sort(
        (a, b) => b.normalized_score - a.normalized_score,
      ),
      heuristic_score: scoreAutoCandidate(candidate),
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
  const candidateSet: ReflectionAutoCandidates = {
    schema_version: 1,
    type: "auto_transcript_reflection_candidates",
    agent_id: agentId,
    current_conversation_id: currentConversationId,
    created_at: new Date().toISOString(),
    max_selected: maxSelected,
    user_instruction: instruction?.trim() || undefined,
    instructions:
      "Choose conversations likely to contain durable memory updates. Prefer explicit corrections, repeated preferences, project conventions, and contradictions; avoid one-off debugging and transient task state.",
    candidates: sortedCandidates,
  };
  const candidatesPath = buildPayloadPath(payloadRoot, "candidates");
  await writeFile(
    candidatesPath,
    `${JSON.stringify(candidateSet, null, 2)}\n`,
    "utf-8",
  );

  return { candidatesPath, candidates: candidateSet };
}

function isReflectionAutoPriority(
  value: unknown,
): value is ReflectionAutoPriority {
  return value === "high" || value === "medium" || value === "low";
}

export async function readReflectionAutoSelection(options: {
  selectionOutputPath?: string;
  selectionReport?: string;
  candidates: ReflectionAutoCandidates;
}): Promise<ReflectionAutoSelectedConversation[]> {
  const raw =
    options.selectionReport ??
    (options.selectionOutputPath
      ? await readFile(options.selectionOutputPath, "utf-8")
      : "");
  const parsed = parseReflectionAutoSelectionJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Reflection selector did not return valid JSON.");
  }
  const selected = (parsed as { selected_conversations?: unknown })
    .selected_conversations;
  if (!Array.isArray(selected)) {
    throw new Error(
      'Reflection selector JSON must include a "selected_conversations" array.',
    );
  }

  const allowedIds = new Set(
    options.candidates.candidates.map((candidate) => candidate.conversation_id),
  );
  const seenIds = new Set<string>();
  const validated: ReflectionAutoSelectedConversation[] = [];
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
        : "Selected by automatic reflection.";
    validated.push({
      conversation_id: conversationId,
      reason,
      ...(isReflectionAutoPriority(record.priority)
        ? { priority: record.priority }
        : {}),
    });
    seenIds.add(conversationId);
    if (validated.length >= options.candidates.max_selected) {
      break;
    }
  }

  return validated;
}

function parseReflectionAutoSelectionJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const direct = safeJsonParseOr<unknown>(trimmed, null);
  if (direct) return direct;

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  if (fenced) {
    const parsed = safeJsonParseOr<unknown>(fenced, null);
    if (parsed) return parsed;
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return safeJsonParseOr<unknown>(trimmed.slice(start, end + 1), null);
  }

  return null;
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
      totalCompletedTurns: state.total_completed_steps,
      reflectedCompletedTurns: state.reflected_completed_steps,
      turnsSinceLastSuccessfulReflection:
        state.steps_since_last_successful_reflection,
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
      mode: "auto-selected";
      selectedConversations: ReflectionAutoSelectedConversation[];
      candidatesPath?: string;
    };

export type MultiReflectionRangeMode = "unreflected-first" | "replay";

export interface BuildMultiReflectionPayloadOptions {
  agentId: string;
  instruction?: string;
  selectionPolicy: MultiReflectionSelectionPolicy;
  systemPrompt?: string;
  maxReplayTurnsPerConversation?: number;
  maxTotalChars?: number;
  rangeMode?: MultiReflectionRangeMode;
}

async function resolveMultiReflectionConversationIds(
  agentId: string,
  selectionPolicy: MultiReflectionSelectionPolicy,
): Promise<string[]> {
  if (selectionPolicy.mode === "auto-selected") {
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
  if (selectionPolicy.mode === "auto-selected") {
    return {
      mode: "auto-selected",
      selected_conversations: selectionPolicy.selectedConversations,
      candidates_path: selectionPolicy.candidatesPath,
    };
  }
  return {
    mode: "explicit-conversations",
    conversation_ids: selectionPolicy.conversationIds,
  };
}

function autoSelectionByConversationId(
  selectionPolicy: MultiReflectionSelectionPolicy,
): Map<string, ReflectionAutoSelectedConversation> {
  if (selectionPolicy.mode !== "auto-selected") {
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
    instruction,
    selectionPolicy,
    systemPrompt,
    maxReplayTurnsPerConversation = 50,
    maxTotalChars = 150_000,
    rangeMode = "unreflected-first",
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
  const autoSelections = autoSelectionByConversationId(selectionPolicy);

  for (const conversationId of conversationIds) {
    const slice = await withStateLock(agentId, conversationId, async () => {
      const paths = getReflectionTranscriptPaths(agentId, conversationId);
      await ensurePaths(paths);
      const lines = await readTranscriptLines(paths);
      const rows = parseTranscriptRows(lines);
      const state = await readState(paths);
      const replaySelection = selectReplayTranscriptRange(
        rows,
        maxReplayTurnsPerConversation,
      );
      const unreflectedSelection =
        rangeMode === "unreflected-first"
          ? selectUnreflectedTranscriptRange(
              rows,
              state.reflected_through_message_id,
            )
          : null;
      const mode: ReflectionSliceMode = unreflectedSelection
        ? "unreflected"
        : "replay";
      const selection = unreflectedSelection ?? replaySelection;
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
        selection_reason: autoSelections.get(conversationId)?.reason,
        selection_priority: autoSelections.get(conversationId)?.priority,
        start_message_id: selection.startMessageId,
        end_message_id: selection.endMessageId,
        start_line: selection.startLineIndex,
        end_line: selection.endLineIndex,
        end_snapshot_line: selection.endLineIndex + 1,
        completed_turns: countAssistantRows(entries),
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
    user_instruction: instruction?.trim() || undefined,
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
      state.reflected_completed_steps = countAssistantRows(
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
