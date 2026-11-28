import { isRecord } from "@/utils/type-guards";
import type { LocalImageContent } from "./local-message";

export function textContent(text: string) {
  return [{ type: "text" as const, text }];
}

export function normalizeContent(content: unknown): unknown {
  if (typeof content === "string") {
    return textContent(content);
  }
  return content;
}

export function localImageContentFromLegacyImage(
  part: Record<string, unknown>,
): LocalImageContent | null {
  if (part.type !== "image" || !isRecord(part.source)) return null;
  const source = part.source;
  if (source.type !== "base64") return null;
  const mediaType = source.media_type;
  const data = source.data;
  if (typeof mediaType !== "string" || typeof data !== "string") return null;
  return { type: "image", mimeType: mediaType, data };
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!isRecord(part)) return "";
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        return "";
      })
      .filter((text) => text.length > 0)
      .join("\n");
  }
  if (content === undefined || content === null) return "";
  return JSON.stringify(content);
}

export function parseToolInput(input: unknown): unknown {
  if (typeof input !== "string") return input ?? {};
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}
