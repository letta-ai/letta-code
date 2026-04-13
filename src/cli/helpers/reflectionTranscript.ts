import type { Dirent } from "node:fs";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_SYSTEM_DIR } from "../../agent/memoryFilesystem";
import { getDirectoryLimits } from "../../utils/directoryLimits";
import { parseFrontmatter } from "../../utils/frontmatter";
import type { Line } from "./accumulator";

const TRANSCRIPT_ROOT_ENV = "LETTA_TRANSCRIPT_ROOT";
const DEFAULT_TRANSCRIPT_DIR = "transcripts";

interface ReflectionTranscriptState {
  auto_cursor_line: number;
  last_auto_reflection_started_at?: string;
  last_auto_reflection_succeeded_at?: string;
}

type TranscriptEntry =
  | {
      kind: "user" | "assistant" | "reasoning" | "error";
      text: string;
      captured_at: string;
      source_line_id?: string;
    }
  | {
      kind: "tool_call";
      name?: string;
      argsText?: string;
      resultText?: string;
      resultOk?: boolean;
      captured_at: string;
      source_line_id?: string;
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

function defaultState(): ReflectionTranscriptState {
  return { auto_cursor_line: 0 };
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
      };
    case "assistant":
      return {
        kind: "assistant",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
      };
    case "reasoning":
      return {
        kind: "reasoning",
        text: line.text,
        captured_at: capturedAt,
        source_line_id: line.id,
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

function parseJsonLine<T>(line: string): T | null {
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

async function ensurePaths(paths: ReflectionTranscriptPaths): Promise<void> {
  await mkdir(paths.rootDir, { recursive: true });
  await writeFile(paths.transcriptPath, "", { encoding: "utf-8", flag: "a" });
}

async function readState(
  paths: ReflectionTranscriptPaths,
): Promise<ReflectionTranscriptState> {
  try {
    const raw = await readFile(paths.statePath, "utf-8");
    const parsed = parseJsonLine<Partial<ReflectionTranscriptState>>(raw);
    if (!parsed) {
      return defaultState();
    }
    return {
      auto_cursor_line:
        typeof parsed.auto_cursor_line === "number" &&
        parsed.auto_cursor_line >= 0
          ? parsed.auto_cursor_line
          : 0,
      last_auto_reflection_started_at: parsed.last_auto_reflection_started_at,
      last_auto_reflection_succeeded_at:
        parsed.last_auto_reflection_succeeded_at,
    };
  } catch {
    return defaultState();
  }
}

async function writeState(
  paths: ReflectionTranscriptPaths,
  state: ReflectionTranscriptState,
): Promise<void> {
  await writeFile(
    paths.statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    "utf-8",
  );
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

function buildPayloadPath(kind: "auto" | "remember"): string {
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(tmpdir(), `letta-${kind}-${nonce}.txt`);
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
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);

  const capturedAt = new Date().toISOString();
  const entries = lines
    .map((line) => lineToTranscriptEntry(line, capturedAt))
    .filter((entry): entry is TranscriptEntry => entry !== null);
  if (entries.length === 0) {
    return 0;
  }

  const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
  await appendFile(paths.transcriptPath, `${payload}\n`, "utf-8");
  return entries.length;
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

export async function buildAutoReflectionPayload(
  agentId: string,
  conversationId: string,
  systemPrompt?: string,
): Promise<AutoReflectionPayload | null> {
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);

  const state = await readState(paths);
  const lines = await readTranscriptLines(paths);
  const cursorLine = Math.min(
    Math.max(0, state.auto_cursor_line),
    lines.length,
  );
  if (cursorLine !== state.auto_cursor_line) {
    state.auto_cursor_line = cursorLine;
    await writeState(paths, state);
  }
  if (cursorLine >= lines.length) {
    return null;
  }

  const snapshotLines = lines.slice(cursorLine);

  const entries = snapshotLines
    .map((line) => parseJsonLine<TranscriptEntry>(line))
    .filter((entry): entry is TranscriptEntry => entry !== null);
  const messageIds = entries
    .map((entry) => entry.source_line_id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  const startMessageId = messageIds[0];
  const endMessageId = messageIds[messageIds.length - 1];
  const filteredSystemPrompt = systemPrompt
    ? filterSystemPromptForReflection(systemPrompt) || undefined
    : undefined;
  const transcript = formatTaggedTranscript(entries, filteredSystemPrompt);
  if (!transcript || transcript === "[]") {
    return null;
  }

  const payloadPath = buildPayloadPath("auto");
  await writeFile(payloadPath, transcript, "utf-8");

  state.last_auto_reflection_started_at = new Date().toISOString();
  await writeState(paths, state);

  return {
    payloadPath,
    startMessageId,
    endMessageId,
    endSnapshotLine: lines.length,
  };
}

export async function finalizeAutoReflectionPayload(
  agentId: string,
  conversationId: string,
  _payloadPath: string,
  endSnapshotLine: number,
  success: boolean,
): Promise<void> {
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);

  const state = await readState(paths);
  if (success) {
    state.auto_cursor_line = Math.max(state.auto_cursor_line, endSnapshotLine);
    state.last_auto_reflection_succeeded_at = new Date().toISOString();
  }
  await writeState(paths, state);
}
