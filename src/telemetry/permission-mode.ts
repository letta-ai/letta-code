export interface PermissionModeChangedData {
  agent_id?: string | null;
  conversation_id?: string | null;
  prev_mode?: string | null;
  new_mode: string;
  source: "runtime_start" | "user_toggle";
  mode_is_default: boolean;
}
