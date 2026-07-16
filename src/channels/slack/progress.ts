import {
  sanitizeChannelProgressCore,
  truncateChannelProgressText,
} from "@/channels/progress-formatting";
import type { ChannelTurnProgressEvent } from "@/channels/types";
import { isNonEmptyString } from "./public-utils";

export const SLACK_ASSISTANT_STARTUP_STATUS = "is thinking...";
export const SLACK_ASSISTANT_WORKING_STATUS = "is working...";

const SLACK_STATUS_TEXT_MAX = 300;

export function sanitizeSlackStatusText(
  text: string,
  maxLength: number,
): string {
  const normalized = sanitizeChannelProgressCore(text)
    .replace(/[<>]/g, "")
    .replace(/&/g, "and")
    .replace(/\s+/g, " ")
    .trim();
  return truncateChannelProgressText(normalized, maxLength, "...");
}

export function formatSlackToolNameForDisplay(toolName: string): string {
  if (toolName === "Task" || toolName === "task" || toolName === "Agent") {
    return "Subagent";
  }
  if (
    toolName === "Bash" ||
    toolName === "bash" ||
    toolName === "exec_command" ||
    toolName === "shell_command" ||
    toolName === "ShellCommand"
  ) {
    return "Bash";
  }
  return toolName;
}

function isSlackShellTool(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "bash" ||
    normalized === "exec_command" ||
    normalized === "shell_command" ||
    normalized === "shell"
  );
}

export function resolveSlackConcreteActivity(
  event: ChannelTurnProgressEvent,
): string | null {
  if (event.kind === "command" && isNonEmptyString(event.command)) {
    return sanitizeSlackStatusText(
      formatSlackToolNameForDisplay(event.command),
      SLACK_STATUS_TEXT_MAX,
    );
  }
  if (
    event.kind !== "tool" ||
    !isNonEmptyString(event.toolName) ||
    event.toolName.toLowerCase() === "messagechannel"
  ) {
    return null;
  }

  for (const description of [
    event.toolTitle,
    event.toolDetails,
    isSlackShellTool(event.toolName) ? event.message : undefined,
    formatSlackToolNameForDisplay(event.toolName),
  ]) {
    if (!isNonEmptyString(description)) {
      continue;
    }
    const sanitized = sanitizeSlackStatusText(
      description,
      SLACK_STATUS_TEXT_MAX,
    );
    if (sanitized) {
      return sanitized;
    }
  }
  return null;
}
