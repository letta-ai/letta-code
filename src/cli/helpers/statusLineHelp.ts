import {
  STATUSLINE_DERIVED_FIELDS,
  STATUSLINE_NATIVE_FIELDS,
} from "./statusLineSchema";

export function formatStatusLineHelp(): string {
  const allFields = [...STATUSLINE_NATIVE_FIELDS, ...STATUSLINE_DERIVED_FIELDS];
  const fieldList = allFields.map((f) => `  - ${f.path}`).join("\n");

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
    '  type               must be "command"',
    "  command            shell command to execute",
    "  padding            left padding in spaces (default 0, max 16)",
    "  timeout            command timeout in ms (default 5000, max 30000)",
    "  debounceMs         event debounce in ms (default 300)",
    "  refreshIntervalMs  optional polling interval in ms (off by default)",
    "",
    "INPUT (via JSON stdin)",
    fieldList,
  ].join("\n");
}
