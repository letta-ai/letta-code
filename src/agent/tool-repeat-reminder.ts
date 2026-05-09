const REPEATED_TOOL_CALL_THRESHOLD = 3;

export type RepeatToolCall = {
  toolName: string;
  toolArgs: string;
};

export type ToolRepeatTracker = Map<string, number>;

export function createToolRepeatTracker(): ToolRepeatTracker {
  return new Map();
}

function getRepeatKey(call: RepeatToolCall): string {
  // Exact match: same tool name and the raw argument string as emitted by the model.
  return `${call.toolName}\0${call.toolArgs}`;
}

export function buildRepeatedToolCallReminder(
  tracker: ToolRepeatTracker,
  calls: RepeatToolCall[],
): string | null {
  const repeated: RepeatToolCall[] = [];

  for (const call of calls) {
    const key = getRepeatKey(call);
    const count = (tracker.get(key) ?? 0) + 1;
    tracker.set(key, count);

    if (count === REPEATED_TOOL_CALL_THRESHOLD) {
      repeated.push(call);
    }
  }

  if (repeated.length === 0) return null;

  const toolList = repeated
    .map((call) => `- ${call.toolName}(${call.toolArgs || "{}"})`)
    .join("\n");

  return `<system-reminder>
You have called the same tool with the exact same arguments ${REPEATED_TOOL_CALL_THRESHOLD} times:
${toolList}

This usually indicates the current approach is stuck. Try a different approach instead of repeating the same exact tool call again.
</system-reminder>`;
}
