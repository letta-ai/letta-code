import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Line, linesToTranscript } from "./accumulator";

const REFLECTION_TMP_ROOT_ENV = "LETTA_REFLECTION_TMP_ROOT";
const DEFAULT_REFLECTION_DIR = "letta-reflection";

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
    }
  | {
      kind: "tool_call";
      name?: string;
      argsText?: string;
      resultText?: string;
      resultOk?: boolean;
      captured_at: string;
    };

export interface ReflectionTranscriptPaths {
  rootDir: string;
  transcriptPath: string;
  payloadsDir: string;
  previousDir: string;
  statePath: string;
}

export interface AutoReflectionPayload {
  payloadPath: string;
  endSnapshotLine: number;
}

export interface RememberPayload {
  payloadPath: string;
}

export interface ReflectionPromptInput {
  transcriptPath: string;
  memoryDir: string;
  rememberUserText?: string;
}

export function buildReflectionSubagentPrompt(
  input: ReflectionPromptInput,
): string {
  const rememberUserText = input.rememberUserText?.trim();
  const base = rememberUserText
    ? `Review the conversation transcript and update memory files. The user specifically asked to remember: "${rememberUserText}"`
    : "Review the conversation transcript and update memory files.";

  return [
    base,
    `The current conversation transcript has been saved to: ${input.transcriptPath}`,
    `The primary agent's memory filesystem is located at: ${input.memoryDir}`,
  ].join("\n");
}

function sanitizePathSegment(segment: string): string {
  const sanitized = segment.replace(/[^a-zA-Z0-9._-]/g, "_").trim();
  return sanitized.length > 0 ? sanitized : "unknown";
}

function getReflectionRoot(): string {
  const envRoot = process.env[REFLECTION_TMP_ROOT_ENV]?.trim();
  if (envRoot) {
    return envRoot;
  }
  return join(tmpdir(), DEFAULT_REFLECTION_DIR);
}

function defaultState(): ReflectionTranscriptState {
  return { auto_cursor_line: 0 };
}

function formatTaggedTranscript(entries: TranscriptEntry[]): string {
  const lines: Line[] = [];
  for (const [index, entry] of entries.entries()) {
    const id = `transcript-${index}`;
    switch (entry.kind) {
      case "user":
        lines.push({ kind: "user", id, text: entry.text });
        break;
      case "assistant":
        lines.push({
          kind: "assistant",
          id,
          text: entry.text,
          phase: "finished",
        });
        break;
      case "reasoning":
        lines.push({
          kind: "reasoning",
          id,
          text: entry.text,
          phase: "finished",
        });
        break;
      case "error":
        lines.push({ kind: "error", id, text: entry.text });
        break;
      case "tool_call":
        lines.push({
          kind: "tool_call",
          id,
          name: entry.name,
          argsText: entry.argsText,
          resultText: entry.resultText,
          resultOk: entry.resultOk,
          phase: "finished",
        });
        break;
    }
  }
  return linesToTranscript(lines);
}

function lineToTranscriptEntry(
  line: Line,
  capturedAt: string,
): TranscriptEntry | null {
  switch (line.kind) {
    case "user":
      return { kind: "user", text: line.text, captured_at: capturedAt };
    case "assistant":
      return { kind: "assistant", text: line.text, captured_at: capturedAt };
    case "reasoning":
      return { kind: "reasoning", text: line.text, captured_at: capturedAt };
    case "error":
      return { kind: "error", text: line.text, captured_at: capturedAt };
    case "tool_call":
      return {
        kind: "tool_call",
        name: line.name,
        argsText: line.argsText,
        resultText: line.resultText,
        resultOk: line.resultOk,
        captured_at: capturedAt,
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
  await mkdir(paths.payloadsDir, { recursive: true });
  await mkdir(paths.previousDir, { recursive: true });
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

function buildPayloadPath(
  paths: ReflectionTranscriptPaths,
  kind: "auto" | "remember",
): string {
  const stamp = new Date().toISOString().replace(/[.:]/g, "-");
  const nonce = Math.random().toString(36).slice(2, 8);
  return join(paths.payloadsDir, `${kind}-${stamp}-${nonce}.txt`);
}

async function archivePayload(
  paths: ReflectionTranscriptPaths,
  payloadPath: string,
  success: boolean,
): Promise<void> {
  const filename = basename(payloadPath);
  const archivedName = success
    ? filename
    : filename.replace(/\.txt$/, "-failed.txt");
  const destination = join(paths.previousDir, archivedName);
  try {
    await copyFile(payloadPath, destination);
  } catch {
    // Best-effort archive only.
  }
}

export function getReflectionTranscriptPaths(
  agentId: string,
  conversationId: string,
): ReflectionTranscriptPaths {
  const rootDir = join(
    getReflectionRoot(),
    sanitizePathSegment(agentId),
    sanitizePathSegment(conversationId),
  );
  return {
    rootDir,
    transcriptPath: join(rootDir, "transcript.jsonl"),
    payloadsDir: join(rootDir, "payloads"),
    previousDir: join(rootDir, "previous"),
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

export async function buildAutoReflectionPayload(
  agentId: string,
  conversationId: string,
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
  const transcript = formatTaggedTranscript(entries);
  if (!transcript) {
    return null;
  }

  const payloadPath = buildPayloadPath(paths, "auto");
  await writeFile(payloadPath, transcript, "utf-8");

  state.last_auto_reflection_started_at = new Date().toISOString();
  await writeState(paths, state);

  return {
    payloadPath,
    endSnapshotLine: lines.length,
  };
}

export async function finalizeAutoReflectionPayload(
  agentId: string,
  conversationId: string,
  payloadPath: string,
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
  await archivePayload(paths, payloadPath, success);
}

export async function buildRememberPayload(
  agentId: string,
  conversationId: string,
): Promise<RememberPayload | null> {
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);

  const lines = await readTranscriptLines(paths);
  if (lines.length === 0) {
    return null;
  }

  const entries = lines
    .map((line) => parseJsonLine<TranscriptEntry>(line))
    .filter((entry): entry is TranscriptEntry => entry !== null);
  const transcript = formatTaggedTranscript(entries);
  if (!transcript) {
    return null;
  }

  const payloadPath = buildPayloadPath(paths, "remember");
  await writeFile(payloadPath, transcript, "utf-8");
  return { payloadPath };
}

export async function finalizeRememberPayload(
  agentId: string,
  conversationId: string,
  payloadPath: string,
  success: boolean,
): Promise<void> {
  const paths = getReflectionTranscriptPaths(agentId, conversationId);
  await ensurePaths(paths);
  await archivePayload(paths, payloadPath, success);
}
