// Claude-compatible status line schema support matrix for Letta Code.
//
// This intentionally documents which Claude statusline fields are fully native
// or derived/approximate in Letta.

export interface StatusLineFieldSpec {
  path: string;
  note?: string;
}

export const STATUSLINE_NATIVE_FIELDS: StatusLineFieldSpec[] = [
  { path: "cwd" },
  { path: "workspace.current_dir" },
  { path: "workspace.project_dir" },
  { path: "session_id" },
  { path: "version" },
  { path: "model.id" },
  { path: "model.display_name" },
  { path: "agent.name" },
  { path: "cost.total_duration_ms" },
  { path: "cost.total_api_duration_ms" },
  { path: "context_window.context_window_size" },
  { path: "context_window.total_input_tokens" },
  { path: "context_window.total_output_tokens" },
];

export const STATUSLINE_DERIVED_FIELDS: StatusLineFieldSpec[] = [
  {
    path: "context_window.used_percentage",
    note: "Derived from latest context_tokens and model context window size",
  },
  {
    path: "context_window.remaining_percentage",
    note: "Computed as 100 - used_percentage",
  },
  {
    path: "exceeds_200k_tokens",
    note: "Derived from latest context token count threshold",
  },
];
