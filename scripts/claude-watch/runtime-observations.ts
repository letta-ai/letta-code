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
    const metadataUpdate = calls.find(
      (call) =>
        call.name === "TaskUpdate" &&
        record(call.input)?.metadata !== undefined,
    );
    const resultFor = (id: string | null | undefined) =>
      parsed.toolResults.find((candidate) => candidate.toolUseId === id);
    const beforeResult = resultFor(beforeGet?.id);
    const afterResult = resultFor(afterGet?.id);
    const listResult = resultFor(list?.id);
    const metadataResult = resultFor(metadataUpdate?.id);
    const metadata = record(record(metadataUpdate?.input)?.metadata);
    return {
      complete:
        calls.some((call) => call.name === "TaskCreate") &&
        calls.some((call) => call.name === "TaskUpdate") &&
        deletedIndex >= 0 &&
        metadataResult !== undefined &&
        beforeResult !== undefined &&
        afterResult !== undefined &&
        listResult !== undefined,
      assertions: {
        metadata_arbitrary_values_accepted:
          metadata?.count === 3 &&
          Array.isArray(metadata.flags) &&
          metadata.flags[0] === "ready" &&
          record(metadata.details)?.source === "claude-watch" &&
          metadataResult?.isError === false,
        metadata_null_update_accepted:
          metadata?.probe === null && metadataResult?.isError === false,
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

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
