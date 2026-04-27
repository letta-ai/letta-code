import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { MEMORY_SYSTEM_DIR } from "../../agent/memoryFilesystem";
import { getDirectoryLimits } from "../../utils/directoryLimits";
import { withFileLock } from "../../utils/fileLock";
import { parseFrontmatter } from "../../utils/frontmatter";
import type { Line } from "./accumulator";
import { safeJsonParseOr } from "./safeJsonParse";

const TRANSCRIPT_ROOT_ENV = "LETTA_TRANSCRIPT_ROOT";
const DEFAULT_TRANSCRIPT_DIR = "transcripts";
export const REFLECTION_STATE_SCHEMA_VERSION = "v2_message_id" as const;

export type ReflectionSource =
  | "manual"
  | "step-count"
  | "compaction-event"
  | "idle-time";

export interface ReflectionHistoryEntry {
  source: ReflectionSource;
  start_message_id: string;
  end_message_id: string;
  succeeded_at: string;
}

export interface ReflectionTranscriptState {
  schema_version: typeof REFLECTION_STATE_SCHEMA_VERSION;
  reflected_through_message_id?: string;
  total_completed_turns: number;
  reflected_completed_turns: number;
  turns_since_last_successful_reflection: number;
  transcript_line_count: number;
  last_transcript_appended_at?: string;
  last_reflection_started_at?: string;
  last_reflection_succeeded_at?: string;
  last_reflection_source?: ReflectionSource;
  last_reflection?: ReflectionHistoryEntry;
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

export interface ReflectionTranscriptDerivedState {
  state: ReflectionTranscriptState;
  hasUnreflectedMessages: boolean;
  unreflectedCompletedTurns: number;
}

export interface ReflectionPromptInput {
  transcriptPath: string;
  memoryDir: string;
  cwd?: string;
  parentMemory?: string;
}

export function buildReflectionSubagentPrompt(
  input: ReflectionPromptInput,
): string {
  const lines: string[] = [];

  if (input.cwd) {
    lines.push(`Your current working directory is: ${input.cwd}`);
    lines.push("");
  }

  lines.push(
    `Review the conversation transcript and update memory files. The current conversation transcript has been saved to: ${input.transcriptPath}`,
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

interface ParentMemoryFile {
  relativePath: string;
  content: string;
  description?: string;
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

export async function buildParentMemorySnapshot(
  memoryDir: string,
): Promise<string> {
  const files = await collectParentMemoryFiles(memoryDir);
  const tree = buildParentMemoryTree(files);
  const systemFiles = files.filter((file) =>
    isSystemMemoryFile(file.relativePath),
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
    for (const file of systemFiles) {
      const normalizedPath = file.relativePath.replace(/\\/g, "/");
      const absolutePath = `${memoryDir.replace(/\\/g, "/")}/${normalizedPath}`;
      lines.push("<memory>");
      lines.push(`<path>${absolutePath}</path>`);
      lines.push(file.content);
      lines.push("</memory>");
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

function defaultState(lineCount = 0): ReflectionTranscriptState {
  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    total_completed_turns: 0,
    reflected_completed_turns: 0,
    turns_since_last_successful_reflection: 0,
    transcript_line_count: lineCount,
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

function normalizeReflectionSource(
  value: unknown,
): ReflectionSource | undefined {
  return value === "step-count" ||
    value === "compaction-event" ||
    value === "idle-time" ||
    value === "manual"
    ? value
    : undefined;
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
  const lastReflectionSource = normalizeReflectionSource(
    parsed.last_reflection?.source,
  );
  const lastReflectionStartMessageId = normalizeString(
    parsed.last_reflection?.start_message_id,
  );
  const lastReflectionEndMessageId = normalizeString(
    parsed.last_reflection?.end_message_id,
  );
  const lastReflectionSucceededAt = normalizeString(
    parsed.last_reflection?.succeeded_at,
  );
  const lastReflection =
    lastReflectionSource &&
    lastReflectionStartMessageId &&
    lastReflectionEndMessageId &&
    lastReflectionSucceededAt
      ? {
          source: lastReflectionSource,
          start_message_id: lastReflectionStartMessageId,
          end_message_id: lastReflectionEndMessageId,
          succeeded_at: lastReflectionSucceededAt,
        }
      : undefined;

  return {
    schema_version: REFLECTION_STATE_SCHEMA_VERSION,
    reflected_through_message_id: normalizeString(
      parsed.reflected_through_message_id,
    ),
    total_completed_turns: totalCompletedTurns,
    reflected_completed_turns: reflectedCompletedTurns,
    turns_since_last_successful_reflection: turnsSinceLastSuccessfulReflection,
    transcript_line_count: normalizeNonNegativeInteger(
      parsed.transcript_line_count,
    ),
    last_transcript_appended_at: normalizeString(
      parsed.last_transcript_appended_at,
    ),
    last_reflection_started_at: normalizeString(
      parsed.last_reflection_started_at,
    ),
    last_reflection_succeeded_at: normalizeString(
      parsed.last_reflection_succeeded_at,
    ),
    last_reflection_source: normalizeReflectionSource(
      parsed.last_reflection_source,
    ),
    last_reflection: lastReflection,
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
    transcript_line_count: lines.length,
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

  const transcriptLines = await readTranscriptLines(paths);
  if (!parsed) {
    const state = defaultState(transcriptLines.length);
    await writeState(paths, state);
    return state;
  }
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

function buildPayloadPath(rootDir: string, kind: "auto" | "remember"): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(rootDir, `payload-${kind}-${nonce}.json`);
}

export function getReflectionTranscriptPaths(
  agentId: string,
  conversationId: string,
): ReflectionTranscriptPaths {
  const rootDir = join(
    getReflectionTranscriptAgentRoot(agentId),
    sanitizePathSegment(conversationId),
  );
  return {
    rootDir,
    transcriptPath: join(rootDir, "transcript.jsonl"),
    statePath: join(rootDir, "state.json"),
  };
}

export function getReflectionTranscriptAgentRoot(agentId: string): string {
  return join(getTranscriptRoot(), sanitizePathSegment(agentId));
}

export async function listReflectionTranscriptConversationIds(
  agentId: string,
): Promise<string[]> {
  try {
    const entries = await readdir(getReflectionTranscriptAgentRoot(agentId), {
      withFileTypes: true,
    });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => name.length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
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
    state.transcript_line_count += entries.length;
    state.total_completed_turns += countUserRows(entries);
    state.last_transcript_appended_at = new Date().toISOString();
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
      : rows.findLast(
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
    startLineIndex: startRow.lineIndex,
    endLineIndex: endRow.lineIndex,
    startMessageId: startRow.entry.source_message_id,
    endMessageId: endRow.entry.source_message_id,
  };
}

function buildDerivedState(
  state: ReflectionTranscriptState,
  rows: ParsedTranscriptRow[],
): ReflectionTranscriptDerivedState {
  return {
    state,
    hasUnreflectedMessages:
      selectUnreflectedTranscriptRange(
        rows,
        state.reflected_through_message_id,
      ) !== null,
    unreflectedCompletedTurns: Math.max(
      0,
      state.total_completed_turns - state.reflected_completed_turns,
    ),
  };
}

export async function getReflectionTranscriptState(
  agentId: string,
  conversationId: string,
): Promise<ReflectionTranscriptState> {
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);
  return readState(paths);
}

export async function getReflectionTranscriptDerivedState(
  agentId: string,
  conversationId: string,
): Promise<ReflectionTranscriptDerivedState> {
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);
  const lines = await readTranscriptLines(paths);
  const state = await readState(paths);
  return buildDerivedState(state, parseTranscriptRows(lines));
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

    const entries = rows
      .filter(
        (row) =>
          row.lineIndex >= selection.startLineIndex &&
          row.lineIndex <= selection.endLineIndex,
      )
      .map((row) => row.entry);
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
    state.transcript_line_count = lines.length;
    await writeState(paths, state);

    return {
      payloadPath,
      startMessageId: selection.startMessageId,
      endMessageId: selection.endMessageId,
      endSnapshotLine: selection.endLineIndex + 1,
    };
  });
}

export async function finalizeAutoReflectionPayload(
  agentId: string,
  conversationId: string,
  _payloadPath: string,
  endSnapshotLine: number,
  success: boolean,
  triggerSource: ReflectionSource = "step-count",
): Promise<void> {
  return withStateLock(agentId, conversationId, async () => {
    const paths = getReflectionTranscriptPaths(agentId, conversationId);
    await ensurePaths(paths);

    const lines = await readTranscriptLines(paths);
    const state = await readState(paths);
    state.transcript_line_count = lines.length;
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
      state.last_reflection_source = triggerSource;
      state.last_reflection = {
        source: triggerSource,
        start_message_id: selection.startMessageId,
        end_message_id: selection.endMessageId,
        succeeded_at: nowIso,
      };
    }
    await writeState(paths, state);
  });
}
