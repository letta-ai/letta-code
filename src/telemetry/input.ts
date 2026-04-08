import type { MessageCreate } from "@letta-ai/letta-client/resources/agents/agents";

export function extractTelemetryInputText(
  content: MessageCreate["content"],
): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n");
}
