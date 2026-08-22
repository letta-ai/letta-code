import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";

export type ToolReturnContent = string | Array<TextContent | ImageContent>;

/**
 * Extract plain text from a tool return when it is purely textual.
 *
 * Tool results can be either a plain string or an array of content parts.
 * Returns the string verbatim for string returns, the concatenated text of
 * text-only part arrays, and null when any non-text (e.g. image) part is
 * present so callers can fall back to non-text presentation paths.
 */
export function toolReturnText(toolReturn: ToolReturnContent): string | null {
  if (typeof toolReturn === "string") {
    return toolReturn;
  }
  if (toolReturn.some((block) => block.type !== "text")) {
    return null;
  }
  return toolReturn
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("");
}
