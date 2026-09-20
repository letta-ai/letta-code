import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "@/utils/type-guards";
import { emptyLocalUsage, type LocalMessage } from "./local-message";
import {
  LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
  LOCAL_TRANSCRIPT_SCHEMA_VERSION,
  type LocalTranscriptManifest,
} from "./local-store";

export interface LocalTranscriptMigrationResult {
  storageDir: string;
  converted: Array<{
    conversationDir: string;
    messagesPath: string;
    backupPath: string;
    manifestPath: string;
    messageCount: number;
  }>;
  skipped: Array<{
    conversationDir: string;
    reason: string;
  }>;
  dryRun: boolean;
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function isLegacyUiMessage(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Array.isArray(value.parts) &&
    (!Object.hasOwn(value, "content") || value.content === null)
  );
}

function isPiLocalMessage(value: unknown): value is LocalMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.role === "user" ||
      value.role === "assistant" ||
      value.role === "toolResult") &&
    Object.hasOwn(value, "content")
  );
}

function writeJsonl(path: string, items: unknown[]): void {
  writeFileSync(
    path,
    `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
}

function writeSessionEntryJsonl(
  path: string,
  messages: LocalMessage[],
  input: { conversationId: string; createdAt?: string },
): void {
  let parentId: string | null = null;
  const entries = [
    {
      type: "session",
      version: 3,
      id: input.conversationId,
      timestamp: input.createdAt ?? new Date().toISOString(),
      cwd: process.cwd(),
    },
    ...messages.map((message) => {
      const entry = {
        type: "message",
        id: randomUUID().slice(0, 8),
        parentId,
        timestamp:
          message.metadata?.created_at ??
          new Date(message.timestamp).toISOString(),
        message,
      };
      parentId = entry.id;
      return entry;
    }),
  ];
  writeJsonl(path, entries);
}

function timestampForLegacy(message: Record<string, unknown>): number {
  const createdAt = isRecord(message.metadata)
    ? message.metadata.created_at
    : undefined;
  const parsed = typeof createdAt === "string" ? Date.parse(createdAt) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isoTimestampForLegacy(message: Record<string, unknown>): string {
  const createdAt = isRecord(message.metadata)
    ? message.metadata.created_at
    : undefined;
  if (typeof createdAt === "string") return createdAt;
  return new Date(timestampForLegacy(message)).toISOString();
}

function legacyImageFromPart(part: Record<string, unknown>) {
  if (part.type === "image" && isRecord(part.source)) {
    const source = part.source;
    if (
      source.type === "base64" &&
      typeof source.media_type === "string" &&
      typeof source.data === "string"
    ) {
      return {
        type: "image" as const,
        mimeType: source.media_type,
        data: source.data,
      };
    }
  }

  if (part.type === "file") {
    const mediaType =
      typeof part.mediaType === "string"
        ? part.mediaType
        : typeof part.mime === "string"
          ? part.mime
          : undefined;
    const url = typeof part.url === "string" ? part.url : undefined;
    if (mediaType?.startsWith("image/") && url?.startsWith("data:")) {
      const marker = ";base64,";
      const markerIndex = url.indexOf(marker);
      if (markerIndex >= 0) {
        return {
          type: "image" as const,
          mimeType: mediaType,
          data: url.slice(markerIndex + marker.length),
        };
      }
    }
  }
  return undefined;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Extracts the numeric suffix from a ui-msg-N ID, or returns 0. */
function numericId(id: string): number {
  const match = id.match(/ui-msg-(\d+)$/);
  return match ? Number(match[1]) : 0;
}

function convertLegacyMessage(
  message: unknown,
  nextId: () => number,
): LocalMessage[] {
  if (!isRecord(message)) return [];
  const id = typeof message.id === "string" ? message.id : `ui-msg-${nextId()}`;
  const metadata = isRecord(message.metadata) ? { ...message.metadata } : {};
  const timestamp = timestampForLegacy(message);
  const createdAt = isoTimestampForLegacy(message);
  const updatedAt =
    isRecord(message.metadata) &&
    typeof message.metadata.updated_at === "string"
      ? message.metadata.updated_at
      : createdAt;

  if (metadata.compaction && message.role === "user") {
    const textPart = Array.isArray(message.parts)
      ? message.parts.find(
          (part) =>
            isRecord(part) &&
            part.type === "text" &&
            typeof part.text === "string",
        )
      : undefined;
    return [
      {
        id,
        role: "user",
        metadata: { ...metadata, created_at: createdAt, updated_at: updatedAt },
        content: [
          {
            type: "text",
            text: isRecord(textPart) ? String(textPart.text ?? "") : "",
          },
        ],
        timestamp,
      },
    ];
  }

  if (message.role === "user" || message.role === "system") {
    const content: (LocalMessage & { role: "user" })["content"] = [];
    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (!isRecord(part)) continue;
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      const image = legacyImageFromPart(part);
      if (image) content.push(image);
    }
    return [
      {
        id,
        role: "user",
        metadata: { ...metadata, created_at: createdAt, updated_at: updatedAt },
        content: content.length > 0 ? content : [{ type: "text", text: "" }],
        timestamp,
      },
    ];
  }

  if (message.role !== "assistant") return [];

  // Split parts on step-start boundaries. Each step represents a logical LLM
  // turn within the stored message. The old format used step-start markers to
  // delimit turns where the agent called a tool, got a result, and continued
  // generating — all within one stored message. Splitting preserves the
  // correct turn structure so that tool_use blocks are always at the end of
  // an assistant message (required by Anthropic's API).
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const steps: Array<Record<string, unknown>[]> = [];
  let currentStep: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (isRecord(part) && part.type === "step-start") {
      if (currentStep.length > 0) {
        steps.push(currentStep);
      }
      currentStep = [];
    } else if (isRecord(part)) {
      currentStep.push(part);
    }
  }
  if (currentStep.length > 0) {
    steps.push(currentStep);
  }

  // If no step-start markers were found, treat the whole message as one step
  // (backward compatibility for messages without step-start markers).
  if (steps.length === 0 && parts.length > 0) {
    const filtered = parts.filter((part): part is Record<string, unknown> =>
      isRecord(part),
    );
    if (filtered.length > 0) {
      steps.push(filtered);
    }
  }

  const result: LocalMessage[] = [];

  for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
    const step = steps[stepIndex];
    if (!step) continue;
    // Single-step messages keep the original ID; multi-step messages get
    // fresh sequential IDs to avoid introducing a new ID format.
    const stepId = steps.length === 1 ? id : `ui-msg-${nextId()}`;
    const content: (LocalMessage & { role: "assistant" })["content"] = [];
    const stepToolResults: LocalMessage[] = [];

    for (const part of step) {
      if (part.type === "text" && typeof part.text === "string") {
        content.push({ type: "text", text: part.text });
        continue;
      }
      if (part.type === "reasoning" && typeof part.text === "string") {
        content.push({ type: "thinking", thinking: part.text });
        continue;
      }
      if (
        typeof part.type === "string" &&
        part.type.startsWith("tool-") &&
        typeof part.toolCallId === "string"
      ) {
        const toolName = part.type.slice("tool-".length);
        content.push({
          type: "toolCall" as const,
          id: part.toolCallId,
          name: toolName,
          arguments: isRecord(part.input)
            ? part.input
            : { input: part.input ?? {} },
        });
        if (
          part.state === "output-available" ||
          part.state === "output-error" ||
          part.state === "output-denied"
        ) {
          const isError = part.state !== "output-available";
          const output =
            part.state === "output-available" ? part.output : part.errorText;
          stepToolResults.push({
            id: `ui-msg-${nextId()}`,
            role: "toolResult",
            toolCallId: part.toolCallId,
            toolName,
            content: [{ type: "text", text: textFromUnknown(output) }],
            isError,
            timestamp,
            metadata: {
              ...metadata,
              created_at: createdAt,
              updated_at: updatedAt,
            },
          });
        }
      }
    }

    if (content.length > 0) {
      result.push({
        id: stepId,
        role: "assistant",
        metadata: { ...metadata, created_at: createdAt, updated_at: updatedAt },
        content,
        api: "legacy-local",
        provider: "legacy-local",
        model: "legacy-local",
        usage: emptyLocalUsage(),
        stopReason: "stop" as const,
        timestamp,
      });
    }
    result.push(...stepToolResults);
  }

  return result;
}

function timestampSuffix(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function manifest(input: {
  backupPath?: string;
  migratedFrom?: string;
}): LocalTranscriptManifest {
  const now = new Date().toISOString();
  return {
    schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
    message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
    created_at: now,
    migrated_from:
      input.migratedFrom ?? "unversioned-legacy-local-message-jsonl",
    migrated_at: now,
    ...(input.backupPath ? { backup_path: input.backupPath } : {}),
  };
}

function convertMessages(
  messages: unknown[],
  mode: "legacy" | "repair-versioned",
  nextId: () => number,
): { messages: LocalMessage[]; idRemapping: Map<string, string[]> } {
  const idRemapping = new Map<string, string[]>();
  const converted: LocalMessage[] = [];

  for (const message of messages) {
    const isLegacy = isLegacyUiMessage(message);
    const isPi = isPiLocalMessage(message);

    if (mode === "legacy" && !isLegacy) continue;
    if (mode === "repair-versioned" && !isLegacy && !isPi) continue;

    if (isPi) {
      converted.push(message);
      continue;
    }

    const result = convertLegacyMessage(message, nextId);
    converted.push(...result);

    // If the legacy message's original ID is not in the converted output,
    // it was split into multiple messages with new IDs. Record the mapping.
    if (isRecord(message) && typeof message.id === "string") {
      const originalId = message.id;
      const hasOriginal = result.some((m) => m.id === originalId);
      if (!hasOriginal && result.length > 0) {
        idRemapping.set(
          originalId,
          result.map((m) => m.id),
        );
      }
    }
  }

  return { messages: converted, idRemapping };
}

export function migrateLocalBackendTranscripts(input: {
  storageDir: string;
  dryRun?: boolean;
}): LocalTranscriptMigrationResult {
  const storageDir = input.storageDir;
  const conversationsDir = join(storageDir, "conversations");
  const result: LocalTranscriptMigrationResult = {
    storageDir,
    converted: [],
    skipped: [],
    dryRun: input.dryRun === true,
  };
  if (!existsSync(conversationsDir)) return result;

  for (const name of readdirSync(conversationsDir)) {
    const conversationDir = join(conversationsDir, name);
    const messagesPath = join(conversationDir, "messages.jsonl");
    const manifestPath = join(conversationDir, "manifest.json");
    const hasManifest = existsSync(manifestPath);
    const existingManifest = hasManifest
      ? (() => {
          try {
            return JSON.parse(readFileSync(manifestPath, "utf8")) as {
              message_format?: unknown;
            };
          } catch {
            return undefined;
          }
        })()
      : undefined;
    const hasLegacyPiManifest =
      existingManifest?.message_format ===
      LOCAL_TRANSCRIPT_LEGACY_MESSAGE_FORMAT;
    const legacyMessages = readJsonl(messagesPath);
    const hasLegacyUiRows = legacyMessages.some(isLegacyUiMessage);
    if (hasManifest && !hasLegacyUiRows && !hasLegacyPiManifest) {
      result.skipped.push({ conversationDir, reason: "already-versioned" });
      continue;
    }
    if (legacyMessages.length === 0) {
      result.skipped.push({ conversationDir, reason: "empty" });
      if (!input.dryRun) {
        mkdirSync(conversationDir, { recursive: true });
        writeFileSync(
          manifestPath,
          `${JSON.stringify(manifest({}), null, 2)}\n`,
        );
      }
      continue;
    }
    const repairVersioned =
      hasManifest && (hasLegacyUiRows || hasLegacyPiManifest);

    // Compute the max numeric ID across all messages so that step-split
    // messages get fresh, non-colliding sequential IDs. We check both
    // legacy and pi-format messages to avoid collisions with preserved IDs.
    const maxId = legacyMessages.reduce<number>((max, msg) => {
      if (isRecord(msg) && typeof msg.id === "string") {
        const n = numericId(msg.id);
        return n > max ? n : max;
      }
      if (isPiLocalMessage(msg)) {
        const n = numericId(msg.id);
        return n > max ? n : max;
      }
      return max;
    }, 0);
    let idCounter = maxId + 1;
    const nextId = () => idCounter++;

    const { messages: converted, idRemapping } = convertMessages(
      legacyMessages,
      repairVersioned ? "repair-versioned" : "legacy",
      nextId,
    );
    const backupPath = `${messagesPath}.pre-pi-backup-${timestampSuffix()}`;
    if (!input.dryRun) {
      copyFileSync(messagesPath, backupPath);
      const conversationPath = join(conversationDir, "conversation.json");
      let conversation: Record<string, unknown> | undefined;
      if (existsSync(conversationPath)) {
        try {
          conversation = JSON.parse(readFileSync(conversationPath, "utf8"));
        } catch {
          conversation = undefined;
        }
      }
      writeSessionEntryJsonl(messagesPath, converted, {
        conversationId:
          typeof conversation?.id === "string" ? conversation.id : name,
        createdAt:
          typeof conversation?.created_at === "string"
            ? conversation.created_at
            : undefined,
      });

      // Remap in_context_message_ids in conversation.json for any
      // legacy assistant messages that were split into multiple messages.
      if (conversation && idRemapping.size > 0) {
        try {
          if (Array.isArray(conversation.in_context_message_ids)) {
            const remapped: string[] = [];
            for (const id of conversation.in_context_message_ids) {
              if (typeof id !== "string") {
                remapped.push(id);
                continue;
              }
              const newIds = idRemapping.get(id);
              if (newIds) {
                remapped.push(...newIds);
              } else {
                remapped.push(id);
              }
            }
            conversation.in_context_message_ids = remapped;
            writeFileSync(
              conversationPath,
              `${JSON.stringify(conversation, null, 2)}\n`,
            );
          }
        } catch {
          // If conversation.json can't be read/parsed, skip remapping
        }
      }

      writeFileSync(
        manifestPath,
        `${JSON.stringify(
          manifest({
            backupPath,
            migratedFrom: repairVersioned
              ? hasLegacyUiRows
                ? "versioned-pi-transcript-with-legacy-ui-message-rows"
                : "versioned-pi-ai-message-jsonl"
              : undefined,
          }),
          null,
          2,
        )}\n`,
      );
    }
    result.converted.push({
      conversationDir,
      messagesPath,
      backupPath,
      manifestPath,
      messageCount: converted.length,
    });
  }
  return result;
}
