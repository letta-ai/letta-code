import type { ProviderStreamEvent } from "./provider-turn-executor";

export function isPiModelOutputEvent(event: ProviderStreamEvent): boolean {
  if (event.type === "local-message") return true;
  if (event.type !== "provider-part") return false;
  switch (event.part.type) {
    case "text_start": {
      const content = event.part.partial.content[event.part.contentIndex];
      return content?.type === "text" && content.text.length > 0;
    }
    case "text_delta":
      return true;
    case "thinking_start": {
      const content = event.part.partial.content[event.part.contentIndex];
      return content?.type === "thinking" && content.thinking.length > 0;
    }
    case "thinking_delta":
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}
