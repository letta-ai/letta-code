import { allocateImage } from "@/cli/helpers/paste-registry";
import { isRecord } from "@/utils/type-guards";

export function queuedDraft(content: unknown): (() => string) | undefined {
  if (typeof content === "string") return () => content;
  if (!Array.isArray(content) || !content.length) return;
  const parts: (() => string)[] = [];
  for (const part of content) {
    if (!isRecord(part)) return;
    if (part.type === "text" && typeof part.text === "string") {
      const text = part.text;
      parts.push(() => text);
    } else if (
      part.type === "image" &&
      isRecord(part.source) &&
      part.source.type === "base64" &&
      typeof part.source.data === "string" &&
      typeof part.source.media_type === "string"
    ) {
      const image = {
        data: part.source.data,
        mediaType: part.source.media_type,
      };
      parts.push(() => `[Image #${allocateImage(image)}]`);
    } else return;
  }
  return () => parts.map((part) => part()).join("");
}
