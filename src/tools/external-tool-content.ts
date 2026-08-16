import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";

interface ExternalToolResultContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Convert external-tool wire content into the content shape sent to Letta. */
export function normalizeExternalToolResultContent(
  content: readonly ExternalToolResultContent[],
): string | Array<TextContent | ImageContent> {
  const normalized = content.flatMap<TextContent | ImageContent>((part) => {
    if (part.type === "text" && typeof part.text === "string") {
      return [{ type: "text", text: part.text }];
    }
    if (
      part.type === "image" &&
      typeof part.data === "string" &&
      typeof part.mimeType === "string"
    ) {
      return [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: part.mimeType,
            data: part.data,
          },
        },
      ];
    }
    return [];
  });

  if (normalized.some((part) => part.type === "image")) {
    return normalized;
  }

  const text = normalized
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  return text || JSON.stringify(content);
}
