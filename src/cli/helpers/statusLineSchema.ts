// Status line input field definitions for Letta Code.

export interface StatusLineFieldSpec {
  path: string;
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
  { path: "permission_mode" },
  { path: "network_phase" },
  { path: "terminal_width" },
];

export const STATUSLINE_DERIVED_FIELDS: StatusLineFieldSpec[] = [
  { path: "context_window.used_percentage" },
  { path: "context_window.remaining_percentage" },
  { path: "exceeds_200k_tokens" },
];
