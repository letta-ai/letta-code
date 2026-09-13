/**
 * Backstop clamp for model-facing tool returns.
 *
 * Individual tools apply their own limits (see LIMITS in truncation.ts), but
 * several never bound the total size of the string they return: the Read
 * variants cap lines and chars-per-line only, Glob/LS/grep_files cap item
 * counts only, Memory/Skill return file bodies verbatim, and external/MCP and
 * mod tools can return arbitrarily large output. This module clamps any tool
 * return that slipped past those per-tool limits before it reaches the model,
 * writing the full content to an overflow file so nothing is lost.
 */

import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { LIMITS, truncateByChars } from "./truncation.js";

type ClampableToolReturn = string | Array<TextContent | ImageContent>;

function clampText(text: string, toolName: string): string {
  if (text.length <= LIMITS.TOOL_RETURN_MAX_CHARS) {
    return text;
  }
  return truncateByChars(text, LIMITS.TOOL_RETURN_MAX_CHARS, toolName, {
    workingDirectory: getCurrentWorkingDirectory(),
    toolName,
  }).content;
}

/**
 * Bound the total size of a tool return. Strings are clamped directly;
 * multimodal arrays have each text block clamped while image blocks pass
 * through untouched.
 */
export function clampToolReturnContent(
  content: ClampableToolReturn,
  toolName: string,
): ClampableToolReturn {
  if (typeof content === "string") {
    return clampText(content, toolName);
  }
  return content.map((block) =>
    block.type === "text"
      ? { ...block, text: clampText(block.text, toolName) }
      : block,
  );
}
