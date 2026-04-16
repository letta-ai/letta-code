import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { ChannelMessageAttachment } from "../types";

const DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS = 15_000;
const DISCORD_ATTACHMENTS_DIR = join(tmpdir(), "letta-discord-attachments");

function ensureAttachmentsDir(): string {
  mkdirSync(DISCORD_ATTACHMENTS_DIR, { recursive: true });
  return DISCORD_ATTACHMENTS_DIR;
}

function resolveAttachmentKind(
  contentType: string | null | undefined,
): "image" | "audio" | "video" | "file" {
  if (!contentType) return "file";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "file";
}

interface DiscordRawAttachment {
  id: string;
  name: string | null;
  contentType: string | null;
  size: number;
  url: string;
}

export async function resolveDiscordInboundAttachments(params: {
  accountId: string;
  rawAttachments: DiscordRawAttachment[];
  chatId: string;
}): Promise<ChannelMessageAttachment[]> {
  if (params.rawAttachments.length === 0) {
    return [];
  }

  const dir = ensureAttachmentsDir();
  const results: ChannelMessageAttachment[] = [];

  for (const attachment of params.rawAttachments) {
    const name = attachment.name ?? `attachment-${attachment.id}`;
    const kind = resolveAttachmentKind(attachment.contentType);
    const localFileName = `${params.accountId}-${params.chatId}-${attachment.id}-${name}`;
    const localPath = join(dir, localFileName);

    try {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        DISCORD_ATTACHMENT_DOWNLOAD_TIMEOUT_MS,
      );
      const response = await fetch(attachment.url, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(
          `[Discord] Failed to download attachment ${name}: HTTP ${response.status}`,
        );
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      await writeFile(localPath, buffer);

      const entry: ChannelMessageAttachment = {
        id: attachment.id,
        name,
        mimeType: attachment.contentType ?? undefined,
        sizeBytes: attachment.size,
        kind,
        localPath,
      };

      // Encode images as base64 for vision
      if (kind === "image" && attachment.contentType?.startsWith("image/")) {
        entry.imageDataBase64 = buffer.toString("base64");
      }

      results.push(entry);
    } catch (error) {
      console.warn(
        `[Discord] Failed to download attachment ${name}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  return results;
}

interface DiscordThreadMessage {
  id: string;
  userId?: string;
  botId?: string;
  text: string;
}

/**
 * Fetch the starter message for a Discord thread.
 * In Discord, threads have a "starter message" that is the parent message.
 */
export async function resolveDiscordThreadStarter(params: {
  client: { channels: { fetch: (id: string) => Promise<unknown> } };
  threadChannelId: string;
}): Promise<DiscordThreadMessage | null> {
  try {
    const channel = (await params.client.channels.fetch(
      params.threadChannelId,
    )) as {
      isThread?: () => boolean;
      fetchStarterMessage?: () => Promise<{
        id: string;
        author?: { id?: string; bot?: boolean };
        content?: string;
      } | null>;
    } | null;

    if (!channel?.isThread?.() || !channel.fetchStarterMessage) {
      return null;
    }

    const starter = await channel.fetchStarterMessage();
    if (!starter) {
      return null;
    }

    return {
      id: starter.id,
      userId: starter.author?.bot ? undefined : starter.author?.id,
      botId: starter.author?.bot ? starter.author?.id : undefined,
      text: starter.content ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Fetch recent thread history for first-turn context hydration.
 */
export async function resolveDiscordThreadHistory(params: {
  client: { channels: { fetch: (id: string) => Promise<unknown> } };
  threadChannelId: string;
  currentMessageId?: string;
  limit?: number;
}): Promise<DiscordThreadMessage[]> {
  const limit = params.limit ?? 20;
  try {
    const channel = (await params.client.channels.fetch(
      params.threadChannelId,
    )) as {
      isThread?: () => boolean;
      messages?: {
        fetch: (opts: { limit: number; before?: string }) => Promise<
          Map<
            string,
            {
              id: string;
              author?: { id?: string; bot?: boolean };
              content?: string;
            }
          >
        >;
      };
    } | null;

    if (!channel?.isThread?.() || !channel.messages) {
      return [];
    }

    const messages = await channel.messages.fetch({
      limit,
      ...(params.currentMessageId ? { before: params.currentMessageId } : {}),
    });

    return Array.from(messages.values())
      .reverse()
      .map((msg) => ({
        id: msg.id,
        userId: msg.author?.bot ? undefined : msg.author?.id,
        botId: msg.author?.bot ? msg.author?.id : undefined,
        text: msg.content ?? "",
      }));
  } catch {
    return [];
  }
}
