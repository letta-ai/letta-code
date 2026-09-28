/**
 * Backstop clamp for model-facing tool returns.
 *
 * Individual tools apply their own limits (see LIMITS in truncation.ts), but
 * several never bound the total size of the string they return: Read caps
 * lines and chars-per-line only, Glob caps item counts only, Memory/Skill return file bodies verbatim, and external/MCP and
 * mod tools can return arbitrarily large output. This module clamps any tool
 * return that slipped past those per-tool limits before it reaches the model,
 * writing the full content to an overflow file so nothing is lost.
 *
 * The transcript accumulator applies the same clamp to the tool returns it
 * retains for display (see clampRawToolReturn): server-side (cloud) tool
 * returns bypass the tool manager entirely, so without the backstop their
 * full text would be held in memory for the whole session.
 */

import type {
  ImageContent,
  TextContent,
} from "@letta-ai/letta-client/resources/agents/messages";
import { getCurrentWorkingDirectory } from "@/runtime-context";
import { LIMITS, truncateByChars } from "./truncation.js";

type ClampableToolReturn = string | Array<TextContent | ImageContent>;

/**
 * Bound the size of a single tool return string. Returns the input unchanged
 * when it already fits; otherwise middle-truncates to TOOL_RETURN_MAX_CHARS,
 * appends a truncation notice, and writes the full content to an overflow
 * file so nothing is lost.
 */
export function clampToolReturnText(text: string, toolName: string): string {
  if (text.length <= LIMITS.TOOL_RETURN_MAX_CHARS) {
    return text;
  }
  return truncateByChars(text, LIMITS.TOOL_RETURN_MAX_CHARS, toolName, {
    workingDirectory: getCurrentWorkingDirectory(),
  }).content;
}

/**
 * Extra room on top of TOOL_RETURN_MAX_CHARS for the transcript clamp. Local
 * tool returns reach the accumulator already clamped by the tool manager,
 * which appends a truncation notice (and overflow-file path) on top of the
 * TOOL_RETURN_MAX_CHARS excerpt; the headroom lets those pass through
 * unchanged instead of being truncated a second time.
 */
const NOTICE_HEADROOM_CHARS = 1_000;

/**
 * Normalize an unknown tool return payload (as streamed by the server) to a
 * bounded string: non-strings are stringified, and anything beyond the shared
 * backstop limit is clamped like any other tool return.
 */
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
    return clampToolReturnText(content, toolName);
  }
  return content.map((block) =>
    block.type === "text"
      ? { ...block, text: clampToolReturnText(block.text, toolName) }
      : block,
  );
}
