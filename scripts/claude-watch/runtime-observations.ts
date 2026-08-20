export interface ProbeTranscript {
  toolCalls: Array<{ id: string | null; name: string; input: unknown }>;
  toolResults: Array<{
    toolUseId: string | null;
    content: string;
    isError: boolean;
  }>;
}

export function evaluateProbe(
  name: string,
  parsed: ProbeTranscript,
): { complete: boolean; assertions: Record<string, boolean> } {
  if (name === "read-lines-9-10-tab-prefix") {
    const read = parsed.toolCalls.find((call) => call.name === "Read");
    const input = record(read?.input);
    const result = parsed.toolResults.find(
      (candidate) => candidate.toolUseId === read?.id,
    );
    const content = result?.content ?? "";
    return {
      complete:
        input?.offset === 9 && input.limit === 2 && result !== undefined,
      assertions: {
        exact_line_9: /(?:^|\n)9\tline9(?:\n|$)/u.test(content),
        exact_line_10: /(?:^|\n)10\tline10(?:\n|$)/u.test(content),
        no_line_9_padding: !/(?:^|\n)[ \t]+9\tline9(?:\n|$)/u.test(content),
        no_arrow_separator: !content.includes("→"),
        result_not_error: result?.isError === false,
      },
    };
  }
  if (name === "task-metadata-delete-contract") {
    const calls = parsed.toolCalls;
    const deletedIndex = calls.findIndex(
      (call) =>
        call.name === "TaskUpdate" && record(call.input)?.status === "deleted",
    );
    const beforeGet = calls.find(
      (call, index) => call.name === "TaskGet" && index < deletedIndex,
    );
    const afterGet = calls.find(
      (call, index) => call.name === "TaskGet" && index > deletedIndex,
    );
    const list = calls.find(
      (call, index) => call.name === "TaskList" && index > deletedIndex,
    );
    const resultFor = (id: string | null | undefined) =>
      parsed.toolResults.find((candidate) => candidate.toolUseId === id);
    const beforeResult = resultFor(beforeGet?.id);
    const afterResult = resultFor(afterGet?.id);
    const listResult = resultFor(list?.id);
    const metadata = findMetadata(parseJsonResult(beforeResult?.content ?? ""));
    return {
      complete:
        calls.some((call) => call.name === "TaskCreate") &&
        calls.some((call) => call.name === "TaskUpdate") &&
        deletedIndex >= 0 &&
        beforeResult !== undefined &&
        afterResult !== undefined &&
        listResult !== undefined,
      assertions: {
        metadata_arbitrary_values:
          metadata?.count === 3 &&
          Array.isArray(metadata.flags) &&
          metadata.flags[0] === "ready" &&
          record(metadata.details)?.source === "claude-watch",
        metadata_null_deleted:
          metadata?.keep === "yes" && !("probe" in (metadata ?? {})),
        deleted_task_get_errors:
          afterResult?.isError === true ||
          /not[ -]?found|does not exist|deleted/iu.test(
            afterResult?.content ?? "",
          ),
        deleted_task_absent:
          listResult !== undefined && !/probe-task/iu.test(listResult.content),
      },
    };
  }
  return {
    complete: parsed.toolCalls.length > 0 && parsed.toolResults.length > 0,
    assertions: {},
  };
}

function parseJsonResult(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(content.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function findMetadata(value: unknown): Record<string, unknown> | null {
  const object = record(value);
  if (!object) return null;
  const metadata = record(object.metadata);
  if (metadata) return metadata;
  for (const child of Object.values(object)) {
    const found = findMetadata(child);
    if (found) return found;
  }
  return null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
