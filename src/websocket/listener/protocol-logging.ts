function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatLogValue(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return "null";
  if (typeof value === "string") {
    return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.length}]`;
  return null;
}

function pushField(
  fields: string[],
  key: string,
  value: unknown,
  label = key,
): void {
  const formatted = formatLogValue(value);
  if (formatted !== null) fields.push(`${label}=${formatted}`);
}

function summarizeInputPayload(payload: unknown): string[] {
  if (!isRecord(payload)) return [];
  const fields: string[] = [];
  pushField(fields, "kind", payload.kind);
  if (payload.kind === "create_message") {
    pushField(fields, "messages", payload.messages);
    pushField(fields, "client_tool_allowlist", payload.client_tool_allowlist);
    if (isRecord(payload.client_toolset)) {
      pushField(fields, "client_toolset.base", payload.client_toolset.base);
      pushField(
        fields,
        "client_toolset.include",
        payload.client_toolset.include,
      );
    }
    pushField(
      fields,
      "external_tool_scope_ids",
      payload.external_tool_scope_ids,
    );
    pushField(
      fields,
      "exclude_interactive_tools",
      payload.exclude_interactive_tools,
    );
  } else if (payload.kind === "approval_response") {
    pushField(fields, "request_id", payload.request_id);
    pushField(fields, "response", payload.response);
    pushField(
      fields,
      "selected_suggestion_ids",
      payload.selected_suggestion_ids,
    );
  }
  return fields;
}

function summarizeRuntimeStartCommand(
  command: Record<string, unknown>,
): string[] {
  const fields: string[] = [];
  pushField(fields, "agent_id", command.agent_id, "agent");
  pushField(fields, "conversation_id", command.conversation_id, "conversation");
  if (isRecord(command.create_agent)) fields.push("create_agent=true");
  if (isRecord(command.create_conversation)) {
    fields.push("create_conversation=true");
  }
  pushField(fields, "cwd", command.cwd);
  pushField(fields, "mode", command.mode);
  pushField(fields, "external_tools", command.external_tools);
  return fields;
}

export function summarizeV2Command(parsed: unknown): string {
  if (!isRecord(parsed) || typeof parsed.type !== "string") return "unknown";
  const fields: string[] = [];
  const runtime = isRecord(parsed.runtime) ? parsed.runtime : null;
  if (runtime) {
    fields.push(
      `runtime=${runtime.agent_id ?? "<unknown>"}/${runtime.conversation_id ?? "<unknown>"}`,
    );
  }
  pushField(fields, "request_id", parsed.request_id);

  if (parsed.type === "input") {
    fields.push(...summarizeInputPayload(parsed.payload));
  } else if (
    parsed.type === "change_device_state" &&
    isRecord(parsed.payload)
  ) {
    pushField(fields, "mode", parsed.payload.mode);
    pushField(fields, "cwd", parsed.payload.cwd);
    pushField(fields, "agent_id", parsed.payload.agent_id);
    pushField(fields, "conversation_id", parsed.payload.conversation_id);
  } else if (parsed.type === "runtime_start") {
    fields.push(...summarizeRuntimeStartCommand(parsed));
  } else if (
    parsed.type === "runtime_external_tools_update" &&
    Array.isArray(parsed.updates)
  ) {
    fields.push(`updates=${parsed.updates.length}`);
    fields.push(
      `runtimes=${parsed.updates.reduce((count, update) => {
        return (
          count +
          (isRecord(update) && Array.isArray(update.runtimes)
            ? update.runtimes.length
            : 0)
        );
      }, 0)}`,
    );
  } else {
    for (const key of [
      "agent_id",
      "conversation_id",
      "task_id",
      "channel_id",
      "account_id",
      "route_id",
      "target_id",
      "pairing_id",
      "path",
      "file_path",
      "ref",
      "encoding",
      "query",
      "glob",
      "is_regex",
      "case_sensitive",
      "whole_word",
      "cwd",
      "mode",
      "run_id",
      "item_id",
      "terminal_id",
      "cols",
      "rows",
      "depth",
      "limit",
      "offset",
      "max_results",
      "context_lines",
      "include_files",
      "model_id",
      "model_handle",
      "toolset",
      "provider_name",
      "auth_method",
      "scope",
      "command_id",
      "args",
      "name",
      "cron",
      "recurring",
      "source",
      "replace_all",
      "expected_replacements",
      "recover_approvals",
      "force_device_status",
    ]) {
      pushField(fields, key, parsed[key]);
    }
  }

  if (parsed.type === "write_file" && typeof parsed.content === "string") {
    fields.push(`content_bytes=${Buffer.byteLength(parsed.content)}`);
  }
  if (
    parsed.type === "write_memory_file" &&
    typeof parsed.content === "string"
  ) {
    fields.push(`content_bytes=${Buffer.byteLength(parsed.content)}`);
  }
  if (parsed.type === "edit_file") {
    if (typeof parsed.old_string === "string") {
      fields.push(`old_bytes=${Buffer.byteLength(parsed.old_string)}`);
    }
    if (typeof parsed.new_string === "string") {
      fields.push(`new_bytes=${Buffer.byteLength(parsed.new_string)}`);
    }
  }
  if (parsed.type === "file_ops") {
    pushField(fields, "cg_entries", parsed.cg_entries);
    pushField(fields, "ops", parsed.ops);
    if (typeof parsed.document_content === "string") {
      fields.push(
        `document_bytes=${Buffer.byteLength(parsed.document_content)}`,
      );
    }
  }
  if (parsed.type === "terminal_input" && typeof parsed.data === "string") {
    fields.push(`data_bytes=${Buffer.byteLength(parsed.data)}`);
  }
  if (parsed.type === "execute_command") {
    pushField(fields, "command_id", parsed.command_id);
    pushField(fields, "args", parsed.args);
  }

  return fields.length > 0
    ? `${parsed.type} command (${fields.join(", ")})`
    : `${parsed.type} command`;
}
