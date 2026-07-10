import { isAbsolute, relative, resolve, sep } from "node:path";

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";
const MEMORY_DIR_ENV_PREFIX = "$MEMORY_DIR/";
const MEMORY_DIR_BRACED_ENV_PREFIX = "$" + "{MEMORY_DIR}/";
const MEMORY_ROOT_NAMES = new Set(["system", "reference", "skills"]);
const MEMORY_PATH_TOOL_NAMES = new Set([
  "Read",
  "ReadFile",
  "ReadFileGemini",
  "ReadLSP",
  "ReadManyFiles",
  "LS",
  "Glob",
  "Grep",
]);
const MAX_CITATIONS = 8;

type Confidence = "high" | "medium";

interface MemoryCitation {
  confidence: Confidence;
  evidence: string;
  path: string;
  toolCallId: string | null;
  toolName: string;
  observedAt: string;
}

interface ConversationState {
  citations: MemoryCitation[];
  turnStartedAt: string;
}

function conversationKey(conversationId: string | null | undefined): string {
  return conversationId ?? "__unknown_conversation__";
}

function getMemoryDir(context: unknown): string | null {
  const typed = context as {
    memfs?: { enabled?: boolean; memoryDir?: string | null };
  };
  if (typed.memfs?.enabled && typed.memfs.memoryDir) {
    return typed.memfs.memoryDir;
  }

  const fromEnv = process.env.MEMORY_DIR?.trim();
  return fromEnv ? fromEnv : null;
}

function normalizeSlashes(value: string): string {
  return value.split("\\").join("/");
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function looksLikeMemoryRelativePath(value: string): boolean {
  const normalized = normalizeSlashes(value).replace(/^\.\//, "");
  const [root] = normalized.split("/");
  return MEMORY_ROOT_NAMES.has(root ?? "");
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  const rel = relative(directory, filePath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function toMemoryRelativePath(
  filePath: string,
  memoryDir: string,
): string | null {
  const cleaned = stripWrappingQuotes(filePath);
  if (!cleaned) return null;

  if (
    cleaned.startsWith(MEMORY_DIR_ENV_PREFIX) ||
    cleaned.startsWith(MEMORY_DIR_BRACED_ENV_PREFIX)
  ) {
    return normalizeSlashes(
      cleaned
        .replace(MEMORY_DIR_ENV_PREFIX, "")
        .replace(MEMORY_DIR_BRACED_ENV_PREFIX, ""),
    );
  }

  if (looksLikeMemoryRelativePath(cleaned)) {
    return normalizeSlashes(cleaned.replace(/^\.\//, ""));
  }

  const absolutePath = isAbsolute(cleaned) ? cleaned : resolve(cleaned);
  if (!isWithinDirectory(absolutePath, memoryDir)) return null;

  const rel = relative(memoryDir, absolutePath);
  return normalizeSlashes(rel || ".");
}

function pathFromToolArgs(args: Record<string, unknown>): string | null {
  const candidates = [
    args.file_path,
    args.path,
    args.dir_path,
    args.absolute_path,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractBashMemoryReferences(
  command: string,
  memoryDir: string,
): string[] {
  const refs = new Set<string>();

  const envPattern = /\$\{?MEMORY_DIR\}?\/?[^\s'";|&)]*/g;
  for (const match of command.matchAll(envPattern)) {
    const ref = toMemoryRelativePath(match[0], memoryDir);
    if (ref) refs.add(ref);
  }

  const normalizedMemoryDir = normalizeSlashes(memoryDir).replace(/\/$/, "");
  const normalizedCommand = normalizeSlashes(command);
  const absolutePattern = new RegExp(
    `${escapeRegExp(normalizedMemoryDir)}(?:/[^\\s'";|&)]+)?`,
    "g",
  );
  for (const match of normalizedCommand.matchAll(absolutePattern)) {
    const ref = toMemoryRelativePath(match[0], memoryDir);
    if (ref) refs.add(ref);
  }

  if (refs.size === 0 && normalizedCommand.includes(normalizedMemoryDir)) {
    refs.add(".");
  }

  return [...refs];
}

function confidenceForTool(toolName: string): Confidence {
  return toolName === "Bash" ||
    toolName === "ShellCommand" ||
    toolName === "exec_command"
    ? "medium"
    : "high";
}

function addCitation(
  state: ConversationState,
  citation: Omit<MemoryCitation, "observedAt">,
): void {
  const existing = state.citations.find(
    (item) =>
      item.path === citation.path &&
      item.toolName === citation.toolName &&
      item.evidence === citation.evidence,
  );
  if (existing) return;

  state.citations.push({
    ...citation,
    observedAt: new Date().toISOString(),
  });
}

function summarizeCitations(state: ConversationState | undefined) {
  const citations = state?.citations.slice(-MAX_CITATIONS) ?? [];
  return {
    instruction:
      "Use these as observed memory references only. Do not cite files that are not listed here. High confidence means a memory path was passed to a read/list/search-style tool this turn; medium confidence means a shell command referenced the memory directory before execution.",
    turnStartedAt: state?.turnStartedAt ?? null,
    citationCount: citations.length,
    citations,
    footerTemplate:
      citations.length > 0
        ? "Memory references: <path> (<confidence>, <brief reason>)"
        : "No explicit memory file reads were observed this turn. Omit the memory footer unless you have another explicit source label.",
  };
}

function createCitationInstruction(): string {
  return `${SYSTEM_REMINDER_OPEN}\nMemory citation mod is active. If memory materially contributes to your answer, call the memory_citation_snapshot tool before your final response and include a compact "Memory references" footer using only paths returned by that tool. Do not invent memory citations. If the snapshot returns no citations, omit the footer or say that no explicit memory file reads were observed.\n${SYSTEM_REMINDER_CLOSE}`;
}

function appendSystemMessage(input: unknown[], text: string): unknown[] {
  return [
    ...input,
    {
      type: "message",
      role: "system",
      content: text,
    },
  ];
}

export function activate(letta) {
  const disposers = [];
  const byConversation = new Map<string, ConversationState>();

  function getState(
    conversationId: string | null | undefined,
  ): ConversationState {
    const key = conversationKey(conversationId);
    let state = byConversation.get(key);
    if (!state) {
      state = { citations: [], turnStartedAt: new Date().toISOString() };
      byConversation.set(key, state);
    }
    return state;
  }

  if (letta.capabilities.events.turns) {
    disposers.push(
      letta.events.on("turn_start", (event) => {
        const key = conversationKey(event.conversationId);
        byConversation.set(key, {
          citations: [],
          turnStartedAt: new Date().toISOString(),
        });
        event.input = appendSystemMessage(
          event.input,
          createCitationInstruction(),
        );
      }),
    );
  }

  if (letta.capabilities.events.tools) {
    disposers.push(
      letta.events.on("tool_start", (event, ctx) => {
        const memoryDir = getMemoryDir(ctx);
        if (!memoryDir) return;

        const state = getState(event.conversationId);
        const toolName = event.toolName;
        const confidence = confidenceForTool(toolName);

        if (
          toolName === "Bash" ||
          toolName === "ShellCommand" ||
          toolName === "exec_command"
        ) {
          const command =
            typeof event.args.command === "string"
              ? event.args.command
              : typeof event.args.cmd === "string"
                ? event.args.cmd
                : "";
          for (const ref of extractBashMemoryReferences(command, memoryDir)) {
            addCitation(state, {
              confidence,
              evidence: "shell command referenced the memory directory",
              path: ref,
              toolCallId: event.toolCallId,
              toolName,
            });
          }
          return;
        }

        if (!MEMORY_PATH_TOOL_NAMES.has(toolName)) return;

        const candidatePath = pathFromToolArgs(event.args);
        if (!candidatePath) return;
        const memoryPath = toMemoryRelativePath(candidatePath, memoryDir);
        if (!memoryPath) return;

        const isDirectoryish =
          memoryPath === "." || candidatePath.endsWith(sep);
        addCitation(state, {
          confidence,
          evidence: isDirectoryish
            ? "tool referenced the memory directory"
            : "memory path was passed to a tool this turn",
          path: memoryPath,
          toolCallId: event.toolCallId,
          toolName,
        });
      }),
    );
  }

  if (letta.capabilities.tools) {
    disposers.push(
      letta.tools.register({
        name: "memory_citation_snapshot",
        description:
          "Return observed memory file references for the current turn. Call this immediately before a final answer when memory influenced the answer, then cite only returned paths in a short Memory references footer.",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        requiresApproval: false,
        parallelSafe: true,
        run(ctx) {
          const key = conversationKey(ctx.conversation.id ?? ctx.sessionId);
          return JSON.stringify(
            summarizeCitations(byConversation.get(key)),
            null,
            2,
          );
        },
      }),
    );
  }

  if (letta.capabilities.commands) {
    disposers.push(
      letta.commands.register({
        id: "memory-citations",
        description:
          "Show memory references observed by the memory citation mod this turn.",
        run(ctx) {
          const key = conversationKey(ctx.conversation.id ?? ctx.sessionId);
          return {
            type: "output",
            output: JSON.stringify(
              summarizeCitations(byConversation.get(key)),
              null,
              2,
            ),
          };
        },
      }),
    );
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose();
    byConversation.clear();
  };
}
