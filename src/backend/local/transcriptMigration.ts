import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { emptyLocalUsage, type LocalMessage } from "./LocalMessage";
import {
  LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
  LOCAL_TRANSCRIPT_PROVIDER_STACK,
  LOCAL_TRANSCRIPT_SCHEMA_VERSION,
  type LocalTranscriptManifest,
} from "./LocalStore";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonl(path: string): unknown[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function writeJsonl(path: string, items: unknown[]): void {
  writeFileSync(
    path,
    `${items.map((item) => JSON.stringify(item)).join("\n")}\n`,
  );
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

function convertLegacyMessage(message: unknown): LocalMessage[] {
  if (!isRecord(message)) return [];
  const id =
    typeof message.id === "string" ? message.id : `ui-msg-${Date.now()}`;
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

  const assistant = {
    id,
    role: "assistant" as const,
    metadata: { ...metadata, created_at: createdAt, updated_at: updatedAt },
    content: [] as (LocalMessage & { role: "assistant" })["content"],
    api: "legacy-local",
    provider: "legacy-local",
    model: "legacy-local",
    usage: emptyLocalUsage(),
    stopReason: "stop" as const,
    timestamp,
  };
  const toolResults: LocalMessage[] = [];

  for (const part of Array.isArray(message.parts) ? message.parts : []) {
    if (!isRecord(part) || typeof part.type !== "string") continue;
    if (part.type === "text" && typeof part.text === "string") {
      assistant.content.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "reasoning" && typeof part.text === "string") {
      assistant.content.push({ type: "thinking", thinking: part.text });
      continue;
    }
    if (part.type.startsWith("tool-") && typeof part.toolCallId === "string") {
      const toolName = part.type.slice("tool-".length);
      const toolCall = {
        type: "toolCall" as const,
        id: part.toolCallId,
        name: toolName,
        arguments: isRecord(part.input)
          ? part.input
          : { input: part.input ?? {} },
      };
      assistant.content.push(toolCall);
      if (
        part.state === "output-available" ||
        part.state === "output-error" ||
        part.state === "output-denied"
      ) {
        const isError = part.state !== "output-available";
        const output =
          part.state === "output-available" ? part.output : part.errorText;
        toolResults.push({
          id: `${id}:tool-result:${part.toolCallId}`,
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

  return assistant.content.length > 0
    ? [assistant, ...toolResults]
    : toolResults;
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

function manifest(input: { backupPath?: string }): LocalTranscriptManifest {
  const now = new Date().toISOString();
  return {
    schema_version: LOCAL_TRANSCRIPT_SCHEMA_VERSION,
    message_format: LOCAL_TRANSCRIPT_MESSAGE_FORMAT,
    provider_stack: LOCAL_TRANSCRIPT_PROVIDER_STACK,
    created_at: now,
    migrated_from: "unversioned-legacy-local-message-jsonl",
    migrated_at: now,
    ...(input.backupPath ? { backup_path: input.backupPath } : {}),
  };
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
    if (existsSync(manifestPath)) {
      result.skipped.push({ conversationDir, reason: "already-versioned" });
      continue;
    }
    const legacyMessages = readJsonl(messagesPath);
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
    const converted = legacyMessages.flatMap(convertLegacyMessage);
    const backupPath = `${messagesPath}.pre-pi-backup-${timestampSuffix()}`;
    if (!input.dryRun) {
      copyFileSync(messagesPath, backupPath);
      writeJsonl(messagesPath, converted);
      writeFileSync(
        manifestPath,
        `${JSON.stringify(manifest({ backupPath }), null, 2)}\n`,
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
