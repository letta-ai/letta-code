import type { NormalizedStatusLineConfig } from "./statusLineConfig";
import {
  getStatusLineFieldsBySupport,
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

export function formatStatusLineConfigSummary(
  config: NormalizedStatusLineConfig | null,
): string {
  if (!config) {
    return "Effective config: (inactive)";
  }

  return `Effective config:\n  - type: ${config.type}\n  - command: ${config.command}\n  - timeout: ${config.timeout}ms\n  - debounceMs: ${config.debounceMs}ms\n  - refreshIntervalMs: ${config.refreshIntervalMs ?? "off"}\n  - padding: ${config.padding}`;
}

export function formatStatusLineHelp(
  effectiveConfig: NormalizedStatusLineConfig | null,
): string {
  const nativeFields = getStatusLineFieldsBySupport("native");
  const derivedFields = getStatusLineFieldsBySupport("derived");
  const unsupportedFields = getStatusLineFieldsBySupport("unsupported");

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
    "CLAUDE-COMPATIBLE CONFIG (supported)",
    '  "statusLine": {',
    '    "type": "command",',
    '    "command": "jq -r \'.model.display_name\'",',
    '    "padding": 2',
    "  }",
    "",
    "LETTA EXTENSIONS",
    "  timeout            command timeout in ms (default 5000, max 30000)",
    "  debounceMs         event debounce in ms (default 300)",
    "  refreshIntervalMs  optional polling interval in ms (off by default)",
    "  interval           legacy alias for refreshIntervalMs",
    "",
    formatStatusLineConfigSummary(effectiveConfig),
    "",
    "FIELD SUPPORT MATRIX",
    "native (fully supported now)",
    formatFieldList(nativeFields),
    "",
    "derived (computed approximation)",
    formatFieldList(derivedFields),
    "",
    "unsupported (currently not native in Letta; null/omitted)",
    formatFieldList(unsupportedFields),
    "",
    "NOTES",
    "  - Status line command receives JSON on stdin and prints text to stdout.",
    "  - Multi-line output is supported.",
    "  - ANSI colors / OSC links are passed through.",
    "  - Status line is disabled when hooks are disabled.",
    "  - Current Letta behavior is preserved: slash input can hide footer rows.",
  ].join("\n");
}
