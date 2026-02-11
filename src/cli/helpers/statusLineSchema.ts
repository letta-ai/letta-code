// Claude-compatible status line schema support matrix for Letta Code.
//
// This intentionally documents which Claude statusline fields are fully native,
// derived/approximate, or currently unsupported in Letta.

export type StatusLineFieldSupport = "native" | "derived" | "unsupported";

export interface StatusLineFieldSpec {
  path: string;
  support: StatusLineFieldSupport;
  note?: string;
}

export const STATUSLINE_FIELD_SUPPORT: StatusLineFieldSpec[] = [
  // Native fields
  { path: "cwd", support: "native" },
  { path: "workspace.current_dir", support: "native" },
  { path: "workspace.project_dir", support: "native" },
  { path: "session_id", support: "native" },
  { path: "version", support: "native" },
  { path: "model.id", support: "native" },
  { path: "model.display_name", support: "native" },
  { path: "agent.name", support: "native" },
  { path: "cost.total_duration_ms", support: "native" },
  { path: "cost.total_api_duration_ms", support: "native" },
  { path: "context_window.context_window_size", support: "native" },
  { path: "context_window.total_input_tokens", support: "native" },
  { path: "context_window.total_output_tokens", support: "native" },

  // Derived/approximate fields
  {
    path: "context_window.used_percentage",
    support: "derived",
    note: "Derived from latest context_tokens and model context window size",
  },
  {
    path: "context_window.remaining_percentage",
    support: "derived",
    note: "Computed as 100 - used_percentage",
  },
  {
    path: "exceeds_200k_tokens",
    support: "derived",
    note: "Derived from latest context token count threshold",
  },

  // Unsupported fields (explicitly tracked for /statusline help)
  {
    path: "transcript_path",
    support: "unsupported",
    note: "Transcript path is not currently exposed in Letta statusline payload",
  },
  {
    path: "output_style.name",
    support: "unsupported",
    note: "Output style is not currently exposed",
  },
  {
    path: "vim.mode",
    support: "unsupported",
    note: "Vim mode is not currently available in Letta Code",
  },
  {
    path: "cost.total_cost_usd",
    support: "unsupported",
    note: "Session USD cost is not currently tracked in this payload",
  },
  {
    path: "cost.total_lines_added",
    support: "unsupported",
    note: "Line-change counters are not currently tracked in this payload",
  },
  {
    path: "cost.total_lines_removed",
    support: "unsupported",
    note: "Line-change counters are not currently tracked in this payload",
  },
  {
    path: "context_window.current_usage.input_tokens",
    support: "unsupported",
    note: "Detailed current_usage token breakdown is not currently available",
  },
  {
    path: "context_window.current_usage.output_tokens",
    support: "unsupported",
    note: "Detailed current_usage token breakdown is not currently available",
  },
  {
    path: "context_window.current_usage.cache_creation_input_tokens",
    support: "unsupported",
    note: "Detailed current_usage token breakdown is not currently available",
  },
  {
    path: "context_window.current_usage.cache_read_input_tokens",
    support: "unsupported",
    note: "Detailed current_usage token breakdown is not currently available",
  },
];

export function getStatusLineFieldsBySupport(
  support: StatusLineFieldSupport,
): StatusLineFieldSpec[] {
  return STATUSLINE_FIELD_SUPPORT.filter((field) => field.support === support);
}
