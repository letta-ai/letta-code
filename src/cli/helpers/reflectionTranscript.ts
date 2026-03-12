import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { type Line, linesToTranscript } from "./accumulator";

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
  /** ~/.letta/transcripts/{agentId}/{conversationId}/ */
  rootDir: string;
  transcriptPath: string;
  statePath: string;
}

export interface AutoReflectionPayload {
  payloadPath: string;
  endSnapshotLine: number;
}

export interface ReflectionPromptInput {
  transcriptPath: string;
  memoryDir: string;
  cwd?: string;
}

export function buildReflectionSubagentPrompt(
  input: ReflectionPromptInput,
): string {
  const lines = [
    "Review the conversation transcript and update memory files.",
    `The current conversation transcript has been saved to: ${input.transcriptPath}`,
    `The primary agent's memory filesystem is located at: ${input.memoryDir}`,
  ];
  if (input.cwd) {
    lines.push(`Your current working directory is: ${input.cwd}`);
  }
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

  const payloadPath = buildPayloadPath("auto");
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
