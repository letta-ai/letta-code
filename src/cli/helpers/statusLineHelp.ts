import type { NormalizedStatusLineConfig } from "./statusLineConfig";
import {
  STATUSLINE_DERIVED_FIELDS,
  STATUSLINE_NATIVE_FIELDS,
  type StatusLineFieldSpec,
} from "./statusLineSchema";

function formatFieldList(fields: StatusLineFieldSpec[]): string {
  if (fields.length === 0) return "  (none)";
  return fields
    .map((field) => {
      if (!field.note) return `  - ${field.path}`;
      return `  - ${field.path} — ${field.note}`;
    })
    .join("\n");
}

function formatConfigSummary(
  config: NormalizedStatusLineConfig | null,
): string {
  if (!config) {
    return "  (inactive)";
  }

  const command = config.command.replace(/\/Users\/[^/]+\//g, "~/");
  return [
    `  type: ${config.type}`,
    `  command: ${command}`,
    `  timeout: ${config.timeout}ms`,
    `  debounceMs: ${config.debounceMs}ms`,
    `  refreshIntervalMs: ${config.refreshIntervalMs ?? "off"}`,
    `  padding: ${config.padding}`,
  ].join("\n");
}

export function formatStatusLineHelp(
  effectiveConfig: NormalizedStatusLineConfig | null,
): string {
  return [
    "/statusline help",
    "",
    "Configure a custom CLI status line command (Claude-compatible superset).",
    "",
    "USAGE",
    "  /statusline show",
    "  /statusline set <command> [-l|-p]",
    "  /statusline clear [-l|-p]",
    "  /statusline test",
    "  /statusline enable",
    "  /statusline disable",
    "  /statusline help",
    "",
    "SCOPES",
    "  (default) global   ~/.letta/settings.json",
    "  -p       project   ./.letta/settings.json",
    "  -l       local     ./.letta/settings.local.json",
    "",
    "CONFIGURATION",
    '  "statusLine": {',
    '    "type": "command",',
    '    "command": "~/.letta/statusline-command.sh",',
    '    "padding": 2,',
    '    "timeout": 5000,',
    '    "debounceMs": 300,',
    '    "refreshIntervalMs": 10000',
    "  }",
    "",
    "  type               must be \"command\"",
    "  command            shell command to execute",
    "  padding            left padding in spaces (default 0, max 16)",
    "  timeout            command timeout in ms (default 5000, max 30000)",
    "  debounceMs         event debounce in ms (default 300)",
    "  refreshIntervalMs  optional polling interval in ms (off by default)",
    "  interval           legacy alias for refreshIntervalMs",
    "",
    "  Effective config:",
    formatConfigSummary(effectiveConfig),
    "",
    "INPUT FIELDS (via JSON stdin)",
    "native",
    formatFieldList(STATUSLINE_NATIVE_FIELDS),
    "",
    "derived",
    formatFieldList(STATUSLINE_DERIVED_FIELDS),
  ].join("\n");
}
