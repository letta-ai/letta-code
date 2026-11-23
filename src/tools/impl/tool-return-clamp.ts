import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { LIMITS, truncateByChars } from "./truncation.js";

type ClampableToolReturn = string | Array<TextContent | ImageContent>;

export function clampToolReturnText(text: string, toolName: string): string {
  if (text.length <= LIMITS.TOOL_RETURN_MAX_CHARS) {
    return text;
  }
  return truncateByChars(text, LIMITS.TOOL_RETURN_MAX_CHARS, toolName, {
    workingDirectory: getCurrentWorkingDirectory(),
  }).content;
}

const NOTICE_HEADROOM_CHARS = 1_000;

export function clampRawToolReturn(
  rawResult: unknown,
  toolName?: string,
): string {
  const text =
    typeof rawResult === "string"
      ? rawResult
      : rawResult != null
        ? JSON.stringify(rawResult)
        : "";
  if (text.length <= LIMITS.TOOL_RETURN_MAX_CHARS + NOTICE_HEADROOM_CHARS) {
    return text;
  }
  return clampToolReturnText(text, toolName ?? "tool");
}

export function clampToolReturnContent(
  content: ClampableToolReturn,
  toolName: string,
): ClampableToolReturn {
  if (typeof content === "string") {
    return clampToolReturnText(content, toolName);
  }
  return content.map((block) =>
    block.type === "text"
      ? { ...block, text: clampToolReturnText(block.text, toolName) }
      : block,
  );
}
